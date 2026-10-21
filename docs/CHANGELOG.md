# 변경 내역

[← README](../README.md)

## 다음 버전 (미배포, 1.2.3 이후)

### 세션 유지(tmux) — 이어 쓸 세션 고르기

같은 서버를 분할로 두 번 열면 두 창이 한 tmux 세션에 붙어 똑같은 화면을 보여 주던 문제를 고치면서, 접속할 때 어느 세션에 붙을지 고를 수 있게 했습니다.

- 세션 유지가 켜진 **SSH 서버**에 접속하면 셸을 열기 전에 그 서버의 tmux 세션 목록을 봅니다. 그 서버의 세션은 `bt-<별칭>`과 새로 만든 `bt-<별칭>-2`, `-3` …입니다(tmux 세션 이름을 정했으면 그 이름이 기준).
- 이전 세션이 있으면 **선택 창**이 뜹니다.
  - 세션마다 실행 중인 프로그램, 마지막 활동, 만든 때를 보여 줍니다.
  - 다른 창(이 앱이나 다른 PC)에서 보고 있는 세션은 **다른 창에서 사용 중**으로 표시합니다.
  - 기본 선택은 아무도 보고 있지 않은 최근 세션입니다. 모두 사용 중이면 **새 세션**이 선택됩니다.
  - 🗑 로 세션을 끝낼 수 있습니다(`tmux kill-session`, 확인 후).
  - 취소하면 접속하지 않습니다. Enter 로 다시 시도할 수 있습니다.
- 이전 세션이 없으면 묻지 않고 새로 만듭니다.
- 묻지 않는 경우:

| 상황 | 붙는 세션 |
| --- | --- |
| 연결이 끊겨 자동 재접속 | 그 창이 쓰던 세션 |
| 앱을 다시 켜 탭·분할 복원 | 그 창이 쓰던 세션(세션 이름을 작업 공간에 함께 저장). 이전 버전에서 저장한 배치는 쉬는 세션 |
| 폴더 전체를 그리드로 열기 | 서버마다 아무도 보고 있지 않은 최근 세션, 없으면 새 세션 |

- 창 머리의 **유지** 표시에 세션 번호가 붙습니다(예: `유지 2`). 마우스를 올리면 세션 이름이 보입니다.
- 로컬 터미널(macOS·Linux·WSL)은 예전처럼 세션 하나에 바로 붙습니다.

### 세션 유지 — 서버 확인과 tmux 설치

- 서버 편집의 세션 유지 옆 **서버 확인**: 접속해서 tmux 버전, 배포판, root·sudo 여부, 패키지 관리자를 확인합니다. 저장하기 전 설정으로도 확인할 수 있습니다.
- tmux 가 없으면 배포판에 맞는 설치 명령을 보여 줍니다.

| 패키지 관리자 | 설치 명령 (root 가 아니면 앞에 `sudo`) |
| --- | --- |
| apt | `apt-get update && apt-get install -y tmux` |
| dnf / yum | `dnf install -y tmux` / `yum install -y tmux` |
| zypper | `zypper --non-interactive install tmux` |
| apk | `apk add tmux` |
| pacman | `pacman -S --noconfirm tmux` |
| brew (macOS) | `brew install tmux` |

- **저장하고 터미널에서 설치**: 서버를 저장하고 새 탭에서 접속해 설치 명령을 입력해 줍니다. 이 탭은 세션 유지 없이 열리며, sudo 비밀번호는 터미널에서 직접 입력합니다. 앱이 sudo 비밀번호를 받거나 저장하지 않습니다. **복사** 버튼도 있습니다.
- root 도 아니고 sudo 도 없는 계정이면 서버 관리자에게 설치를 요청하도록 안내합니다.
- 접속했는데 서버에 tmux 가 없으면 터미널에 서버 확인 메뉴를 안내합니다.

### 세션 유지 — 찾기 쉽게

- 세션 유지 스위치를 서버 편집 **고급** 탭에서 **기본** 탭으로 옮겼습니다.
- 사이드바에서 세션 유지가 켜진 서버 이름 옆에 겹친 네모 아이콘을 표시합니다.

### SSH 키 등록

비밀번호로 로그인하는 서버에 이 PC 의 공개키를 등록합니다(`ssh-copy-id` 와 같은 일).

- 대상: 인증 방식이 **비밀번호** 또는 **매번 묻기**인 SSH 서버. 사이드바 항목에 마우스를 올리면 🔑 버튼이, 우클릭 메뉴에 **SSH 키 등록…**이 나옵니다.
- 등록하기 전에 `~/.ssh/*.pub` 목록에서 키를 고릅니다. 파일 이름, 종류, 주석, SHA256 지문과 어느 서버(`user@host`)의 `~/.ssh/authorized_keys` 에 넣을지 보여 줍니다.
  - ed25519 → ecdsa → rsa 순으로 정렬하고 첫 키를 미리 고릅니다.
  - 짝이 되는 개인 키가 없는 `.pub` 은 **개인 키 없음**으로 표시합니다(등록해도 이 PC 에서는 그 키로 로그인할 수 없음).
