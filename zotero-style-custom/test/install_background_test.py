import contextlib
import io
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import zipfile
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('installer', Path(__file__).resolve().parents[1] / 'scripts/install-background.py')
i = importlib.util.module_from_spec(spec)
spec.loader.exec_module(i)


def xpi(path, v, identifier=i.PLUGIN_ID):
    with zipfile.ZipFile(path, 'w') as z:
        z.writestr('manifest.json', json.dumps({'version': v, 'applications': {'zotero': {'id': identifier}}}))


class Installer(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.profile = self.root / 'profile'
        (self.profile / 'extensions').mkdir(parents=True)
        self.dest = self.profile / 'extensions' / (i.PLUGIN_ID + '.xpi')
        xpi(self.dest, '0.4.1')
        self.source = self.root / 'new.xpi'
        xpi(self.source, '0.5.0')
        self.digest = hashlib.sha256(self.source.read_bytes()).hexdigest()
        (self.profile / 'extensions.json').write_text(json.dumps({'addons': [{'id': i.PLUGIN_ID, 'active': False}, {'id': 'other-plugin'}]}))
        self.prefs = b'user_pref("extensions.lastAppVersion", "9");\nuser_pref("user.setting", "preserve");\n'
        (self.profile / 'prefs.js').write_bytes(self.prefs)
        (self.profile / 'addonStartup.json.lz4').write_bytes(b'cache')

    def tearDown(self):
        self.temp.cleanup()

    def test_running_app_is_never_modified(self):
        old = self.dest.read_bytes()
        r = i.install_once(self.profile, self.source, self.digest, lambda: True)
        self.assertEqual(r['state'], 'waiting-for-zotero-exit')
        self.assertEqual(self.dest.read_bytes(), old)
        self.assertEqual((self.profile / 'prefs.js').read_bytes(), self.prefs)

    def test_closed_update_is_backed_up_and_preserves_other_settings_and_registry(self):
        registry = (self.profile / 'extensions.json').read_bytes()
        old = self.dest.read_bytes()
        r = i.install_once(self.profile, self.source, self.digest, lambda: False)
        self.assertEqual(r['state'], 'installed')
        self.assertEqual(self.dest.read_bytes(), self.source.read_bytes())
        self.assertEqual((Path(r['backup']) / 'plugin.xpi').read_bytes(), old)
        self.assertEqual((Path(r['backup']) / 'prefs.js').read_bytes(), self.prefs)
        self.assertEqual((self.profile / 'prefs.js').read_bytes(), b'user_pref("user.setting", "preserve");\n')
        self.assertEqual((self.profile / 'extensions.json').read_bytes(), registry)
        self.assertFalse((self.profile / 'addonStartup.json.lz4').exists())

    def test_wrong_hash_or_identity_is_rejected_before_writes(self):
        old = self.dest.read_bytes()
        with self.assertRaises(ValueError):
            i.install_once(self.profile, self.source, 'bad', lambda: False)
        xpi(self.source, '0.5.0', 'other')
        with self.assertRaises(ValueError):
            i.install_once(self.profile, self.source, hashlib.sha256(self.source.read_bytes()).hexdigest(), lambda: False)
        self.assertEqual(self.dest.read_bytes(), old)

    def test_newer_installed_version_is_not_downgraded(self):
        xpi(self.dest, '0.6.0')
        self.assertEqual(i.install_once(self.profile, self.source, self.digest, lambda: False)['state'], 'superseded')

    def test_newer_update_committed_before_lock_acquisition_is_not_downgraded(self):
        flock = i.fcntl.flock
        def newer_update_then_lock(stream, operation):
            xpi(self.dest, '0.6.0')
            return flock(stream, operation)
        with patch.object(i.fcntl, 'flock', side_effect=newer_update_then_lock):
            result = i.install_once(self.profile, self.source, self.digest, lambda: False)
        self.assertEqual(result['state'], 'superseded')
        self.assertEqual(i.manifest(self.dest)['version'], '0.6.0')
        self.assertEqual((self.profile / 'prefs.js').read_bytes(), self.prefs)
        self.assertFalse((self.profile / 'style-custom-update-backups').exists())

    def test_app_starting_during_preparation_defers_update(self):
        calls = iter([False, False, True])
        old = self.dest.read_bytes()
        self.assertEqual(i.install_once(self.profile, self.source, self.digest, lambda: next(calls))['state'], 'waiting-for-zotero-exit')
        self.assertEqual(self.dest.read_bytes(), old)

    def test_partial_commit_failure_rolls_back_our_files(self):
        original = i.atomic_bytes
        def fail_prefs(path, data, mode=0o600):
            if path == self.profile / 'prefs.js' and data != self.prefs:
                raise OSError('injected failure')
            return original(path, data, mode)
        old = self.dest.read_bytes()
        with patch.object(i, 'atomic_bytes', side_effect=fail_prefs):
            with self.assertRaises(OSError):
                i.install_once(self.profile, self.source, self.digest, lambda: False)
        self.assertEqual(self.dest.read_bytes(), old)
        self.assertEqual((self.profile / 'prefs.js').read_bytes(), self.prefs)

    def test_cancel_file_stops_watcher_without_installing(self):
        cancellation = self.root / 'cancel'
        cancellation.write_text('cancel')
        status = self.root / 'status.json'
        args = ['installer', '--profile', str(self.profile), '--artifact', str(self.source), '--sha256', self.digest,
                '--status', str(status), '--wait', '--cancel-file', str(cancellation)]
        before = self.dest.read_bytes()
        with patch('sys.argv', args), patch.object(i, 'install_once') as install, contextlib.redirect_stdout(io.StringIO()):
            i.main()
        install.assert_not_called()
        result = json.loads(status.read_text())
        self.assertEqual(result['state'], 'cancelled')
        self.assertFalse(result['watching'])
        self.assertEqual(self.dest.read_bytes(), before)

    def test_expired_wait_does_not_claim_a_watcher_is_still_running(self):
        status = self.root / 'status.json'
        args = ['installer', '--profile', str(self.profile), '--artifact', str(self.source), '--sha256', self.digest,
                '--status', str(status), '--wait', '--timeout', '1']
        with patch('sys.argv', args), patch.object(i, 'install_once', return_value={'state': 'waiting-for-zotero-exit'}), \
             patch.object(i.time, 'monotonic', side_effect=[0, 0, 2]), contextlib.redirect_stdout(io.StringIO()):
            i.main()
        result = json.loads(status.read_text())
        self.assertEqual(result['state'], 'timed-out')
        self.assertFalse(result['watching'])
        self.assertEqual(result['waitingFor'], 'waiting-for-zotero-exit')

    def test_timeout_during_poll_interval_does_not_start_another_install(self):
        status = self.root / 'status.json'
        args = ['installer', '--profile', str(self.profile), '--artifact', str(self.source), '--sha256', self.digest,
                '--status', str(status), '--wait', '--timeout', '1']
        clock = [0]
        def advance(_):
            clock[0] = 2
        with patch('sys.argv', args), patch.object(i, 'install_once', side_effect=[{'state': 'waiting-for-zotero-exit'}, {'state': 'installed'}]) as install, \
             patch.object(i.time, 'monotonic', side_effect=lambda: clock[0]), patch.object(i.time, 'sleep', side_effect=advance), \
             contextlib.redirect_stdout(io.StringIO()):
            i.main()
        self.assertEqual(install.call_count, 1)
        self.assertEqual(json.loads(status.read_text())['state'], 'timed-out')

    def test_cancellation_during_backup_prevents_commit(self):
        cancellation = self.root / 'cancel'
        status = self.root / 'status.json'
        args = ['installer', '--profile', str(self.profile), '--artifact', str(self.source), '--sha256', self.digest,
                '--status', str(status), '--cancel-file', str(cancellation)]
        original = i.shutil.copy2
        def cancel_after_backup(source, destination):
            result = original(source, destination)
            cancellation.write_text('cancel')
            return result
        before = self.dest.read_bytes()
        with patch('sys.argv', args), patch.object(i.shutil, 'copy2', side_effect=cancel_after_backup), \
             patch.object(i.subprocess, 'run') as pgrep, contextlib.redirect_stdout(io.StringIO()):
            pgrep.return_value.returncode = 1
            i.main()
        self.assertEqual(json.loads(status.read_text())['state'], 'cancelled')
        self.assertEqual(self.dest.read_bytes(), before)
        self.assertEqual((self.profile / 'prefs.js').read_bytes(), self.prefs)
        self.assertEqual((self.profile / 'addonStartup.json.lz4').read_bytes(), b'cache')


if __name__ == '__main__':
    unittest.main()
