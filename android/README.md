# BrightTerm Android

휴대폰과 Samsung DeX용 네이티브 Android SSH 클라이언트입니다. Electron 런타임 대신 Java SSH 서비스와 로컬 WebView의 xterm.js를 사용합니다. 데스크톱 앱과 독립적으로 빌드합니다.

## 빌드와 설치

요구 사항: **Android 11/API 30 이상**, JDK 17, Node.js 22.12+, Android SDK 36 및 SDK Platform Tools. Android Studio에서 이 `android/` 폴더를 열거나 저장소 루트에서 실행하세요.

```sh
make android-run
# 기기가 여러 대라면: make android-run ANDROID_SERIAL=<기기_ID>

# npm으로 빌드만 실행하려면:
npm ci --ignore-scripts
# ANDROID_HOME을 SDK 경로로 지정하거나 android/local.properties에 sdk.dir을 설정합니다.
npm run android:build
adb -s <기기_ID> install -r android/app/build/outputs/apk/debug/app-debug.apk
```

`make android-run`은 의존성 준비 → APK 빌드 → `adb install -r` → Activity 실행을 수행합니다. 기기가 한 대면 자동 선택하고, 여러 대면 `ANDROID_SERIAL`을 요구합니다. 설치 실패 시 앱을 삭제하거나 데이터를 지우지 않습니다. `make android-build`는 APK만 만듭니다. `ADB=/path/to/adb`로 adb 실행 파일을 지정할 수 있습니다.

이 worktree의 Make 빌드에는 기본 Git URL `https://github.com/dearmai/bright-term-vault.git`, 사용자명 `dearmai`, 브랜치 `main`을 넣습니다. 최초 실행 시에만 적용하고 기존 저장 설정은 덮어쓰지 않습니다. 자동 동기화는 인증 설정 전까지 꺼 둡니다. 다른 저장소는 `make android-run ANDROID_GIT_REMOTE=https://github.com/user/repo.git ANDROID_GIT_USERNAME=user`로 지정할 수 있습니다. 토큰이나 개인키는 APK에 포함하지 않습니다.

로컬 파일 `android/deploy.local.json`의 `accessToken`에 토큰을 넣으면 `make android-run`이 설치 후 앱에 사전 등록합니다. 기본 URL·사용자명·브랜치는 채워져 있습니다. 이 파일은 Git에서 제외하고 최초 생성 권한을 0600으로 설정합니다. 예제는 `android/deploy.example.json`입니다. `ANDROID_DEPLOY_CONFIG=/path/to/config.json`으로 다른 파일을 지정할 수 있습니다.

배포 시 토큰은 adb 표준 입력으로 앱 전용 임시 파일에 전달하고 앱이 즉시 읽어 삭제한 뒤 Keystore로 암호화합니다. 저장 성공 응답까지 확인합니다. 명령줄 인자·로그·APK에는 토큰을 넣지 않습니다. 빈 토큰은 기존 인증 정보를 유지합니다. 파일에 토큰이 있으면 `enabled` 값에 따라 자동 동기화도 설정합니다. 기존 원격 볼트를 처음 가져올 때에는 앱에서 원격 가져오기와 볼트 마스터 비밀번호 입력이 필요합니다.

GitHub HTTPS 인증은 **Fine-grained personal access token**을 사용합니다. GitHub Settings → Developer settings → Personal access tokens → Fine-grained tokens에서 소유자 `dearmai`, 저장소 `bright-term-vault`만 선택하고 **Contents: Read and write**로 만드세요. 앱의 Git 사용자명·HTTPS 토큰에 입력합니다. 토큰은 기기에 암호화해 저장하며 `adb install -r` 업데이트 시 유지됩니다. 토큰 만료·폐기 시 새 토큰으로 바꾸면 됩니다. 앱 제거/데이터 초기화 시에는 다시 입력해야 합니다. SSH 개인키와 볼트 마스터 비밀번호는 이 토큰과 별개입니다.

Make 빌드는 기본 Android SDK 경로(macOS `~/Library/Android/sdk`, Linux `~/Android/Sdk`)를 확인합니다. `JAVA_HOME`이 없거나 JDK 17이 아니면(예: sdkman GraalVM 21) 설치된 JDK 17(`java_home -v 17`, sdkman `17*`, `/usr/lib/jvm`, Android Studio 내장 JBR)을 찾아 사용하고, PATH의 Node.js가 실행되지 않거나 버전이 낮으면 설치된 NVM 버전 중 지원 버전을 선택합니다. 환경 변경은 해당 빌드에만 적용합니다. 별도 SDK는 `ANDROID_HOME`, 특정 JDK를 강제하려면 `ANDROID_JAVA_HOME`으로 지정하세요.

