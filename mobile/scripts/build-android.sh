#!/usr/bin/env bash
set -euo pipefail
project_dir="$(cd "$(dirname "$0")/../android" && pwd)"
tool_cache="${NIVRA_MOBILE_TOOL_CACHE:-$HOME/.cache/nivra-mobile}"
if [[ -z "${JAVA_HOME:-}" ]]; then
  for candidate in "$tool_cache"/java/*/Contents/Home; do
    if [[ -x "$candidate/bin/java" ]]; then export JAVA_HOME="$candidate"; break; fi
  done
fi
export ANDROID_HOME="${ANDROID_HOME:-$tool_cache/android-sdk}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export GRADLE_USER_HOME="${GRADLE_USER_HOME:-$tool_cache/gradle-user-home}"
gradle_bin="${NIVRA_GRADLE_BIN:-$tool_cache/gradle-8.9/bin/gradle}"
if [[ ! -x "${JAVA_HOME:-}/bin/java" || ! -x "$gradle_bin" || ! -d "$ANDROID_HOME/platforms/android-35" ]]; then
  echo 'Android toolchain missing. Install JDK 21, Gradle 8.9 and Android SDK platform 35, then set JAVA_HOME, ANDROID_HOME and NIVRA_GRADLE_BIN.' >&2
  exit 1
fi
"$gradle_bin" -p "$project_dir" --no-daemon verifyPairingUrls lintDebug assembleDebug
printf '\nAPK: %s\n' "$project_dir/app/build/outputs/apk/debug/app-debug.apk"
