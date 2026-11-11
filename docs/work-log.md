# 작업내역서

## 2026-11-12 — 재접속 마우스 모드 정리·서버별 차단 및 pull 정리

### 요청 및 변경

- 사용자가 재접속 후 마우스를 움직일 때 숫자열이 셸에 입력되는 현상을 보고했다. 이전 연결의 마우스 보고 모드가 남는 경로를 확인하고 연결 상태가 끊김·접속 중 상태로 전환될 때 해당 모드만 초기화했다. 화면·스크롤 기록은 유지한다.
- 데스크톱 서버 편집 → 터미널에 '서버 프로그램에 마우스 입력 전달' 옵션을 추가했다. 기본 허용이며 false는 서버 정보와 함께 저장·Git 동기화된다. 저장하면 열린 연결에도 즉시 차단을 적용한다.
- 서버 마우스 모드 요청을 패킷 경계와 무관하게 걸러내고, 같은 제어문에 포함된 화면·커서 등 다른 모드는 보존한다. 렌더러·메인 프로세스에서 마우스 보고 전송을 차단하고 대체 화면의 휠→방향키 변환도 막는다. 허용된 보고도 다른 패널에 브로드캐스트하지 않는다.
- 직전 요청의 공통 확인창 좌우 방향키 버튼 이동 수정을 함께 포함한다. 사용자의 후속 요청에 따라 main에 커밋하고 origin/main으로 푸시한다.
- git fetch 결과 main이 origin/main보다 2개 커밋 뒤처져 있었고 로컬 THIRD_PARTY_NOTICES.txt 수정이 있었다. 해당 파일만 이름 있는 stash('preserve local generated notices before pull 2026-11-12')에 보관한 뒤 git pull --ff-only origin main으로 dadd640까지 반영했다. 방향키 수정은 작업 트리에 보존했다. 생성 고지는 자동 복원해 원격 내용을 덮지 않았으며 stash에서 복구할 수 있다.

### 직접 검증한 결과

- npm run typecheck, npm run build 통과.
- node --experimental-strip-types --test test/mouse.test.mjs test/terminal.test.mjs test/idle-guard.test.mjs: 17개 통과. 분리된 제어문·혼합 모드·마우스 보고 판별·일반 키 입력 보존을 확인했다.
- node test/e2e-mouse.mjs 통과. 임시 앱 데이터와 로컬 TCP/Telnet 서버로 실제 마우스 보고, 연결 중단·자동 재접속 후 초기화, 서버 편집 UI에서 차단 옵션 저장·즉시 반영, 패킷으로 나눈 모드 재요청 차단, 대체 화면 휠 차단, 일반 키 입력 전달을 확인했다.
- E2E 최초 시도에서는 xterm.js가 urxvt 1015 요청을 무시하고 X10 형식으로 응답해 예상 형식 단언이 실패했다. 지원되는 SGR 형식으로 수정한 뒤 통과했다. X10·urxvt 보고 판별은 단위 테스트와 메인 프로세스 차단 경로에서 따로 확인했다.
- git diff --check 통과.

### 사용자 확인 및 미검증 범위

- 사용자 화면에서 마우스 이동 시 출력된다는 사실은 사용자 확인 결과다. 실제 homelab 서버에 접속하거나 설정·실행 중인 프로그램을 변경하지 않았다.
- 사용자 서버의 SSH·tmux 조합, Windows·Linux 실기기 및 Android 실행은 미검증이다. 이번 새 차단 옵션은 데스크톱 기능이며 Android 동작은 변경하지 않았다.
- 설치 패키지 빌드·설치는 하지 않았으며 생성된 out/·dist/·node_modules/는 커밋 대상이 아니다.

## 2026-11-11 — BrightTerm Extended 1.3.0으로 제품명·버전 변경

### 요청 및 변경