`npm ci --ignore-scripts`는 Android 빌드에 필요 없는 Electron/node-pty 설치 작업을 건너뜁니다. 빌드에는 Gradle wrapper가 포함되며 SDK/Java 경로는 저장소에 고정하지 않습니다. APK는 개발용 debug 서명입니다. 스토어 배포용 서명·AAB와 게시 작업은 포함하지 않습니다.

## 사용 가능한 기능

- SSH 비밀번호, keyboard-interactive의 단일 비밀번호 질문, PEM/OpenSSH 개인키 및 키 암호 인증. OTP/다단계 challenge UI는 아직 지원하지 않습니다.
- 최초 접속 시 SHA-256 호스트 키 지문을 확인하고 기기에 저장합니다. 바뀐 호스트 키는 자동 교체하지 않고 거부합니다. 현재 신뢰 기록을 편집하는 UI는 없습니다.
- 서버 목록·비밀번호·개인키·키 암호를 Android Keystore의 기기별 AES-GCM 키로 암호화하여 원자적으로 저장합니다. 기존 서버의 비밀 필드를 비우면 저장된 값을 유지합니다. 삭제 후 재등록하면 자격 증명을 교체할 수 있습니다.
- 여러 SSH 세션, UTF-8/xterm-256color, 터치 Esc/Tab/Ctrl/Alt/방향키, 선택 복사와 붙여넣기, 마우스 우클릭, 하드웨어 키보드 단축키, 두 손가락 핀치줌으로 글자 크기 변경 (8~28px).
- SFTP 폴더 탐색과 Android 시스템 파일 선택기를 통한 업로드·다운로드. 업로드는 확인 후 원격 파일을 덮어씁니다. 전송 중 오류/연결 종료 시 일부 파일이 남을 수 있습니다. 이어받기·진행률·작업 취소 UI는 아직 없습니다.
- 서버 편집 → **세션 유지 (tmux)**: 세션 이름과 마우스 모드를 설정합니다. SSH 접속마다 기존 세션 목록·신규 세션 생성·일반 SSH 셸 중 선택합니다. 신규 생성은 기존 이름과 충돌하면 고유 접미사를 붙이며, 시작 명령은 새 tmux 세션을 만들 때만 실행합니다. 일반 SSH 셸 선택은 해당 접속에만 적용됩니다. 이름을 비우면 데스크톱과 같은 `bt-서버이름` 규칙으로 만듭니다. tmux가 없는 서버는 안내 후 일반 셸로 연결합니다. 데스크톱에서 가져온 tmux 설정도 사용할 수 있습니다.
- **설정** (상단 ⚙, 서버 목록 하단 또는 Ctrl+,): 앱 테마(다크·라이트·시스템 설정 따르기), 데스크톱과 같은 터미널 색 테마 6종, 글꼴(내장 D2Coding ligature·D2Coding 또는 시스템 고정폭), 글자 크기·줄 간격·커서 모양·커서 깜빡임·스크롤백, 선택하면 자동 복사, 여러 줄 붙여넣기 확인, Shift+Enter 줄바꿈, 서버 프로그램의 OSC 52 클립보드 복사 허용. 바로 적용되며 이 기기에만 저장합니다(Git 동기화 대상 아님). 핀치줌·Ctrl +/-로 바꾼 글자 크기도 기억합니다. 앱 테마를 바꾸면 기본 터미널 테마(BrightTerm Dark/Light)도 함께 바꿉니다. 창·백업·자동 잠금·재접속 등 Android에 해당하지 않는 데스크톱 설정은 없습니다.
- D2Coding 1.4.0 글꼴(SIL OFL 1.1, NAVER)을 WOFF2로 변환해 APK에 내장합니다 (글리프 변경 없음).
- 연결 후 시작 명령. 예: `tmux new-session -A -s brightterm`. 원격 tmux가 앱 프로세스 종료 후에도 작업을 유지합니다.

## 휴대폰 / DeX 동작

700 CSS px 이하에서는 서버 목록이 서랍으로 접히고 터치 보조키를 표시합니다. 넓은 창에서는 서버 목록과 터미널을 함께 표시합니다. DeX 창 장식, Android 시스템 바, 디스플레이 컷아웃, 소프트 키보드 인셋은 네이티브 컨테이너에서 한 번 처리합니다. 키보드나 창 크기가 바뀌면 xterm을 다시 맞추고 SSH PTY 크기를 전송합니다.

Activity는 회전·창 크기·밀도·키보드·UI 모드 변경을 처리합니다. SSH 소켓은 별도 foreground service에 있어 Activity 재생성 시에도 같은 앱 프로세스의 세션과 최대 512KiB 출력 기록에 다시 붙습니다. 알림의 **모두 연결 끊기**로 전체 세션을 종료할 수 있습니다. 알림 권한을 거부하면 일반 알림 서랍에 알림이 보이지 않을 수 있습니다. OS 프로세스 종료·강제 종료·네트워크 단절 후 자동 재접속은 아직 지원하지 않습니다.

