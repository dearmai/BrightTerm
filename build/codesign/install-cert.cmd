@echo off
rem BrightTerm 셀프 서명 인증서를 이 PC 에 등록한다 — 서명된 BrightTerm 이 '확인된 게시자: Dany Kim' 으로 보이게.
rem 이 파일과 같은 폴더의 BrightTerm-codesign*.cer 를 모두 등록한다 (빌드 PC 마다 인증서가 다를 수 있다).
rem 관리자 권한으로 실행하면 PC 전체(모든 사용자), 아니면 현재 사용자에게만 등록한다.
rem 등록 위치: 신뢰할 수 있는 루트 인증 기관(Root) + 신뢰할 수 있는 게시자(TrustedPublisher)
chcp 65001 >nul
setlocal
set "DIR=%~dp0"
if not exist "%DIR%BrightTerm-codesign*.cer" (
  echo 인증서 파일이 없습니다: %DIR%BrightTerm-codesign*.cer
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
set "FAILED="
for %%F in ("%DIR%BrightTerm-codesign*.cer") do call :add "%%~fF"
if defined FAILED (
  echo 등록 실패.
  exit /b 1
)
echo 완료.
exit /b 0

:add
echo.
echo 등록: %~nx1
certutil %SCOPE% -f -addstore Root "%~1" >nul || (set "FAILED=1" & echo   Root 저장소 등록 실패 & exit /b 1)
certutil %SCOPE% -f -addstore TrustedPublisher "%~1" >nul || (set "FAILED=1" & echo   TrustedPublisher 저장소 등록 실패 & exit /b 1)
echo   등록됨
exit /b 0