- 원본 최신 v1.3.0과 포크를 비교한 뒤, 원본 기능을 병합하지 않고 독립 포크의 제품명을 BrightTerm Extended로 정했다.
- 데스크톱 package.json·lockfile과 Android versionName을 1.3.0으로 변경했다. Android versionCode는 2에서 3으로 올렸다.
- 타이틀바·시작/잠금 화면·정보 화면·Android 앱 이름·설치 파일 및 바로가기 이름을 변경했다. 정보 화면과 README에 비공식 포크임을 표시하고 원본 프로젝트 링크를 남겼다.
- 업데이트 알림 및 README의 다운로드 링크를 dearmai/BrightTerm 릴리스로 변경했다. 릴리스 발행이나 태그 생성은 이번 작업에 포함하지 않았다.
- 설치 스크립트가 package.json의 productName을 사용하도록 변경했다. Windows 브릿지가 찾는 BrightTerm.exe와 Linux brightterm 실행 명령은 유지했다.
- 앱 ID·Android 패키지 ID·기존 BrightTerm 프로필 경로·BrightTerm-data 포터블 경로·Git 동기화 형식을 유지했다. BRIGHTTERM_DATA로 지정한 경로가 우선한다.
- README와 CHANGELOG에 독립 버전 관리 및 데이터 경로 유지 내용을 기록했다.

### 직접 검증한 결과

- macOS / Node.js 24.15.0에서 npm run typecheck 및 npm run build 통과.
- Playwright로 Electron 앱을 임시 BRIGHTTERM_DATA 프로필에서 실행해 앱 이름 BrightTerm Extended, 버전 1.3.0, 문서 제목·시작 화면 표시 및 임시 프로필 경로를 확인했다. 종료 후 임시 데이터를 삭제했다.
- 설치된 electron-builder JSON 스키마를 Ajv로 검증해 설정 유효성을 확인했다. Linux·macOS 설치 스크립트의 bash -n 구문 검사 통과.
- 이번 변경 파일의 git diff --check 통과. 기존 THIRD_PARTY_NOTICES.txt의 줄바꿈 변경은 검사·커밋 대상에서 제외했다.

### 사용자 확인 및 미검증 범위

- 사용자는 BrightTerm Extended / 1.3.0 추천안을 승인했다. 변경 후 실제 사용자 환경의 실행 결과는 아직 받지 않았다.
- 설치 패키지 생성·업그레이드 설치·기존 실제 볼트 열기·Windows 외부 브릿지·Linux 실행·Android 빌드 및 기기 실행은 이번에 검증하지 않았다. deb Architecture와 네이티브 ELF 검증도 수행하지 않았다.
- 생성된 out/·dist/·node_modules/는 커밋하지 않으며 기존 THIRD_PARTY_NOTICES.txt 수정은 보존한다.

## 2026-11-11 — tmux 마우스 설정 및 자동 명령 전송 수정

### 요청 및 변경

- 현재 작업 트리의 tmux 수정 사항을 확인하고 작업내역서를 작성해 커밋·푸시한다.
- 데스크톱 `persist.ts`와 Android `Tmux.java`에서 `set-option`·`send-keys`의 대상을 `=세션명:`으로 지정했다. 세션 존재 확인과 연결에는 기존 `=세션명`을 사용한다.
- 접속할 때 적용하는 마우스 설정의 표준 오류를 숨기지 않도록 변경했다.
- Android 테스트를 시작 명령의 목록 반환 형식에 맞추고, 백그라운드 자동 입력 완료를 기다리도록 수정했다.
- 실제 tmux로 최초 접속·재접속·마우스 전환·자동 명령의 1회 실행 및 다른 세션에 영향을 주지 않는지 확인하는 테스트를 추가했다. 변경 이력도 갱신했다.

### 직접 검증한 결과

- macOS / Node.js 24.15.0에서 `npm run typecheck`, `npm run build` 통과.
- `node --experimental-strip-types --test test/startup.test.mjs test/tmux-mouse.test.mjs`: 5개 통과, 실제 tmux 테스트 1개 건너뜀(실행 파일 없음).
- Android `:app:testDebugUnitTest --tests kr.balkeunter.brightterm.TmuxTest` 통과. 기본 GraalVM 21에서는 Android JDK 이미지 변환이 실패했고, 설치된 JBR 17.0.14를 해당 명령의 `JAVA_HOME`으로 지정해 다시 실행해 통과했다.

