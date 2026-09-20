#!/usr/bin/env python3
"""Stage/install this existing plugin only while Zotero is fully closed; no GUI."""
import argparse
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
import zipfile

PLUGIN_ID = 'style-custom@sungjaeyoon.dev'


def zotero_running():
    result = subprocess.run(['pgrep', '-f', '/Applications/Zotero.app/Contents/MacOS/zotero'], capture_output=True)
    if result.returncode not in (0, 1):
        raise RuntimeError('Cannot determine whether Zotero is closed')
    return result.returncode == 0


def version(value):
    if not re.fullmatch(r'\d+\.\d+\.\d+', value):
        raise ValueError('Unsupported version format')
    return tuple(map(int, value.split('.')))


def manifest(path):
    return manifest_bytes(Path(path).read_bytes())


def manifest_bytes(blob):
    with zipfile.ZipFile(io.BytesIO(blob)) as archive:
        if archive.testzip() is not None:
            raise ValueError('Corrupt XPI')
        data = json.loads(archive.read('manifest.json'))
    if data['applications']['zotero']['id'] != PLUGIN_ID:
        raise ValueError('Unexpected plugin identity')
    version(data['version'])
    return data


def prepare_bytes(path, data, mode=0o600):
    fd, temporary = tempfile.mkstemp(prefix='.' + path.name + '-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, mode)
        return Path(temporary)
    except Exception:
        if os.path.exists(temporary):
            os.unlink(temporary)
        raise


def atomic_bytes(path, data, mode=0o600):
    temporary = prepare_bytes(path, data, mode)
    try:
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def snapshot(path, optional=False):
    if optional and not path.exists() and not path.is_symlink():
        return {'data': None, 'identity': None, 'mode': 0o600}
    before = path.lstat()
    if path.is_symlink() or not path.is_file():
        raise ValueError('Profile files must be regular files: ' + path.name)
    data = path.read_bytes()
    after = path.lstat()
    identity = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_mode)
    if identity(before) != identity(after):
        raise ValueError('Profile file changed while reading: ' + path.name)
    return {'data': data, 'identity': identity(after), 'mode': after.st_mode & 0o777}


def unchanged(path, expected):
    try:
        current = snapshot(path, optional=True)
        return current['identity'] == expected['identity'] and current['data'] == expected['data']
    except (OSError, ValueError):
        return False


class InterruptedUpdate(Exception):
    def __init__(self, result):
        self.result = result


def rollback_owned(originals, written, running):
    restored, skipped = [], []
    for path, owned in reversed(list(written.items())):
        if running() or not unchanged(path, owned):
            skipped.append(path.name)
            continue
        original = originals[path]
        temporary = None
        try:
            if original['data'] is not None:
                temporary = prepare_bytes(path, original['data'], original['mode'])
                if snapshot(temporary)['data'] != original['data']:
                    skipped.append(path.name)
                    continue
            # A concurrent writer may have acted while rollback bytes were prepared.
            if running() or not unchanged(path, owned):
                skipped.append(path.name)
                continue
            if temporary is None:
                path.unlink(missing_ok=True)
            else:
                os.replace(temporary, path)
            restored.append(path.name)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
    return {'restored': restored, 'skippedConcurrentOrRunning': skipped}


