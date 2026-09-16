#!/usr/bin/env python3
"""Stage/install this existing plugin only while Zotero is fully closed; no GUI."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
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
    with zipfile.ZipFile(path) as archive:
        if archive.testzip() is not None:
            raise ValueError('Corrupt XPI')
        data = json.loads(archive.read('manifest.json'))
    if data['applications']['zotero']['id'] != PLUGIN_ID:
        raise ValueError('Unexpected plugin identity')
    version(data['version'])
    return data


def atomic_bytes(path, data, mode=0o600):
    fd, temporary = tempfile.mkstemp(prefix='.' + path.name + '-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def install_once(profile, source, expected_hash, running=zotero_running, stop_requested=lambda: None):
    stop = stop_requested()
    if stop:
        return {'state': stop}
    profile, source = Path(profile).resolve(), Path(source).resolve()
    data = source.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    if digest != expected_hash:
        raise ValueError('Artifact hash changed after verification')
    new = manifest(source)
    destination = profile / 'extensions' / (PLUGIN_ID + '.xpi')
    prefs = profile / 'prefs.js'
    if not destination.is_file() or destination.is_symlink() or not prefs.is_file() or prefs.is_symlink():
        raise ValueError('Existing regular plugin and preferences files are required')
    registered = json.loads((profile / 'extensions.json').read_text())
    if not any(a.get('id') == PLUGIN_ID for a in registered.get('addons', [])):
        raise ValueError('Plugin is not already registered in this profile')
    old = manifest(destination)
    if version(old['version']) > version(new['version']):
        return {'state': 'superseded', 'installedVersion': old['version'], 'requestedVersion': new['version']}
    if destination.read_bytes() == data:
        return {'state': 'installed', 'version': new['version'], 'sha256': digest, 'alreadyPresent': True, 'activation': 'not-verified'}
    if running():
        return {'state': 'waiting-for-zotero-exit', 'currentVersion': old['version'], 'version': new['version'], 'sha256': digest}
    with (profile / '.style-custom-update.lock').open('a+b') as lock:
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
        old = manifest(destination)
        if version(old['version']) > version(new['version']):
            return {'state': 'superseded', 'installedVersion': old['version'], 'requestedVersion': new['version']}
        if destination.read_bytes() == data:
            return {'state': 'installed', 'version': new['version'], 'sha256': digest, 'alreadyPresent': True, 'activation': 'not-verified'}
        old_bytes, old_prefs = destination.read_bytes(), prefs.read_bytes()
        text = old_prefs.decode('utf8')
        clean = re.sub(r'^user_pref\("extensions\.(?:lastAppVersion|lastAppBuildId|lastPlatformVersion)",[^\n]*\);\r?\n?', '', text, flags=re.M).encode('utf8')
        backup = profile / 'style-custom-update-backups' / (time.strftime('%Y%m%d-%H%M%S') + '-' + str(os.getpid()))
        backup.mkdir(parents=True, mode=0o700)
        os.chmod(backup.parent, 0o700)
        shutil.copy2(destination, backup / 'plugin.xpi')
        shutil.copy2(prefs, backup / 'prefs.js')
        startup = profile / 'addonStartup.json.lz4'
        startup_bytes = startup.read_bytes() if startup.exists() else None
        if startup_bytes is not None:
            atomic_bytes(backup / startup.name, startup_bytes)
        if running():
            return {'state': 'waiting-for-zotero-exit', 'version': new['version']}
        stop = stop_requested()
        if stop:
            return {'state': stop}
        try:
            atomic_bytes(destination, data, destination.stat().st_mode & 0o777)
            atomic_bytes(prefs, clean, prefs.stat().st_mode & 0o777)
            if startup.exists():
                startup.unlink()
        except Exception:
            if not running():
                atomic_bytes(destination, old_bytes)
                atomic_bytes(prefs, old_prefs)
                if startup_bytes is not None:
                    atomic_bytes(startup, startup_bytes)
            raise
        return {'state': 'installed', 'version': new['version'], 'sha256': digest, 'backup': str(backup), 'activation': 'next-normal-start; not-verified'}


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument('--profile', required=True)
    parser.add_argument('--artifact', required=True)
    parser.add_argument('--sha256', required=True)
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
                      else install_once(args.profile, args.artifact, args.sha256, stop_requested=stop_requested))
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
        if result['state'] in ('installed', 'superseded', 'cancelled', 'timed-out'):
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
