#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
apk="${ANDROID_APK:-$project_root/android/app/build/outputs/apk/debug/app-debug.apk}"

if [[ -z "${ADB:-}" ]]; then
  if command -v adb >/dev/null 2>&1; then
    ADB="$(command -v adb)"
  else
    sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
    for candidate in "${sdk:+$sdk/platform-tools/adb}" "$HOME/Library/Android/sdk/platform-tools/adb" "$HOME/Android/Sdk/platform-tools/adb"; do
      if [[ -n "$candidate" && -x "$candidate" ]]; then ADB="$candidate"; break; fi
    done
  fi
fi
if [[ -z "${ADB:-}" ]] || ! command -v "$ADB" >/dev/null 2>&1; then
  printf '%s\n' 'adb를 찾을 수 없습니다. Android SDK Platform Tools를 설치하고 PATH 또는 ANDROID_HOME을 지정하세요.' >&2
  exit 1
fi
if [[ ! -f "$apk" ]]; then
  printf 'APK를 찾을 수 없습니다: %s\nmake android-build를 먼저 실행하세요.\n' "$apk" >&2
  exit 1
fi

devices="$("$ADB" devices)"
serial="${ANDROID_SERIAL:-}"
if [[ -n "$serial" ]]; then
  state="$(printf '%s\n' "$devices" | awk -v selected="$serial" '$1 == selected {print $2}')"
  if [[ "$state" != device ]]; then
    printf '기기를 사용할 수 없습니다: %s (%s)\n휴대폰의 USB 디버깅 인증과 연결 상태를 확인하세요.\n' "$serial" "${state:-연결되지 않음}" >&2
    printf '%s\n' "$devices" >&2
    exit 1
  fi
else
  count="$(printf '%s\n' "$devices" | awk '$2 == "device" {count++} END {print count+0}')"
  if [[ "$count" != 1 ]]; then
    printf '%s\n' '연결된 사용 가능 기기가 정확히 한 대여야 합니다. 여러 대라면 make android-run ANDROID_SERIAL=<기기_ID>로 선택하세요.' >&2
    printf '%s\n' "$devices" >&2
    exit 1
  fi
  serial="$(printf '%s\n' "$devices" | awk '$2 == "device" {print $1}')"
fi

node_bin="$(bash "$project_root/scripts/android-build.sh" --print-node)"
config_file="${ANDROID_DEPLOY_CONFIG:-$project_root/android/deploy.local.json}"
provision_id=""
provision_staged=false
cleanup_provisioning() {
  if [[ "$provision_staged" == true ]]; then
    "$ADB" -s "$serial" shell run-as kr.balkeunter.brightterm rm -f files/deploy-pending.json files/deploy-result.json >/dev/null 2>&1 || true
  fi
}
trap cleanup_provisioning EXIT

printf 'Android APK 설치: %s\n대상: %s\n' "$apk" "$serial"
# Update in place. Never uninstall or clear data on an install/signature failure.
"$ADB" -s "$serial" install -r "$apk"
provision_staged=true
provision_id="$("$node_bin" "$project_root/scripts/android-provision.mjs" prepare "$ADB" "$serial" "$config_file")"
if [[ -z "$provision_id" ]]; then provision_staged=false; fi
launch_output="$("$ADB" -s "$serial" shell am start -W -n kr.balkeunter.brightterm/.MainActivity)"
printf '%s\n' "$launch_output"
case "$launch_output" in
  *'Status: ok'*)
    if [[ -n "$provision_id" ]]; then
      "$node_bin" "$project_root/scripts/android-provision.mjs" confirm "$ADB" "$serial" "$provision_id"
      provision_id=""
      provision_staged=false
    fi
    printf 'BrightTerm 실행 완료: %s\n' "$serial"
    ;;
  *) printf '%s\n' '앱 실행에 실패했습니다. 위 Activity Manager 출력을 확인하세요.' >&2; exit 1 ;;
esac