- 접속은 평소와 같습니다. 저장된 비밀번호를 쓰고, 없으면 묻고, 호스트 키 확인과 점프 호스트도 그대로 거칩니다.
- **이미 등록된 키면 아무것도 바꾸지 않습니다.** 주석이 다르거나 앞에 `from="..."` 같은 옵션이 붙어 있어도 키 본문이 같으면 같은 키로 봅니다.
- 서버에 `~/.ssh` 나 `authorized_keys` 가 없으면 권한 700/600 으로 만들고, 파일 끝에 줄바꿈이 없으면 보충해 마지막 키와 붙지 않게 합니다. SELinux 서버는 `restorecon` 으로 보안 문맥을 맞춥니다.
- 등록한 뒤에도 서버 설정은 비밀번호 로그인 그대로입니다.

### 터미널 링크(OSC 8) 열기

Claude Code 의 `/login` 주소처럼 프로그램이 링크로 출력한 주소(OSC 8 하이퍼링크)를 눌러 확인해도 브라우저가 열리지 않던 문제를 고쳤습니다.

- 그냥 클릭: 앱 확인 창에 **주소 전체**를 보여 주고 **열기**를 누르면 기본 브라우저로 엽니다. 링크로 보이는 글자와 실제 주소가 다를 수 있어서 확인합니다.
- Ctrl+클릭(macOS ⌘+클릭): 묻지 않고 바로 엽니다. 화면의 일반 URL 과 같습니다.
- `http`/`https` 주소만 엽니다.

### Windows 계정 잠금 해제 기본 켜기

- Windows 에서 처음 볼트를 만들 때 **Windows 계정으로 잠금 해제** 체크가 기본으로 켜져 있습니다. 볼트 키를 `safeStorage`(DPAPI)로 암호화해 이 PC 에만 보관하고, 앱을 켜면 자동으로 잠금이 풀립니다. Git 동기화·백업에는 들어가지 않습니다.
- 체크를 풀고 만들 수 있고, 나중에 **설정 → 보안·계정**에서 켜고 끌 수 있습니다.
- 이미 만든 볼트의 설정은 바꾸지 않습니다.

### 의존성

- `npm audit fix`: vite 7.3.7, source-map-js 1.2.2, http-cache-semantics 4.3.0 (high 3건), electron-builder 26.18.0.
- 남은 moderate 8건은 electron-builder → @electron/get → global-agent → roarr → **sprintf-js** 경로입니다. sprintf-js 의 수정 버전이 아직 없고, 빌드할 때 Electron 을 내려받는 데만 쓰여 앱에 포함되지 않습니다. `npm audit fix --force` 는 electron-builder 를 26.5.0 으로 내려 적용하지 않았습니다.

### 서버 쪽 동작 메모 (개발용)

- 서버에서 실행하는 스크립트(키 등록, tmux 목록, 서버 확인)는 `sh -s` 표준입력으로 보냅니다. 로그인 셸이 fish·csh 여도 되지만 `sh` 가 없는 서버(Windows OpenSSH 등)에서는 실패하고 오류를 보여 줍니다.
- 관련 코드: `src/main/persist.ts`(tmux 이름·목록·확인 스크립트), `src/main/transports/ssh.ts`(`execSh`, 세션 고르기), `src/main/sshKeys.ts`(키 목록·등록, 서버 확인), `src/renderer/src/components/UiRequestDialog.tsx`(세션 선택 창), `SshKeyDialog.tsx`, `HostEditor.tsx`.

## 차후 과제

### Windows Hello 로 볼트 잠금 해제 확인

- 현재: Windows 에서 **설정 → 보안·계정 → Windows 계정으로 잠금 해제**를 켜면 볼트 키를 Electron `safeStorage`(DPAPI)로 암호화해 이 PC 에만 보관합니다(Git 동기화·백업에는 들어가지 않음). 같은 Windows 계정으로 로그인해 있으면 **추가 확인 없이** 열립니다.
- 목표: macOS 의 Touch ID 처럼, `safeStorage` 로 볼트 키를 꺼내기 전에 Windows Hello(PIN·지문·얼굴) 확인을 받습니다. 확인을 취소하거나 Hello 를 쓸 수 없으면 마스터 비밀번호로 엽니다.
- 방법 후보: Electron 에 Windows Hello API 가 없으므로 WinRT `Windows.Security.Credentials.UI.UserConsentVerifier`(`CheckAvailabilityAsync`, `RequestVerificationAsync`)를 부릅니다.
  - PowerShell 로 호출: 추가 모듈이 필요 없지만 PowerShell 시작에 1~2초가 걸리고, 확인 창이 앱 창 뒤에 뜨지 않게 처리해야 합니다.
  - 네이티브 모듈: 빠르고 창 연결이 자연스럽지만 빌드·서명 대상이 늘어납니다.
- 관련 코드: `src/main/vault.ts` 의 `tryOsUnlock`(macOS 는 여기서 `promptTouchID`), 설정 문구는 `src/renderer/src/platform.ts` 의 `osUnlockText`.
