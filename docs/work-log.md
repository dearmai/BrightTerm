# 작업내역서

## 2026-11-05 — 매뉴얼 탭에 RHEL 9·10, bash, zsh 추가

### 요청 및 변경

- 우측 패널 매뉴얼에 RHEL 9, RHEL 10, bash, zsh 문서를 추가했다(`src/renderer/src/manuals/`). 두 RHEL 문서의 공통 절은 `rhel-common.md` 한 파일에 두고 `withCommon`으로 합친다.
- 서버 감지가 `/etc/os-release`도 읽는다(`serverEnv.ts`, `ServerEnv.distro`). RHEL과 `ID_LIKE`에 `rhel`이 있는 호환 배포판은 메이저 버전으로 문서를 고르고, 상태 줄에 배포판 이름을 표시한다.
- bash·zsh 로그인 쉘이면 OS와 상관없이 해당 문서를 고른다.

### 직접 검증한 결과

- Windows 11 x64: 타입 검사, 빌드, `manual`·`terminal` 단위 테스트 15개, `e2e-manual` 통과. 전체 e2e는 다시 돌리지 않았다.
- 사용자 서버 soyo(Rocky Linux 9.8, podman 5.8.2)에서 Red Hat UBI 9.8, 10.2 이미지를 임시 컨테이너로 실행해 확인했다.
  - 패키지 버전, `/etc/os-release`, `/etc/skel`, `sshd_config` 기본값, `update-crypto-policies --show`.
  - bash·zsh 문서의 동작과 RHEL 패키지 도구 등 약 100개 항목. 실패 5건은 시험 오류 1건(`ERR_EXIT`로 먼저 종료), 시험 환경 1건(`script` 사용 불가, pty로 재시험 통과), 문서 오류 1건, UBI 저장소에 없는 패키지 2건이었다. 문서 오류(`sshd -T`의 `without-password` 표시)는 본문에 반영했고, 패키지 2건은 soyo의 패키지 정보로 확인했다.
  - `TMOUT` 종료, `TRAPALRM`, 시작 파일 순서는 pty를 붙여 시험했다. bash·zsh는 경고 없이 바로 종료함을 확인했다.
  - 코드 블록 57개의 `bash -n`, `zsh -n` 문법 검사.
- 감지 스크립트를 soyo와 두 UBI 이미지에서 실행했다. RHEL 9의 `ID_LIKE`는 `fedora`, RHEL 10은 `centos fedora`, Rocky는 `rhel centos fedora`로, RHEL 자체는 `ID_LIKE`만으로 판별할 수 없음을 확인했다.

### 사용자 확인

- 검증 환경으로 soyo의 podman을 지정하고, 이 PC의 ssh 키를 soyo에 등록했다. 키는 서버에 남아 있다. 받은 UBI 이미지는 지웠고 실행 중인 컨테이너 14개는 그대로다.

### 검증 범위와 산출물

- **실제 RHEL 서버에서 실행하지 않았다.** 시스템을 바꾸는 `nmcli modify`, `firewall-cmd`, `semanage`, `lvextend`, `update-crypto-policies --set` 등은 실행하지 않았고, 일부만 `--help`나 패키지 정보로 확인했다.
- 커널 버전은 컨테이너로 알 수 없어 RHEL 9는 Rocky 9.8 값, RHEL 10은 릴리스 노트를 따랐다.
- `docs.redhat.com`이 503을 반환해 Red Hat 문서를 직접 읽지 못하고 검색으로 확인했다. RHEL 10의 패키지 교체, ifcfg 제거, x86-64-v3 등은 원문과 직접 대조하지 못했다.
- `docs.redhat.com`, GNU 링크는 스크립트 요청에 403·503이라 브라우저에서 열리는지 확인하지 못했다.
- 앱을 실제 soyo에 접속해 매뉴얼 탭을 열어 보지는 않았다. e2e는 RHEL 응답을 흉내 낸 서버로 확인했다.
- `THIRD_PARTY_NOTICES.txt`의 로컬 변경은 이번에도 커밋하지 않았다.

## 2026-11-05 — 서버별 재접속·유휴 방지, 스니펫 동기화, 접속 로그, 매뉴얼 탭, Windows 설치

### 요청 및 변경