| 단축키 | 동작 |
| --- | --- |
| Ctrl+Shift+T | 새 연결 |
| Ctrl+Tab / Ctrl+Shift+Tab | 다음 / 이전 세션 |
| Ctrl+Shift+W | 현재 세션 종료 확인 |
| Ctrl+Shift+L | 서버 목록 접기/열기 |
| Ctrl+Shift+C / V | 복사 / 붙여넣기 |
| Ctrl+플러스 / 마이너스 | 글자 크기 |

Ctrl+C 등 일반 Ctrl 조합은 원격 터미널로 전달합니다. 터치 Ctrl/Alt 버튼은 다음 입력 한 번에 적용됩니다. 뒤로 가기는 열린 대화상자/서버 서랍을 닫고, 그 외에는 앱을 백그라운드로 이동합니다.

## 보안 및 데스크톱과의 차이

WebView는 앱에 번들된 리소스만 열고, 원격 탐색·파일 URL·외부 리소스 로드를 차단합니다. SSH 연결은 WebView가 아닌 네이티브 서비스가 담당합니다. 개인키 파일은 Android 문서 선택기를 통해 읽으며 광범위한 저장소 접근 권한을 요구하지 않습니다. Bouncy Castle은 Android에서 JSch의 EdDSA/Curve25519 알고리즘 구현을 제공하기 위해 포함합니다.

Android 저장소는 **기기 잠금과 앱 샌드박스**를 보안 경계로 사용하며, 데스크톱 마스터 비밀번호 잠금과 별도입니다. 앱 자체 잠금 UI는 없습니다. 호스트 신뢰 기록은 앱 전용 `known_hosts` 파일에 공개키와 주소를 평문으로 보관합니다. 자동 백업·기기 전송을 제외합니다. 앱 제거 시 기기 키와 저장된 서버가 삭제됩니다. 데스크톱 `.btbackup` 파일 가져오기는 아직 지원하지 않습니다. Git 동기화는 데스크톱과 같은 볼트 암호화 형식을 사용합니다.

아직 포팅하지 않은 데스크톱 기능: Telnet, USB 시리얼, 로컬 PTY, 점프 호스트/프록시, 포트 포워딩, 분할 패널·동시 입력, 데스크톱 백업 가져오기/내보내기, AWS·PuTTY 가져오기, 지표, 자동 재접속. Android 로컬 셸은 PC 셸과 동일한 환경을 제공할 수 없습니다.

## Git 동기화

서버 목록 하단의 **Git 동기화**에서 설정합니다. Android에 Git 실행 파일이나 공용 `~/.ssh` 폴더를 만들 필요는 없습니다.

1. PC에서 사용하던 **같은 Git URL과 브랜치**를 입력하고 자동 동기화를 켜서 저장합니다. HTTPS와 SSH(`git@host:repo.git`, `ssh://git@host:port/path`)를 지원합니다.
2. HTTPS는 Git 사용자명과 쓰기 권한이 있는 토큰을 입력합니다. SSH는 Git 전용 개인키 파일을 선택하고 필요한 키 암호를 입력합니다. SSH 비밀번호 인증도 지원합니다. 최초 접속 시 Git 서버의 SHA-256 호스트 지문을 확인하며 바뀐 키는 거부합니다.
3. 기존 원격 볼트가 있으면 **원격 가져오기**를 선택하고 **PC에서 사용하던 볼트 마스터 비밀번호**를 입력합니다. Git 토큰·SSH 키 암호와는 별개입니다. 가져오기는 Android 서버 목록을 교체합니다.
4. 빈 저장소/브랜치에서 시작하면 8자 이상의 새 마스터 비밀번호를 정하고 **지금 동기화**를 누릅니다. 새 Android 볼트에는 복구 코드 생성 UI가 없으므로 비밀번호를 따로 보관하세요. 다른 PC에서는 해당 비밀번호로 원격 볼트를 가져올 수 있습니다.
5. 로컬과 원격이 모두 바뀌면 **충돌**로 멈춥니다. 원격 가져오기 또는 로컬 올리기를 선택하세요. 선택 후 데이터가 다시 바뀌면 재확인을 요구합니다. 강제 푸시와 자동 병합은 하지 않습니다.

앱 화면이 활성화되면 원격 상태를 확인하고, 서버 추가·수정·삭제 후 약 1초 뒤에 변경을 올립니다. 활성 상태에서는 약 60초마다 원격을 확인하고 네트워크 오류는 약 30초 후 재시도합니다. 앱이 백그라운드이거나 종료된 동안 주기적 Git 동기화를 보장하지 않습니다. **지금 동기화**로 수동 실행할 수 있습니다.

