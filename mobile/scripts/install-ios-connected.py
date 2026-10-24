#!/usr/bin/env python3
"""Install and launch NIVRA on connected physical iPhones without printing device IDs."""
import argparse
import os
import hashlib
import json
import plistlib
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
APP = ROOT / 'mobile/build/ios-device/Build/Products/Debug-iphoneos/Nivra.app'
BUNDLE = 'work.tanishq.nivra.ios'
STATE = ROOT / 'mobile/build/ios-install-state.json'


def run_json(arguments, target, timeout=30):
    result = subprocess.run(['xcrun', 'devicectl', *arguments, '--json-output', str(target), '--timeout', str(timeout)], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    payload = json.loads(target.read_text()) if target.exists() else {}
    return result.returncode, payload


def messages(value):
    if isinstance(value, dict):
        for key, item in value.items():
            if key in ('NSLocalizedFailureReason', 'NSLocalizedRecoverySuggestion') and isinstance(item, dict):
                text = item.get('string', '')
                if 'locked' in text.lower() or 'unlock' in text.lower():
                    return 'Unlock the phone and keep its screen on, then run this command again.'
                if 'developer mode' in text.lower():
                    return 'Enable Developer Mode on the phone, restart it, and run this command again.'
            found = messages(item)
            if found:
                return found
    if isinstance(value, list):
        for item in value:
            found = messages(item)
            if found:
                return found
    return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--name', help='Install only on the phone with this exact display name.')
    parser.add_argument('--register-missing', action='store_true', help='Allow Xcode automatic provisioning to register connected phones with the existing signing team.')
    args = parser.parse_args()
    if not APP.exists():
        raise SystemExit('Build the signed app first with ./mobile/scripts/build-ios-device.sh')
    profile = plistlib.loads(subprocess.check_output(['security', 'cms', '-D', '-i', str(APP / 'embedded.mobileprovision')], stderr=subprocess.DEVNULL))
    allowed = set(profile.get('ProvisionedDevices', []))
    build_hash = hashlib.sha256((ROOT / 'mobile/artifacts/Nivra-iPhone-Development.ipa').read_bytes()).hexdigest()
    state = json.loads(STATE.read_text()) if STATE.exists() else {}
    with tempfile.TemporaryDirectory(prefix='nivra-install-') as folder:
        temp = Path(folder)
        code, listing = run_json(['list', 'devices'], temp / 'devices.json')
        if code:
            raise SystemExit('Device discovery failed. Open Xcode Devices and Simulators and check the connection.')
        phones = [device for device in listing.get('result', {}).get('devices', [])
                  if device.get('properties', {}).get('hardware', {}).get('reality') == 'physical'
                  and device.get('properties', {}).get('hardware', {}).get('deviceType') == 'iPhone']
        if args.name:
            # Phone names can carry trailing spaces that are invisible in Finder and Xcode.
            phones = [device for device in phones if device.get('properties', {}).get('state', {}).get('name', '').strip() == args.name.strip()]
        if not phones:
            print('No physical iPhone found. Connect it by USB, unlock it, and trust this Mac.')
        for index, phone in enumerate(phones):
            properties = phone.get('properties', {})
            name = properties.get('state', {}).get('name', 'iPhone')
            identity = phone['identifier']
            key = hashlib.sha256(properties.get('hardware', {}).get('udid', identity).encode()).hexdigest()
            prior = state.get(key, {})
            if prior.get('build') == build_hash and prior.get('launched'):
                print(f'{name}: this build is already installed and launch-verified.')
                continue
            code, _ = run_json(['device', 'info', 'details', '--device', identity], temp / f'details-{index}.json', timeout=30)
            if code:
                print(f'{name}: unavailable. Connect, unlock, and trust this Mac.')
                continue
            if properties.get('hardware', {}).get('udid') not in allowed:
                if not args.register_missing:
                    print(f'{name}: not in the signed profile. Run again with --register-missing to let Xcode register and provision this phone.')
                    continue
                print(f'{name}: updating the development profile for this phone.', flush=True)
                target = 'platform=iOS,id=' + properties['hardware']['udid']
                log = ROOT / 'mobile/build/ios-provisioning.log'
                log.parent.mkdir(parents=True, exist_ok=True)
                with log.open('w') as stream:
                    result = subprocess.run(['xcodebuild', '-project', str(ROOT / 'mobile/ios/Nivra.xcodeproj'), '-scheme', 'Nivra', '-configuration', 'Debug', '-destination', target, '-derivedDataPath', str(ROOT / 'mobile/build/ios-device'), 'DEVELOPMENT_TEAM=' + os.environ['NIVRA_APPLE_TEAM'], 'CODE_SIGN_STYLE=Automatic', '-allowProvisioningUpdates', '-allowProvisioningDeviceRegistration', 'build'], stdout=stream, stderr=subprocess.STDOUT)
                    if result.returncode == 0:
                        result = subprocess.run([str(ROOT / 'mobile/scripts/build-ios-device.sh')], stdout=stream, stderr=subprocess.STDOUT)
                if result.returncode:
                    print(f'{name}: provisioning needs attention in Xcode. See mobile/build/ios-provisioning.log locally. Check trust and Developer Mode.')
                    continue
                profile = plistlib.loads(subprocess.check_output(['security', 'cms', '-D', '-i', str(APP / 'embedded.mobileprovision')], stderr=subprocess.DEVNULL))
                allowed = set(profile.get('ProvisionedDevices', []))
                if properties.get('hardware', {}).get('udid') not in allowed:
                    print(f'{name}: Xcode did not include this phone in the updated profile. Open the project in Xcode and check signing.')
                    continue
                new_hash = hashlib.sha256((ROOT / 'mobile/artifacts/Nivra-iPhone-Development.ipa').read_bytes()).hexdigest()
                # A profile-only rebuild does not require reinstalling phones already verified with the same code.
                for completed in state.values():
                    if completed.get('build') == build_hash:
                        completed['build'] = new_hash
                build_hash = new_hash
            code, payload = run_json(['device', 'install', 'app', '--device', identity, str(APP)], temp / f'install-{index}.json', timeout=60)
            if code:
                print(f'{name}: install failed. {messages(payload.get("error", {})) or "Check Developer Mode and trust in Xcode."}')
                continue
            print(f'{name}: NIVRA installed.')
            code, payload = run_json(['device', 'process', 'launch', '--device', identity, BUNDLE], temp / f'launch-{index}.json')
            if code:
                print(f'{name}: {messages(payload.get("error", {})) or "Launch failed. Open NIVRA on the phone."}')
            else:
                pid = payload.get('result', {}).get('process', {}).get('processIdentifier')
                print(f'{name}: NIVRA launched on the physical phone (process {pid}).')
                state[key] = {'name': name, 'build': build_hash, 'installed': True, 'launched': True, 'process': pid}
                STATE.parent.mkdir(parents=True, exist_ok=True)
                STATE.write_text(json.dumps(state, indent=2) + '\n')


if __name__ == '__main__':
    main()