### 검증 범위와 산출물

- 실제 tmux 서버와 앱 화면에서 마우스 휠·선택·SSH 재접속 동작은 이번에 검증하지 않았다. Android는 Java 컴파일과 해당 단위 테스트까지 확인했으며 APK 패키징·기기 실행은 하지 않았다.
- 이번 대화에서 사용자 실행 확인 결과는 받지 않았다.
- `THIRD_PARTY_NOTICES.txt`의 변경은 `cpu-features` 고지 부분의 줄바꿈 차이뿐이므로 커밋에서 제외하고 로컬에 보존한다. 생성된 `out/`, `dist/`, `node_modules/`도 커밋하지 않는다.

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

## 2026-11-12 — Tauri 전환 검토 문서화

- 사용자 요청에 따라 `docs/tauri-migration-review.md`에 전환의 기대 효과, 현재 구조의 재사용 범위, 백엔드 이식 비용, 플랫폼·PRoot 제약과 단계별 PoC 검증안을 정리했다.
- 현재 결정은 문서 보관이다. 앱 코드·의존성·빌드 설정은 변경하지 않았다.
- 직접 확인한 저장소 구조 및 공식 문서, 기존 사용자의 PRoot 실행 확인, Tauri 관련 미검증 범위를 구분했다. 성능 개선 수치나 PRoot 호환성을 확정하지 않았다.
- 문서 변경은 `git diff --check`로 확인한다. Tauri 구현·빌드·실행 및 앱 테스트는 이번 문서 작업에서 수행하지 않는다.

## 2026-11-11 — 포워딩 모니터링, 유휴 방지 안내 및 재접속 규칙 설정

### 요청 및 변경

- 연결된 세션의 포트 포워딩 상태를 하단 상태바와 좌측 서버 목록에 표시한다. 초록은 정상, 노랑은 확인 중, 빨강은 리스너 또는 목적지 TCP 접속 이상이다.
- 상태바 표시를 클릭하면 포트별 주소, 현재·누적 TCP 연결 수, 송수신 payload 바이트, 마지막 점검 시간과 오류를 작은 팝업으로 확인한다. 통계는 최대 0.5초 주기로 전달한다.
- 같은 SSH 대상·사용자·점프/프록시 경로의 세션은 포워딩을 공유한다. 변경되지 않은 규칙은 재사용하고 신규·수정·실패한 규칙만 생성 또는 재할당한다. 마지막 사용 세션을 닫을 때 해제하며, 포워딩을 처음 만든 터미널을 먼저 닫아도 다른 사용 세션이 있으면 SSH 연결을 유지한다.
- 변경·삭제된 규칙을 해제하면 해당 규칙의 기존 TCP 연결도 종료된다. 수정되지 않은 규칙의 통계는 유지하며, 재할당된 규칙의 통계는 새로 집계한다.
- 포워딩 시작 시 및 이후 15초마다 목적지 TCP 접속을 확인한다(제한 5초). L은 SSH 서버를 통한 목적지 접속, R은 이 PC에서 목적지 접속을 검사한다. 점검 연결은 사용자 연결 수·바이트 통계에서 제외한다.
- 서버 설정의 유휴 방지 설명을 `?` 도움말 팝업으로 옮겼다.
- 유휴 방지가 켜진 서버에 연결하면 간격·명령·적용 조건을 콘솔에 안내한다. 별도 SSH exec 환경 대신 실제 터미널 셸의 안전한 프롬프트에서 TMOUT 값을 한 번 조회한다. 숫자·0·미설정·빈 값·해석 불가·조회 시간 초과를 구분하고, 간격이 TMOUT보다 길거나 같으면 경고한다. tmux 세션 유지 창에서는 유휴 방지와 TMOUT 자동 조회를 건너뛴다.
- 서버별로 편집 가능한 셸 프롬프트 예시를 추가했다. `*`는 같은 줄의 가변 문자열이고, 여러 줄 예시는 줄별로 비교한다. 최종 기본값은 `*@* [/*] `이며 `username@hostname [/dir/dir2]` 뒤에 커서가 오는 형태다. `_`는 입력 문자에 포함하지 않는다. 빈 값은 추가 예시 인식을 끄고 기존 자동 인식만 사용한다.
- 앱 설정 → 연결과 서버 편집 → 고급에서 재접속 규칙을 지정한다. 첫 대기 시간, 고정·일정 증가·배수 증가, 증가량/배수, 최대 대기 시간, 최대 횟수를 제공한다. 0회는 무제한이며 연결 성공 시 대기 시간과 연속 재시도 횟수가 초기화된다.
- 서버별 규칙이 없으면 앱 기본 규칙을 따른다. 기존 저장 파일은 2·4·8·16·30초 상한, 최대 8회의 기존 동작을 유지한다. 최초 접속 실패는 자동 재시도하지 않으며, 연결 중 설정 변경은 다음 재시도 예약부터 적용한다.

