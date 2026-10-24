# NIVRA mobile companion source

This folder includes the iOS camera/QR/USB companion and Android WebView companion used during NIVRA development. No signed apps, signing identities, provisioning profiles, device lists or local recordings are included.

The USB iPhone camera transport integrates with the desktop Vision Lab backend. Some hosted camera/wall pairing routes in these companion apps belong to an earlier NIVRA server protocol and are not implemented by the Vision Lab server. Use the browser guard interface for the current desktop workflow.

## iOS

Requires macOS, Xcode, XcodeGen and iOS 17+. Open `ios/Nivra.xcodeproj` or generate it from `ios/project.yml`. For a signed device build, set `NIVRA_APPLE_TEAM` to your own Apple developer team. The existing bundle identifier may also need to be changed for your signing setup.

The project expects a generated `ios/Models/NivraX3D.mlpackage`. The export source is `scripts/export-x3d-coreml.py`, with its loader at repository-root `service/nivra/x3d_candidate.py`. The checkpoint must be downloaded from the pinned source recorded in that loader to `service/models/x3d_rwf2000.pt`; verify its SHA-256 against `CHECKSUM` before use. The export needs Python 3.11, PyTorch/PyTorchVideo, OpenCV, coremltools 9.0 and numpy 1.26.4 in a separate environment. The script checks numerical parity before saving. No claim is made that a fresh mobile build was tested as part of this source packaging.

From the repository root:

```bash
python mobile/scripts/export-x3d-coreml.py --output mobile/ios/Models/NivraX3D.mlpackage
bash mobile/scripts/build-ios.sh
NIVRA_APPLE_TEAM=YOUR_TEAM_ID zsh mobile/scripts/build-ios-device.sh
```

## Android

Requires JDK 21, Android SDK 35 and Gradle 8.9. Run `bash mobile/scripts/build-android.sh`. The script accepts `JAVA_HOME`, `ANDROID_HOME` and `NIVRA_GRADLE_BIN`. Review the trusted host policy before using a different deployment domain.

## Limits

Camera use requires permission. Background capture and native push delivery are not guaranteed. Optional native model analysis is experimental; it is not a deployment accuracy claim. Mobile model/license provenance is in `ios/Models/provenance.json` and the desktop third-party notices.
