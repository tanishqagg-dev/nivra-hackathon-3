#!/bin/zsh
set -euo pipefail
cd "$(dirname "$0")/../ios"
if [[ ! -d Models/NivraX3D.mlpackage ]]; then
  print -u2 'Missing trained phone model. Run mobile/scripts/export-x3d-coreml.py --output mobile/ios/Models/NivraX3D.mlpackage with the documented Core ML environment first.'
  exit 1
fi
xcodegen generate
NIVRA_BUILD_TEAM="${NIVRA_APPLE_TEAM:?Set NIVRA_APPLE_TEAM to your Apple development team}"
xcodebuild -project Nivra.xcodeproj -scheme Nivra -configuration Debug -sdk iphoneos -destination 'generic/platform=iOS' -derivedDataPath ../build/ios-device DEVELOPMENT_TEAM="$NIVRA_BUILD_TEAM" CODE_SIGN_STYLE=Automatic -allowProvisioningUpdates build
mkdir -p ../build/package/Payload ../artifacts
ditto ../build/ios-device/Build/Products/Debug-iphoneos/Nivra.app ../build/package/Payload/Nivra.app
(cd ../build/package && /usr/bin/zip -qr ../../artifacts/Nivra-iPhone-Development.ipa Payload)
