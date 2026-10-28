#!/usr/bin/env bash
set -euo pipefail
project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_root"

valid_node() { ( "$1" -e 'const [major,minor]=process.versions.node.split(".").map(Number);process.exit(major>22||(major===22&&minor>=12)?0:1)' >/dev/null 2>&1; node_status=$?; exit "$node_status" ) >/dev/null 2>&1; }
# Keep selection local to this build, including when an outdated system Node is broken.
if ! command -v node >/dev/null 2>&1 || ! valid_node "$(command -v node)"; then
  for candidate in "$HOME"/.nvm/versions/node/*/bin/node; do
    if [[ -x "$candidate" ]] && valid_node "$candidate"; then
      export PATH="$(dirname -- "$candidate"):$PATH"
      break
    fi
  done
fi
if ! command -v node >/dev/null 2>&1 || ! valid_node "$(command -v node)"; then
  printf '%s\n' 'Android 빌드에는 Node.js 22.12 이상이 필요합니다. Node.js를 설치하고 PATH를 설정하세요.' >&2
  exit 1
fi

if [[ "${1:-}" == --print-node ]]; then command -v node; exit 0; fi

if [[ -z "${ANDROID_HOME:-}" ]]; then
  if [[ -n "${ANDROID_SDK_ROOT:-}" ]]; then
    export ANDROID_HOME="$ANDROID_SDK_ROOT"
  else
    for candidate in "$HOME/Library/Android/sdk" "$HOME/Android/Sdk"; do
      if [[ -d "$candidate/platforms" ]]; then export ANDROID_HOME="$candidate"; break; fi
    done
  fi
fi
# AGP needs JDK 17: a newer or GraalVM JAVA_HOME (e.g. sdkman 21-graalce) breaks jlink on android-36.
# ANDROID_JAVA_HOME forces a specific JDK.
jdk_major() { "$1/bin/java" -XshowSettings:properties -version 2>&1 | sed -n 's/^ *java.specification.version = //p'; }
if [[ -n "${ANDROID_JAVA_HOME:-}" ]]; then
  export JAVA_HOME="$ANDROID_JAVA_HOME"
elif [[ -z "${JAVA_HOME:-}" || ! -x "$JAVA_HOME/bin/java" || "$(jdk_major "$JAVA_HOME")" != 17 ]]; then
  android_jdk=""
  for candidate in \
    "$( [[ -x /usr/libexec/java_home ]] && /usr/libexec/java_home -v 17 2>/dev/null || true)" \
    "$HOME"/.sdkman/candidates/java/17* \
    /usr/lib/jvm/*17* \
    "/Applications/Android Studio.app/Contents/jbr/Contents/Home" \
    "$HOME/.local/share/JetBrains/Toolbox/apps/android-studio/jbr"; do
    if [[ -n "$candidate" && -x "$candidate/bin/java" && "$(jdk_major "$candidate")" == 17 ]]; then android_jdk="$candidate"; break; fi
  done
  if [[ -n "$android_jdk" ]]; then
    [[ -n "${JAVA_HOME:-}" ]] && printf 'JAVA_HOME(%s)은 JDK 17이 아니어서 Android 빌드에 %s 를 씁니다.\n' "$JAVA_HOME" "$android_jdk" >&2
    export JAVA_HOME="$android_jdk"
  elif [[ -n "${JAVA_HOME:-}" ]]; then
    printf '%s\n' "경고: JDK 17을 찾지 못해 JAVA_HOME($JAVA_HOME)으로 빌드합니다. 실패하면 JDK 17을 설치하거나 ANDROID_JAVA_HOME 을 지정하세요." >&2
  fi
fi

marker=node_modules/.brightterm-android-deps
if [[ ! -f "$marker" || package.json -nt "$marker" || package-lock.json -nt "$marker" || ! -f node_modules/@xterm/xterm/lib/xterm.js ]]; then
  "${NPM:-npm}" ci --ignore-scripts --no-audit --no-fund
  touch "$marker"
fi
if [[ "${1:-}" != --deps-only ]]; then
  exec android/gradlew -p android :app:assembleDebug \
    "-PbrighttermGitRemote=${ANDROID_GIT_REMOTE:-}" \
    "-PbrighttermGitUsername=${ANDROID_GIT_USERNAME:-git}"
fi
