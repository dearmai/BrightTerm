#!/usr/bin/env bash
# BrightTerm 셀프 서명 인증서를 이 Windows PC 에 등록한다 — install-cert.cmd 와 같은 일을 Git Bash·MSYS2·Cygwin·WSL 에서 한다.
# 코드 서명 신뢰는 Windows 인증서 저장소에 들어가므로 Windows 의 certutil.exe 를 부른다 (Linux·macOS 에서는 할 일이 없다).
# 이 파일과 같은 폴더의 BrightTerm-codesign*.cer 를 모두 등록한다.
# 관리자 권한 셸에서 실행하면 PC 전체(모든 사용자), 아니면 현재 사용자에게만 등록한다.
set -u

dir=$(cd "$(dirname "$0")" && pwd)

if command -v cygpath >/dev/null 2>&1; then
  winpath() { cygpath -w "$1"; }
elif command -v wslpath >/dev/null 2>&1; then
  winpath() { wslpath -w "$1"; }
else
  echo "Windows 인증서 저장소에 등록하는 스크립트입니다. Windows 의 Git Bash·MSYS2·Cygwin·WSL 에서 실행하세요." >&2
  echo "(Linux·macOS 에서는 Windows 코드 서명 인증서를 등록할 필요가 없습니다.)" >&2
  exit 1
fi
if ! command -v certutil.exe >/dev/null 2>&1; then
  echo "certutil.exe 를 찾을 수 없습니다. Windows 의 PATH 를 쓰는 셸에서 실행하세요." >&2
  exit 1
fi

shopt -s nullglob
cers=("$dir"/BrightTerm-codesign*.cer)
if [ ${#cers[@]} -eq 0 ]; then
  echo "인증서 파일이 없습니다: $dir/BrightTerm-codesign*.cer" >&2
  exit 1
fi

if net.exe session >/dev/null 2>&1; then
  scope=()
  echo "PC 전체에 등록합니다."
else
  scope=(-user)
  echo "현재 사용자에게만 등록합니다. PC 전체에 등록하려면 관리자 권한으로 실행하세요."
fi

failed=0
for cer in "${cers[@]}"; do
  echo
  echo "등록: $(basename "$cer")"
  w=$(winpath "$cer")
  for store in Root TrustedPublisher; do
    if ! MSYS2_ARG_CONV_EXCL='*' certutil.exe "${scope[@]}" -f -addstore "$store" "$w" >/dev/null; then
      echo "  $store 저장소 등록 실패"
      failed=1
      continue 2
    fi
  done
  echo "  등록됨"
done

if [ $failed -ne 0 ]; then echo "등록 실패."; exit 1; fi
echo "완료."