### 직접 검증한 결과

- `npm run typecheck`, `npm run build` 통과.
- `node --test test/idle-guard.test.mjs test/idle-tmout.test.mjs test/reconnect.test.mjs`: 15개 통과. 사용자 정의 프롬프트, 이어쓰기·프로그램 프롬프트 제외, TMOUT 설명, 재시도 증가 방식·상한·상속을 확인했다.
- `node --experimental-transform-types test/forward-pool.mjs`: 로컬 TCP 서버로 공유 포워딩, 송수신량, 최초 세션 해제 후 유지, 목적지 변경, 마지막 세션 해제를 검증했다. 원격 포워딩 할당·재사용·해제는 SSH 클라이언트 모의 객체로 확인했다. 목적지 접속 성공·실패·복구, 조회 시간 초과·취소, 늦은 응답 정리, 점검 연결의 통계 제외도 확인했다.
- `node test/e2e-auto-reconnect.mjs` 통과. 앱을 실행하고 로컬 텔넷 연결을 끊어 앱/서버별 우선순위, 1→2초 재시도, 2회 제한, 성공 후 초기화, 앱 규칙 상속을 확인했다. 앱 기본 규칙과 서버별 규칙을 화면에서 편집하고 저장·재열기·상속 복원도 확인했다.
- `node test/e2e-idle-guard.mjs` 통과. 로컬 텔넷 모의 셸에서 TMOUT 조회·안내와 자동 명령 전송, 프로그램 화면·입력 중 제외, 사용자 프롬프트 편집·저장·복원을 확인했다. 최종 대괄호 경로 기본 예시를 적용한 입력으로 재실행해 통과했다.

### 사용자 제공 사례와 검증 범위

- 사용자가 `dearmai@vultr-iw:pts/0->/home/dearmai (0)` 다음 줄에 `>`가 표시되는 프롬프트와 TMOUT 조회 대기 메시지를 제공했다. 단독 `>`를 이어쓰기 프롬프트로 제외하던 규칙을 확인하고, 여러 줄 사용자 예시를 지원했다. 이후 사용자 요청으로 기본 예시를 대괄호 경로 형태로 변경했다.
- 실제 사용자 SSH·AIX 서버에서의 TMOUT 조회 및 유휴 방지 성공은 아직 사용자에게 확인받지 않았다.
- 포워딩 점검은 TCP 접속 가능 여부를 뜻한다. DB 인증·쿼리 성공, 원격(R) 리스너의 외부 접근 경로와 방화벽까지 확인하지 않는다. 실제 SSH 서버의 L/R 포워딩 전체 경로는 이번에 검증하지 않았다.
- 이번 변경의 Linux·macOS·Android 실행, 배포 패키지 생성과 설치 검증은 수행하지 않았다. `out/`, `dist/`, `node_modules/`는 커밋하지 않는다.
- 작업 시작 전부터 수정되어 있던 `THIRD_PARTY_NOTICES.txt`는 optional 의존성 누락에 따른 로컬 차이로, 기존 기록에 따라 이번 커밋에서도 제외한다.