def install_once(profile, source, expected_hash, running=zotero_running, stop_requested=lambda: None,
                 expected_installed_hash=None, expected_installed_version=None):
    stop = stop_requested()
    if stop:
        return {'state': stop}
    profile, source = Path(profile).resolve(), Path(source).resolve()
    data = source.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    if digest != expected_hash:
        raise ValueError('Artifact hash changed after verification')
    new = manifest_bytes(data)
    destination = profile / 'extensions' / (PLUGIN_ID + '.xpi')
    prefs = profile / 'prefs.js'
    registry = profile / 'extensions.json'
    startup = profile / 'addonStartup.json.lz4'
    initial = snapshot(destination)
    if expected_installed_hash is not None and not re.fullmatch(r'[0-9a-fA-F]{64}', expected_installed_hash):
        raise ValueError('Invalid expected installed SHA-256')
    baseline_hash = (expected_installed_hash or hashlib.sha256(initial['data']).hexdigest()).lower()
    if expected_installed_version is not None:
        version(expected_installed_version)

    def check_destination(current):
        current_manifest = manifest_bytes(current['data'])
        current_hash = hashlib.sha256(current['data']).hexdigest()
        if current['data'] == data:
            registered = json.loads(snapshot(registry)['data'])
            if not any(a.get('id') == PLUGIN_ID for a in registered.get('addons', [])):
                raise ValueError('Plugin is not already registered in this profile')
            return {'state': 'installed', 'version': new['version'], 'sha256': digest, 'alreadyPresent': True, 'activation': 'not-verified'}
        if version(current_manifest['version']) > version(new['version']):
            return {'state': 'superseded', 'installedVersion': current_manifest['version'], 'requestedVersion': new['version']}
        if current_hash != baseline_hash or expected_installed_version is not None and current_manifest['version'] != expected_installed_version:
            return {'state': 'destination-changed', 'installedVersion': current_manifest['version'], 'installedSha256': current_hash,
                    'expectedInstalledSha256': baseline_hash, 'expectedInstalledVersion': expected_installed_version}
        if current_manifest['version'] == new['version']:
            return {'state': 'version-conflict', 'installedVersion': current_manifest['version'], 'installedSha256': current_hash,
                    'requestedSha256': digest}
        return None

    result = check_destination(initial)
    if result:
        return result
    if running():
        return {'state': 'waiting-for-zotero-exit', 'currentVersion': manifest_bytes(initial['data'])['version'], 'version': new['version'], 'sha256': digest}
    lock_path = profile / '.style-custom-update.lock'
    if lock_path.is_symlink():
        raise ValueError('Updater lock must not be a symlink')
    with lock_path.open('a+b') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return {'state': 'another-updater-running'}
        stop = stop_requested()
        if stop:
            return {'state': stop}
        if running():
            return {'state': 'waiting-for-zotero-exit', 'version': new['version']}
        # Another updater may have committed since the first version check.
        # Re-read under our shared lock before backing up or replacing anything.
        originals = {destination: snapshot(destination), prefs: snapshot(prefs), registry: snapshot(registry), startup: snapshot(startup, optional=True)}
        result = check_destination(originals[destination])
        if result:
            return result
        if not any(a.get('id') == PLUGIN_ID for a in json.loads(originals[registry]['data']).get('addons', [])):
            return {'state': 'profile-changed', 'files': [registry.name]}
        text = originals[prefs]['data'].decode('utf8')
        clean = re.sub(r'^user_pref\("extensions\.(?:lastAppVersion|lastAppBuildId|lastPlatformVersion)",[^\n]*\);\r?\n?', '', text, flags=re.M).encode('utf8')
        backup_parent = profile / 'style-custom-update-backups'
        if backup_parent.is_symlink():
            raise ValueError('Backup directory must not be a symlink')
        backup_parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(backup_parent, 0o700)
        backup = Path(tempfile.mkdtemp(prefix=time.strftime('%Y%m%d-%H%M%S') + '-' + str(os.getpid()) + '-', dir=backup_parent))
        for path, saved in originals.items():
            if saved['data'] is not None:
                atomic_bytes(backup / ('plugin.xpi' if path == destination else path.name), saved['data'])
        expected = dict(originals)
        written, prepared = {}, {}

        def guard():
            if running():
                return {'state': 'waiting-for-zotero-exit', 'version': new['version']}
            stop = stop_requested()
            if stop:
                return {'state': stop}
            changed = [path for path, value in expected.items() if not unchanged(path, value)]
            if changed:
                return {'state': 'destination-changed' if destination in changed else 'profile-changed', 'files': [path.name for path in changed]}
            changed_prepared = [path.name for path, (temporary, value) in prepared.items()
                                if path not in written and not unchanged(temporary, value)]
            if changed_prepared:
                return {'state': 'prepared-artifact-changed', 'files': changed_prepared}
            return None

        try:
            for path, replacement in [(destination, data), (prefs, clean)]:
                temporary = prepare_bytes(path, replacement, originals[path]['mode'])
                prepared[path] = (temporary, None)
                prepared_snapshot = snapshot(temporary)
                if prepared_snapshot['data'] != replacement:
                    raise ValueError('Prepared replacement changed before verification: ' + path.name)
                prepared[path] = (temporary, prepared_snapshot)
            for path in [destination, prefs, startup]:
                blocked = guard()
                if blocked:
                    raise InterruptedUpdate(blocked)
                if path == startup:
                    if originals[startup]['data'] is None:
                        continue
                    startup.unlink()
                    expected[startup] = written[startup] = {'data': None, 'identity': None, 'mode': originals[startup]['mode']}
                else:
                    temporary, installed = prepared[path]
                    os.replace(temporary, path)
                    expected[path] = written[path] = installed
            blocked = guard()
            if blocked:
                raise InterruptedUpdate(blocked)
        except InterruptedUpdate as error:
            result = {**error.result, 'backup': str(backup)}
            if written:
                result['rollback'] = rollback_owned(originals, written, running)
                if result['rollback']['skippedConcurrentOrRunning']:
                    result['state'] = 'update-interrupted'
            return result
        except Exception:
            rollback_owned(originals, written, running)
            raise
        finally:
            for temporary, _ in prepared.values():
                temporary.unlink(missing_ok=True)
        return {'state': 'installed', 'version': new['version'], 'sha256': digest, 'backup': str(backup), 'activation': 'next-normal-start; not-verified'}


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument('--profile', required=True)
    parser.add_argument('--artifact', required=True)
    parser.add_argument('--sha256', required=True)
    parser.add_argument('--expected-installed-sha256', required=True)
    parser.add_argument('--expected-installed-version')
    parser.add_argument('--status', required=True)
    parser.add_argument('--wait', action='store_true')
    parser.add_argument('--timeout', type=int, default=86400)
    parser.add_argument('--cancel-file')
    args = parser.parse_args()
    status = Path(args.status).resolve()
    status.parent.mkdir(parents=True, exist_ok=True)
    deadline = time.monotonic() + max(1, args.timeout)
    waiting_for = 'update-attempt'
    def stop_requested():
        if args.cancel_file and Path(args.cancel_file).exists():
            return 'cancelled'
        if args.wait and time.monotonic() >= deadline:
            return 'timed-out'
        return None
    while True:
        try:
            stop = stop_requested()
            result = ({'state': stop} if stop
                      else install_once(args.profile, args.artifact, args.sha256, stop_requested=stop_requested,
                                        expected_installed_hash=args.expected_installed_sha256,
                                        expected_installed_version=args.expected_installed_version))
        except Exception as error:
            result = {'state': 'error', 'error': str(error)}
        if result['state'] in ('waiting-for-zotero-exit', 'another-updater-running'):
            waiting_for = result['state']
            stop = stop_requested()
            if stop:
                result = {**result, 'state': stop}
        if result['state'] == 'timed-out':
            result['waitingFor'] = waiting_for
        result['watching'] = bool(args.wait and result['state'] in ('waiting-for-zotero-exit', 'another-updater-running'))
        result['pid'] = os.getpid()
        result['checkedAt'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
        atomic_bytes(status, (json.dumps(result, indent=2) + '\n').encode())
        if result['state'] in ('installed', 'superseded', 'cancelled', 'timed-out', 'destination-changed', 'version-conflict', 'profile-changed', 'prepared-artifact-changed', 'update-interrupted'):
            print(json.dumps(result), flush=True)
            return
        if result['state'] == 'error':
            raise SystemExit(1)
        if not args.wait:
            print(json.dumps(result), flush=True)
            return
        time.sleep(2)


if __name__ == '__main__':
    main()