Git에는 `brightterm.vault.json`만 추가/갱신하며 기존 저장소의 다른 파일과 커밋 기록을 유지합니다. 서버 주소·이름·폴더·자격 증명은 전체 암호화되고, Git 인증 토큰/키와 기기별 신뢰 기록은 동기화 대상에 포함하지 않습니다. 로컬에는 Keystore로 암호화한 파일에 Git 설정·인증·동기화 상태·볼트 키를 함께 저장합니다. 마스터 비밀번호 자체는 저장하지 않으므로 원격 볼트 키가 바뀌면 다시 입력해야 합니다. Git 기록에 남은 이전 암호문은 삭제되지 않습니다.

데스크톱의 폴더, SSH 외 프로토콜, 공유 자격 증명 및 Android 미지원 필드는 보존합니다. Android에는 SSH 연결만 표시하며 점프 호스트·프록시·포워딩·별도 인코딩가 필요한 연결은 직접 연결하지 않고 미지원 안내를 표시합니다. 공유 계정의 다른 서버를 바꾸지 않도록 Android에서 자격 증명을 수정하면 해당 서버에 별도 자격 증명을 만듭니다.

원격 가져오기 전 상태는 앱 내부 `sync-backups/`에 기기 키로 암호화해 최대 10개 보관합니다. **마지막 가져오기 전 로컬 데이터 복원**으로 복원할 수 있으며, 복원 후에는 자동 동기화를 끕니다. 현재 데이터도 복원 전에 백업합니다. 앱 제거 또는 기기 키 삭제 시 이 백업 역시 사용할 수 없습니다.

## 검증

```sh
npm run android:lint
# 격리된 에뮬레이터를 부팅하고 APK를 설치한 뒤 실행합니다. 개인 기기에는 실행하지 않습니다.
ANDROID_SERIAL=emulator-5554 npm run test:android
# 이 테스트는 격리된 에뮬레이터의 BrightTerm 데이터를 초기화합니다.
ANDROID_SERIAL=emulator-5554 npm run test:android:git-sync
node --test test/android-run.test.mjs
```

E2E는 임시 SSH 서버와 키를 생성하고 에뮬레이터에만 adb reverse/forward를 설정합니다. 비밀번호·키 인증, UTF-8 입출력, Ctrl+C, SFTP 목록, 암호화 저장 파일, 저장된 자격 증명 재사용, 호스트 키 변경 거부, 백그라운드 유지, 휴대폰/넓은 창 레이아웃 및 재연결 없는 PTY 크기 변경을 확인합니다. 테스트 후 화면 크기·밀도를 복구하고 테스트 연결을 종료합니다. 스크린샷은 `android/build/screenshots/`에 생성합니다.

Git E2E는 임시 bare 저장소와 테스트 SSH Git 서버로 데스크톱 호환 암호화 가져오기/내보내기, 잘못된 비밀번호, 비밀번호·개인키 Git 인증, 자동 푸시/풀, 충돌·동시 푸시, 암호문/스키마 손상, 백업 복원, 프로세스 재시작, 오프라인 복구, 빈 브랜치 초기화를 확인합니다. 배포 스크립트 테스트는 다중 기기 선택과 설치/실행 실패를 검증합니다.

연결된 Samsung SM-S938N(Android API 37)에서 `make android-run`을 통한 APK 설치·실행과 기본 UI 로드를 확인했습니다. Samsung DeX 실기기 및 Android 문서 선택기를 통한 실제 파일 전송은 별도 확인이 필요합니다. 에뮬레이터의 넓은 창 검증은 Samsung 펌웨어·외부 디스플레이 검증을 대체하지 않습니다. 수동 확인: DeX 연결/해제, 창 최소화/최대화·분할 화면, Bluetooth/USB 키보드, IME 열기/닫기, 개인키 선택, SFTP 업로드/다운로드, 네트워크 변경과 장시간 백그라운드.

구성: `MainActivity.java`(로컬 WebView·파일 선택·네이티브 브리지), `TerminalService.java`(SSH·호스트 신뢰·SFTP·세션 유지), `Vault.java`(암호화 저장·백업), `GitSync.java`(동기화 상태·충돌), `GitRepository.java`(Git 전송), `SyncCrypto.java`·`SyncSnapshot.java`(데스크톱 호환 볼트), `assets/`(반응형 UI). xterm과 fit addon은 npm lockfile에 고정된 데스크톱 의존성을 빌드 시 복사합니다. 라이선스는 앱의 정보 창과 [제3자 고지](THIRD_PARTY_NOTICES.txt)에서 확인할 수 있습니다.
