#!/bin/zsh
set -euo pipefail
cd "$(dirname "$0")/../ios"
xcodegen generate
xcodebuild -project Nivra.xcodeproj -scheme Nivra -configuration Debug -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' -derivedDataPath ../build/ios CODE_SIGNING_ALLOWED=NO build
mkdir -p ../artifacts
 ditto -c -k --sequesterRsrc --keepParent ../build/ios/Build/Products/Debug-iphonesimulator/Nivra.app ../artifacts/Nivra-iOS-Simulator.zip