- **Windows `make build`·`make install`**: `Makefile`에 Windows 분기와 `SILENT` 옵션 추가, `scripts/install-windows.ps1` 추가. 서명 설정을 인증서 지문으로 지정(`electron-builder.win-signed.yml`, `docs/codesign.md`). 원격의 ARM64 변경과 `Makefile`이 충돌해 양쪽을 합쳤다.
- **서버별 자동 재접속**: `Host.autoReconnect`(없으면 앱 설정). 서버 편집 → 고급에서 앱 설정 따르기·켜기·끄기. 접속 중 변경은 다음 끊김부터 적용.
- **유휴 방지 명령**: `Host.idleCommandSec`, `Host.idleCommand`, `src/main/idleGuard.ts`. AIX ksh 의 `TMOUT` 끊김 대응. 대체 화면, 입력 중인 줄, 셸이 아닌 프롬프트에서는 보내지 않고, `shell will time out` 경고가 보이면 간격과 상관없이 보낸다. `viewer@eaiap01t [/eai/viewer] ` 형태의 프롬프트를 인식한다.
- **스니펫**: Git 동기화에 포함(`gitSync.ts`, `gitSyncFormat.ts`, `store.ts`). 형식 버전 1을 유지하고 `snippets`는 선택 필드로 두었다. JSON 내보내기·가져오기 추가(`src/main/snippetsFile.ts`, 스니펫 패널).
- **접속 상세 로그**: 탭 메뉴(Android는 길게 터치)에서 연다. 데스크톱은 `ssh2`의 `debug`, Android는 JSch 인스턴스 로거를 메모리에 모은다(`src/main/connectLog.ts`, `ConnectLogDialog.tsx`, `ConnectLog.java`). 탭마다 처음 1000줄과 최근 1000줄을 보관하고 `CHANNEL_DATA` 등 패킷 줄은 남기지 않는다.
- **메뉴**: 색상과 터미널 테마를 2차 메뉴로 옮겼다(`ui.tsx`의 `MenuItem.submenu`).
- 다른 세션에서 진행해 인계받은 작업: 빌드 번호(`버전_YYYYMMDD_SEQ`), 터미널 테마를 패널 머리말에서 탭 메뉴로 이동, 우측 패널 매뉴얼 탭(AIX 7.2–7.3, ksh), 이 PC에 Go 1.27.3 설치(저장소 변경 아님).

### 직접 검증한 결과

커밋 직전 Windows 11 x64 에서 실행했다.

- `npm run typecheck`, `npm run build` 통과.
- 단위 테스트 32개 통과: `connect-log`, `snippets-file`, `idle-guard`, `startup`, `terminal`, `manual`.
- e2e 통과: `e2e-auto-reconnect`, `e2e-idle-guard`, `e2e-snippets-file`, `e2e-connect-log`, `e2e-themes`, `e2e-manual`, `e2e-git-sync`.
  - 재접속·유휴 방지는 로컬 TCP 서버에 텔넷으로, 접속 로그·매뉴얼은 로컬 `ssh2` 서버로 확인했다. 접속 로그 e2e는 비밀번호와 입력한 명령이 로그에 없는 것을 확인한다.
- 스니펫 업데이트 경로: 커밋 `819c1e1`을 임시 worktree에 빌드해 이전 버전으로 두 기기를 동기화한 뒤 새 버전으로 올렸다. 거짓 충돌 없음, 두 기기의 스니펫 병합, 삭제 전달, 이전 버전이 끼어들어도 스니펫 유지를 확인했다. 일회성 시험으로 저장소에 넣지 않았다.
- Android 로거: 실제 JSch 2.28.0에 같은 로거를 달아 로컬 `ssh2` 서버에 비밀번호로 접속했다. 협상·인증 줄이 기록되고 비밀번호와 입력이 없음을 확인했다. JSch 소스의 로그 호출 350개에서 비밀번호·키 값을 찍는 곳을 찾지 못했다. `ConnectLog.java`는 단독 컴파일해 임시 코드로 실행했다.
- 2차 메뉴: 탭 메뉴의 테마 2차 메뉴를 스크린샷으로 확인했다.

### 인계받은 내용 (다른 세션의 보고, 이번에 다시 확인하지 않음)

- 빌드 번호: 빌드할 때 증가, dev에서 순번 유지, Windows 앱 정보 화면 표시. 데스크톱만 적용했고 Android 적용 여부는 미결정이다.
- Go: SHA256 확인 후 `D:\apps\go`에 설치, 사용자 PATH 추가, `npm run bridge` 성공.
- 매뉴얼: IBM 문서로 확인한 것은 기본 쉘, ksh93 위치, root 쉘 변경 주의사항뿐이고 나머지는 작성자 지식이다. IBM `docs` 링크 4개는 스크립트 요청에서 403이라 열리는지 확인하지 못했다.

### 사용자 확인

- AIX 7.2 서버에서 `unset TMOUT`이 성공(반환값 0)하고 `env`에 `TMOUT`이 없는데도 `shell will time out in 60 seconds` 뒤 끊겼다. 원인은 밝히지 못했고, 유휴 방지 명령은 증상을 우회하는 기능이다.
- 메뉴가 길다는 화면을 사용자가 공유해 2차 메뉴로 바꿨다. 바꾼 뒤의 사용감은 아직 듣지 못했다.

### 검증 범위와 산출물

