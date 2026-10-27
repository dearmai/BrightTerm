# BrightTerm Android

휴대폰과 Samsung DeX용 네이티브 Android SSH 클라이언트입니다. Electron 런타임 대신 Java SSH 서비스와 로컬 WebView의 xterm.js를 사용합니다. 데스크톱 앱과 독립적으로 빌드합니다.

## 빌드와 설치

요구 사항: **Android 11/API 30 이상**, JDK 17, Node.js 22.12+, Android SDK 36 및 SDK Platform Tools. Android Studio에서 이 `android/` 폴더를 열거나 저장소 루트에서 실행하세요.

```sh
npm ci --ignore-scripts
# ANDROID_HOME을 SDK 경로로 지정하거나 android/local.properties에 sdk.dir을 설정합니다.
npm run android:build
adb -s <기기_ID> install -r android/app/build/outputs/apk/debug/app-debug.apk
```

`npm ci --ignore-scripts`는 Android 빌드에 필요 없는 Electron/node-pty 설치 작업을 건너뜁니다. 빌드에는 Gradle wrapper가 포함되며 SDK/Java 경로는 저장소에 고정하지 않습니다. APK는 개발용 debug 서명입니다. 스토어 배포용 서명·AAB와 게시 작업은 포함하지 않습니다.

## 사용 가능한 기능

- SSH 비밀번호, keyboard-interactive의 단일 비밀번호 질문, PEM/OpenSSH 개인키 및 키 암호 인증. OTP/다단계 challenge UI는 아직 지원하지 않습니다.
- 최초 접속 시 SHA-256 호스트 키 지문을 확인하고 기기에 저장합니다. 바뀐 호스트 키는 자동 교체하지 않고 거부합니다. 현재 신뢰 기록을 편집하는 UI는 없습니다.
- 서버 목록·비밀번호·개인키·키 암호를 Android Keystore의 기기별 AES-GCM 키로 암호화하여 원자적으로 저장합니다. 기존 서버의 비밀 필드를 비우면 저장된 값을 유지합니다. 삭제 후 재등록하면 자격 증명을 교체할 수 있습니다.
- 여러 SSH 세션, UTF-8/xterm-256color, 터치 Esc/Tab/Ctrl/Alt/방향키, 선택 복사와 붙여넣기, 마우스 우클릭, 하드웨어 키보드 단축키, 글자 크기 변경.
- SFTP 폴더 탐색과 Android 시스템 파일 선택기를 통한 업로드·다운로드. 업로드는 확인 후 원격 파일을 덮어씁니다. 전송 중 오류/연결 종료 시 일부 파일이 남을 수 있습니다. 이어받기·진행률·작업 취소 UI는 아직 없습니다.
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

Android 저장소는 **기기 잠금과 앱 샌드박스**를 보안 경계로 사용하며, 데스크톱 마스터 비밀번호 잠금과 별도입니다. 앱 자체 잠금 UI는 없습니다. 호스트 신뢰 기록은 앱 전용 `known_hosts` 파일에 공개키와 주소를 평문으로 보관합니다. 자동 백업·기기 전송을 제외합니다. 앱 제거 시 기기 키와 저장된 서버가 삭제됩니다. 데스크톱 `.btbackup` 및 볼트 형식과 호환되지 않습니다.

아직 포팅하지 않은 데스크톱 기능: Telnet, USB 시리얼, 로컬 PTY, 점프 호스트/프록시, 포트 포워딩, 분할 패널·동시 입력, Git 동기화, 데스크톱 백업 가져오기/내보내기, AWS·PuTTY 가져오기, 지표, 자동 재접속. Android 로컬 셸은 PC 셸과 동일한 환경을 제공할 수 없습니다.

## 검증

```sh
npm run android:lint
# 격리된 에뮬레이터를 부팅하고 APK를 설치한 뒤 실행합니다. 개인 기기에는 실행하지 않습니다.
ANDROID_SERIAL=emulator-5554 npm run test:android
```

E2E는 임시 SSH 서버와 키를 생성하고 에뮬레이터에만 adb reverse/forward를 설정합니다. 비밀번호·키 인증, UTF-8 입출력, Ctrl+C, SFTP 목록, 암호화 저장 파일, 저장된 자격 증명 재사용, 호스트 키 변경 거부, 백그라운드 유지, 휴대폰/넓은 창 레이아웃 및 재연결 없는 PTY 크기 변경을 확인합니다. 테스트 후 화면 크기·밀도를 복구하고 테스트 연결을 종료합니다. 스크린샷은 `android/build/screenshots/`에 생성합니다.

Samsung DeX 실기기 및 Android 문서 선택기를 통한 실제 파일 전송은 별도 확인이 필요합니다. 에뮬레이터의 넓은 창 검증은 Samsung 펌웨어·외부 디스플레이 검증을 대체하지 않습니다. 수동 확인: DeX 연결/해제, 창 최소화/최대화·분할 화면, Bluetooth/USB 키보드, IME 열기/닫기, 개인키 선택, SFTP 업로드/다운로드, 네트워크 변경과 장시간 백그라운드.

구성: `MainActivity.java`(로컬 WebView·파일 선택·네이티브 브리지), `TerminalService.java`(SSH·호스트 신뢰·SFTP·세션 유지), `Vault.java`(암호화 저장), `assets/`(반응형 UI). xterm과 fit addon은 npm lockfile에 고정된 데스크톱 의존성을 빌드 시 복사합니다. 라이선스는 앱의 정보 창과 [제3자 고지](THIRD_PARTY_NOTICES.txt)에서 확인할 수 있습니다.
