@echo off
rem BrightTerm 셀프 서명 인증서를 이 PC 에 등록한다 — 서명된 BrightTerm 이 '확인된 게시자: Dany Kim' 으로 보이게.
rem 관리자 권한으로 실행하면 PC 전체(모든 사용자), 아니면 현재 사용자에게만 등록한다.
rem 등록 위치: 신뢰할 수 있는 루트 인증 기관(Root) + 신뢰할 수 있는 게시자(TrustedPublisher)
chcp 65001 >nul
setlocal
set "CER=%~dp0BrightTerm-codesign.cer"
if not exist "%CER%" (
  echo 인증서 파일이 없습니다: %CER%
  exit /b 1
)
net session >nul 2>&1
if %errorlevel%==0 (
  set "SCOPE="
  echo PC 전체에 등록합니다.
) else (
  set "SCOPE=-user"
  echo 현재 사용자에게만 등록합니다. PC 전체에 등록하려면 관리자 권한으로 실행하세요.
)
certutil %SCOPE% -f -addstore Root "%CER%" || goto :fail
certutil %SCOPE% -f -addstore TrustedPublisher "%CER%" || goto :fail
echo 완료.
exit /b 0
:fail
echo 등록 실패.
exit /b 1