- **Android 앱은 빌드하지 못했다.** SDK 라이선스 미동의, `build-tools 35`·`platform 36` 미설치이고 에뮬레이터·기기도 없다. `TerminalService.java`, `MainActivity.java` 변경은 컴파일되지 않았고, 길게 터치 → 로그 창은 실행하지 않았다. `ConnectLogTest`와 `e2e-android`도 실행하지 않았다.
- 실제 AIX 에서 유휴 방지 명령(특히 대체 화면을 쓰지 않는 vi), 매뉴얼 감지와 문서 명령을 확인하지 못했다.
- 재접속·유휴 방지의 끊김 시험은 텔넷으로만 했고 실제 SSH 서버로는 하지 않았다.
- 전체 `make install`, 코드 서명, `dist:*` 패키지 결과물, 빌드 번호의 macOS 창은 확인하지 못했다. macOS·Linux 에서는 이번 변경을 실행하지 않았다.
- 2차 메뉴가 화면 끝에서 왼쪽·위로 옮겨 열리는 동작, 스니펫 파일의 실제 선택 창(테스트에서 가짜로 대체)은 확인하지 못했다.
- `THIRD_PARTY_NOTICES.txt`의 로컬 변경은 커밋하지 않았다. Windows 에 optional 패키지 `buildcheck`, `cpu-features`가 설치되지 않아 생긴 차이로, 커밋하면 고지에서 두 패키지가 빠진다. 작업 트리에는 수정 상태로 남아 있다.

## 2026-11-03 — ARM64 deb 빌드 및 PRoot 실행 안내

### 요청 및 변경

- ARM64 deb 빌드를 지원하고, 대상 장비에서 발견한 실행 문제의 대응 지침을 기록한다.
- `package.json`: `dist:linux:deb:arm64` 명령 추가.
- `Makefile`: Linux `build`, `deb`에 `ARCH` 전달. 기본값은 현재 Node.js의 아키텍처.
- `electron-builder.yml`, `scripts/prepare-linux-native.cjs`: Linux 패키징 후 `node-pty`의 ELF 아키텍처를 확인한다. 대상과 다르면 임시 폴더에서 Node-API 모듈을 컴파일해 패키지에 반영하고 임시 폴더를 정리한다. 호스트 개발용 바이너리는 유지한다.
- `README.md`, `docs/CHANGELOG.md`: 교차 빌드 명령, 컴파일러 준비, 결과 파일과 PRoot 실행법 추가.
- `AGENTS.md`: 패키징 검증과 PRoot 진단·실행 지침 추가.

### 직접 검증한 결과

- x64 Linux에서 `gcc-aarch64-linux-gnu`, `g++-aarch64-linux-gnu`를 설치하고 `npm run dist:linux:deb:arm64` 실행 성공.
- `dist/BrightTerm-1.2.3-linux-arm64.deb` 생성. `dpkg-deb -f`에서 패키지 `brightterm`, 버전 `1.2.3`, 아키텍처 `arm64` 확인.
- Electron 실행 파일과 패키징된 `node-pty`가 ELF64 / AArch64임을 확인. serialport의 ARM64 prebuild도 확인.
- deb 아카이브에서 `node-pty`를 읽어 ELF 아키텍처를 검사하고, 교차 컴파일 결과와 SHA-256이 일치함을 확인.
- 기존 개발용 `node-pty`의 x86-64 바이너리 보존 및 셸 출력 `native-pty-ok` 확인.
- `electron-builder --linux --x64 --dir` 성공. 패키지의 Electron을 `ELECTRON_RUN_AS_NODE=1`로 실행해 패키지 내 PTY의 셸 출력 `packaged-pty-ok` 확인.
- hook의 다른 플랫폼 처리, 기존 ARM64 바이너리 재사용, 크로스 컴파일러 누락 시 안내 오류 확인.
- `make -n deb ARCH=arm64`, hook 구문 검사, `git diff --check` 통과.

검증 당시 설치된 Node.js는 24.21.0, electron-builder는 26.15.3, Electron은 43.7.5였다. 저장소의 Electron 선언은 `^43.8.4`이며, 이번 검증은 기존 설치 의존성을 사용했다. clean install에 따른 전체 재검증은 수행하지 않았다.

### 사용자 장비 확인

- Ubuntu 24.04.5 LTS, aarch64, 커널 문자열 `6.17.0-PRoot-Distro`.
- 기본 실행에서 `Trace/breakpoint trap`과 zygote의 `write: Broken pipe (32)`가 발생했다.
- 사용자가 `--no-sandbox`를 붙여 앱이 실행됨을 확인했다. PRoot의 Chromium 샌드박스 호환 문제로 추정한다.
- 일반 Linux에 샌드박스 해제 옵션을 기본 적용하는 변경은 하지 않았다.

### 검증 범위와 산출물

- ARM64 장비의 앱 실행은 사용자 확인 결과다. ARM64 장비의 PTY·SSH·시리얼 기능 및 일반 ARM64 Ubuntu 데스크톱 실행은 별도 검증하지 않았다.
- AppImage 전용 빌드·실행 검증은 수행하지 않았다.
- deb는 `dist/`의 로컬 산출물이며 저장소 커밋과 GitHub Release 업로드 대상에 포함하지 않는다.
