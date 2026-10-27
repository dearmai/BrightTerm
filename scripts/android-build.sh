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
if [[ -z "${JAVA_HOME:-}" && -x /usr/libexec/java_home ]]; then
  android_jdk="$(/usr/libexec/java_home -v 17 2>/dev/null || true)"
  if [[ -n "$android_jdk" ]]; then export JAVA_HOME="$android_jdk"; fi
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
