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
        original = i.os.replace
        def fail_prefs(source, destination):
            if Path(destination) == self.profile / 'prefs.js' and Path(source).read_bytes() != self.prefs:
                raise OSError('injected failure')
            return original(source, destination)
        old = self.dest.read_bytes()
        with patch.object(i.os, 'replace', side_effect=fail_prefs):
            with self.assertRaises(OSError):
                i.install_once(self.profile, self.source, self.digest, lambda: False)
        self.assertEqual(self.dest.read_bytes(), old)
        self.assertEqual((self.profile / 'prefs.js').read_bytes(), self.prefs)

    def test_cancel_file_stops_watcher_without_installing(self):
        cancellation = self.root / 'cancel'
        cancellation.write_text('cancel')
        status = self.root / 'status.json'
        args = ['installer', '--profile', str(self.profile), '--artifact', str(self.source), '--sha256', self.digest,
                '--expected-installed-sha256', hashlib.sha256(self.dest.read_bytes()).hexdigest(),
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
                '--expected-installed-sha256', hashlib.sha256(self.dest.read_bytes()).hexdigest(),
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
                '--expected-installed-sha256', hashlib.sha256(self.dest.read_bytes()).hexdigest(),
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
                '--expected-installed-sha256', hashlib.sha256(self.dest.read_bytes()).hexdigest(),
                '--status', str(status), '--cancel-file', str(cancellation)]
        original = i.atomic_bytes
        def cancel_after_backup(destination, data, mode=0o600):
            result = original(destination, data, mode)
            cancellation.write_text('cancel')
            return result
        before = self.dest.read_bytes()
        with patch('sys.argv', args), patch.object(i, 'atomic_bytes', side_effect=cancel_after_backup), \
             patch.object(i.subprocess, 'run') as pgrep, contextlib.redirect_stdout(io.StringIO()):
            pgrep.return_value.returncode = 1
            i.main()
        self.assertEqual(json.loads(status.read_text())['state'], 'cancelled')
        self.assertEqual(self.dest.read_bytes(), before)
        self.assertEqual((self.profile / 'prefs.js').read_bytes(), self.prefs)
        self.assertEqual((self.profile / 'addonStartup.json.lz4').read_bytes(), b'cache')

    def test_same_version_different_content_is_not_overwritten(self):
        xpi(self.dest, '0.5.0')
        with zipfile.ZipFile(self.dest, 'a') as archive:
            archive.comment = b'external update with the same version'
        before = self.dest.read_bytes()
        result = i.install_once(self.profile, self.source, self.digest, lambda: False,
                                expected_installed_hash=hashlib.sha256(before).hexdigest())
        self.assertEqual(result['state'], 'version-conflict')
        self.assertEqual(self.dest.read_bytes(), before)
        self.assertFalse((self.profile / 'style-custom-update-backups').exists())

    def test_expected_destination_digest_and_version_fail_closed(self):
        before = self.dest.read_bytes()
        for options in [{'expected_installed_hash': '0' * 64}, {'expected_installed_version': '0.4.0'}]:
            with self.subTest(options=options):
                result = i.install_once(self.profile, self.source, self.digest, lambda: False, **options)
                self.assertEqual(result['state'], 'destination-changed')
                self.assertEqual(self.dest.read_bytes(), before)
        with self.assertRaises(ValueError):
            i.install_once(self.profile, self.source, self.digest, lambda: False, expected_installed_hash='invalid')

    def test_exact_already_installed_artifact_is_idempotent_with_original_baseline(self):
        baseline = hashlib.sha256(self.dest.read_bytes()).hexdigest()
        self.dest.write_bytes(self.source.read_bytes())
        result = i.install_once(self.profile, self.source, self.digest, lambda: True,
                                expected_installed_hash=baseline, expected_installed_version='0.4.1')
        self.assertEqual(result['state'], 'installed')
        self.assertTrue(result['alreadyPresent'])
        self.assertEqual(result['activation'], 'not-verified')
        self.assertEqual((self.profile / 'prefs.js').read_bytes(), self.prefs)

    def test_source_swap_after_verified_read_cannot_change_manifest_or_committed_bytes(self):
        approved = self.source.read_bytes()
        real_read = Path.read_bytes
        reads = []
        def replace_after_read(path):
            data = real_read(path)
            if path == self.source:
                reads.append(path)
                xpi(self.source, '9.0.0')
            return data
        with patch.object(Path, 'read_bytes', replace_after_read):
            result = i.install_once(self.profile, self.source, self.digest, lambda: False)
        self.assertEqual(len(reads), 1)
        self.assertEqual(result['version'], '0.5.0')
        self.assertEqual(self.dest.read_bytes(), approved)
        self.assertEqual(i.manifest(self.dest)['version'], '0.5.0')
        self.assertEqual(i.manifest(self.source)['version'], '9.0.0')

    def test_source_swap_cannot_disguise_a_downgrade_as_a_newer_version(self):
        xpi(self.dest, '0.6.0')
        before = self.dest.read_bytes()
        real_read = Path.read_bytes
        def replace_after_read(path):
            data = real_read(path)
            if path == self.source:
                xpi(self.source, '9.0.0')
            return data
        with patch.object(Path, 'read_bytes', replace_after_read):
            result = i.install_once(self.profile, self.source, self.digest, lambda: False)
        self.assertEqual(result['state'], 'superseded')
        self.assertEqual(result['requestedVersion'], '0.5.0')
        self.assertEqual(self.dest.read_bytes(), before)

    def test_same_version_destination_drift_before_lock_is_rejected(self):
        baseline = hashlib.sha256(self.dest.read_bytes()).hexdigest()
        original = i.fcntl.flock
        def change_then_lock(stream, operation):
            with zipfile.ZipFile(self.dest, 'a') as archive:
                archive.comment = b'concurrent edit'
            return original(stream, operation)
        with patch.object(i.fcntl, 'flock', side_effect=change_then_lock):
            result = i.install_once(self.profile, self.source, self.digest, lambda: False,
                                    expected_installed_hash=baseline)
        self.assertEqual(result['state'], 'destination-changed')
        with zipfile.ZipFile(self.dest) as archive:
            self.assertEqual(archive.comment, b'concurrent edit')

    def test_destination_drift_while_replacement_bytes_are_prepared_is_rejected(self):
        original = i.prepare_bytes
        changed = []
        def prepare_then_change(path, data, mode=0o600):
            temporary = original(path, data, mode)
            if path == self.profile / 'prefs.js' and not changed:
                with zipfile.ZipFile(self.dest, 'a') as archive:
                    archive.comment = b'external prepared update'
                changed.append(self.dest.read_bytes())
            return temporary
        with patch.object(i, 'prepare_bytes', side_effect=prepare_then_change):
            result = i.install_once(self.profile, self.source, self.digest, lambda: False)
        self.assertEqual(result['state'], 'destination-changed')
        self.assertEqual(self.dest.read_bytes(), changed[0])
        self.assertEqual((self.profile / 'prefs.js').read_bytes(), self.prefs)

    def test_shared_metadata_changes_during_preparation_are_preserved(self):
        for name in ['prefs.js', 'extensions.json', 'addonStartup.json.lz4']:
            with self.subTest(name=name):
                target = self.profile / name
                previous = target.read_bytes()
                before = self.dest.read_bytes()
                original = i.prepare_bytes
                def change_metadata(path, data, mode=0o600):
                    temporary = original(path, data, mode)
                    if path == self.dest:
                        target.write_bytes(previous + b'\nexternal change')
                    return temporary
                with patch.object(i, 'prepare_bytes', side_effect=change_metadata):
                    result = i.install_once(self.profile, self.source, self.digest, lambda: False)
                self.assertEqual(result['state'], 'profile-changed')
                self.assertIn(name, result['files'])
                self.assertEqual(target.read_bytes(), previous + b'\nexternal change')
                self.assertEqual(self.dest.read_bytes(), before)
                target.write_bytes(previous)

    def test_new_startup_cache_during_preparation_is_not_removed(self):
        startup = self.profile / 'addonStartup.json.lz4'
        startup.unlink()
        original = i.prepare_bytes
        def create_startup(path, data, mode=0o600):
            temporary = original(path, data, mode)
            if path == self.dest:
                startup.write_bytes(b'external cache')
            return temporary
        with patch.object(i, 'prepare_bytes', side_effect=create_startup):
            result = i.install_once(self.profile, self.source, self.digest, lambda: False)
        self.assertEqual(result['state'], 'profile-changed')
        self.assertEqual(startup.read_bytes(), b'external cache')

    def test_rollback_does_not_replace_concurrent_newer_plugin(self):
        original = i.os.replace
        external = []
        def fail_after_external_update(source, destination):
            if Path(destination) == self.profile / 'prefs.js':
                xpi(self.dest, '0.6.0')
                external.append(self.dest.read_bytes())
                raise OSError('external updater committed during our transaction')
            return original(source, destination)
        with patch.object(i.os, 'replace', side_effect=fail_after_external_update):
            with self.assertRaises(OSError):
                i.install_once(self.profile, self.source, self.digest, lambda: False)
        self.assertEqual(self.dest.read_bytes(), external[0])
        self.assertEqual(i.manifest(self.dest)['version'], '0.6.0')
        self.assertEqual((self.profile / 'prefs.js').read_bytes(), self.prefs)

    def test_rollback_rechecks_ownership_after_preparing_restore_bytes(self):
        replace, prepare = i.os.replace, i.prepare_bytes
        before = self.dest.read_bytes()
        def fail_prefs(source, destination):
            if Path(destination) == self.profile / 'prefs.js':
                raise OSError('injected failure')
            return replace(source, destination)
        def update_during_rollback(path, data, mode=0o600):
            temporary = prepare(path, data, mode)
            if path == self.dest and data == before:
                xpi(self.dest, '0.6.0')
            return temporary
        with patch.object(i.os, 'replace', side_effect=fail_prefs), patch.object(i, 'prepare_bytes', side_effect=update_during_rollback):
            with self.assertRaises(OSError):
                i.install_once(self.profile, self.source, self.digest, lambda: False)
        self.assertEqual(i.manifest(self.dest)['version'], '0.6.0')

    def test_app_start_after_first_commit_prevents_further_writes_and_rollback(self):
        checks = iter([False, False, False, True, True])
        result = i.install_once(self.profile, self.source, self.digest, lambda: next(checks))
        self.assertEqual(result['state'], 'update-interrupted')
        self.assertIn(self.dest.name, result['rollback']['skippedConcurrentOrRunning'])
        self.assertEqual(self.dest.read_bytes(), self.source.read_bytes())
        self.assertEqual((self.profile / 'prefs.js').read_bytes(), self.prefs)
        self.assertEqual((self.profile / 'addonStartup.json.lz4').read_bytes(), b'cache')

    def test_watcher_stops_on_destination_drift_instead_of_rebasing(self):
        status = self.root / 'status.json'
        args = ['installer', '--profile', str(self.profile), '--artifact', str(self.source), '--sha256', self.digest,
                '--expected-installed-sha256', '0' * 64, '--status', str(status), '--wait']
        with patch('sys.argv', args), patch.object(i, 'install_once', return_value={'state': 'destination-changed'}) as install, \
                contextlib.redirect_stdout(io.StringIO()):
            i.main()
        self.assertEqual(install.call_count, 1)
        self.assertFalse(json.loads(status.read_text())['watching'])

    def test_prepared_artifact_tampering_is_detected_before_commit(self):
        original = i.prepare_bytes
        staged = []
        before = self.dest.read_bytes()
        def prepare_then_tamper(path, data, mode=0o600):
            temporary = original(path, data, mode)
            if path == self.dest:
                staged.append(temporary)
            if path == self.profile / 'prefs.js':
                staged[0].write_bytes(b'changed prepared bytes')
            return temporary
        with patch.object(i, 'prepare_bytes', side_effect=prepare_then_tamper):
            result = i.install_once(self.profile, self.source, self.digest, lambda: False)
        self.assertEqual(result['state'], 'prepared-artifact-changed')
        self.assertEqual(self.dest.read_bytes(), before)
        self.assertFalse(staged[0].exists())

    def test_rollback_preserves_new_preferences_written_after_our_commit(self):
        original = i.os.replace
        external = b'user_pref("external.writer", true);\n'
        before = self.dest.read_bytes()
        def change_preferences(source, destination):
            result = original(source, destination)
            if Path(destination) == self.profile / 'prefs.js':
                Path(destination).write_bytes(external)
            return result
        with patch.object(i.os, 'replace', side_effect=change_preferences):
            result = i.install_once(self.profile, self.source, self.digest, lambda: False)
        self.assertEqual(result['state'], 'update-interrupted')
        self.assertIn('prefs.js', result['rollback']['skippedConcurrentOrRunning'])
        self.assertEqual((self.profile / 'prefs.js').read_bytes(), external)
        self.assertEqual(self.dest.read_bytes(), before)

    def test_running_app_metadata_is_not_read_or_rewritten_while_waiting(self):
        original = Path.read_bytes
        protected = {self.profile / name for name in ['prefs.js', 'extensions.json', 'addonStartup.json.lz4']}
        def deny_metadata(path):
            if path in protected:
                raise AssertionError('running profile metadata must not be read')
            return original(path)
        with patch.object(Path, 'read_bytes', deny_metadata):
            result = i.install_once(self.profile, self.source, self.digest, lambda: True)
        self.assertEqual(result['state'], 'waiting-for-zotero-exit')

    def test_matching_bytes_without_existing_registration_are_not_claimed_installed(self):
        self.dest.write_bytes(self.source.read_bytes())
        (self.profile / 'extensions.json').write_text(json.dumps({'addons': []}))
        with self.assertRaisesRegex(ValueError, 'not already registered'):
            i.install_once(self.profile, self.source, self.digest, lambda: True)


if __name__ == '__main__':
    unittest.main()
