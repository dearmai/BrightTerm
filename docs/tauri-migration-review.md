# Tauri 전환 검토

검토일: 2026-11-12

## 결론과 현재 결정

BrightTerm의 경량화와 장기적인 백엔드 구조 개선을 위해 Tauri 전환을 검토할 가치는 있다. 다만 전면 재작성에 앞서 기존 React 화면을 유지한 로컬 터미널 PoC로 효과와 호환성을 확인하는 방식을 권장한다.

현재 결정은 검토 내용만 문서로 보관하는 것이다. Tauri 도입, PoC 구현, 의존성 추가나 런타임 변경은 이번 작업에 포함하지 않는다.

## 현재 구조에서 재사용할 수 있는 부분

- 화면은 React, 상태 관리는 Zustand, 터미널 표시는 xterm.js를 사용한다.
- `src/renderer/src/api.ts`와 `src/preload/index.ts`가 화면과 Electron 백엔드 사이의 통신 경계를 구성한다. 이 경계 뒤에 Tauri 어댑터를 두면 화면 변경 범위를 줄일 수 있다.
- UI와 공통 타입·순수 로직은 재사용 후보지만, Electron·Node.js API에 의존하는 코드는 별도 이식이 필요하다.

## 기대 효과와 비용

Tauri는 운영체제의 WebView를 사용한다. Chromium을 앱에 동봉하는 부담을 줄일 수 있지만, BrightTerm의 실제 설치 용량·메모리·시작 시간 개선 폭은 측정 전에는 확정할 수 없다.

| 영역 | 전환 시 필요한 작업 |
| --- | --- |
| React·xterm.js UI | 기존 화면 재사용, WebGL·한글 입력·붙여넣기·폰트 표시 검증 |
| Electron IPC | 명령 호출·이벤트·연속 터미널 출력 전달을 Tauri 방식으로 연결 |
| 로컬 터미널 | `node-pty` 대체, PTY 입출력·리사이즈·프로세스 종료 처리 |
| SSH·SFTP·포트 포워딩 | `ssh2` 기반 기능 이식, 인증·점프 호스트·프록시·공유 포워딩 동작 검증 |
| 시리얼·Telnet | 통신 구현과 인코딩·종료·재접속 동작 검증 |
| 볼트·OS 잠금 해제 | 기존 scrypt·AES-256-GCM 저장 형식과 백업·Git 동기화 호환 유지, `safeStorage` 대체 |
| OS 연동·배포 | 창·클립보드·파일 선택·외부 실행·서명·설치 패키지 재구성 |

현재 백엔드는 단순한 창 관리 외에 세션, 자격 증명, 파일 전송, 포워딩 등을 담당한다. Electron 외피만 교체하는 작업으로 보기 어렵다. 특히 기존 볼트 파일을 읽는 것과 OS에 묶인 잠금 해제 정보를 옮기는 것은 별도 문제로 다뤄야 한다.

## 플랫폼과 PRoot 고려 사항

Tauri는 Windows에서 WebView2, macOS에서 WKWebView, Linux에서 WebKitGTK를 사용한다. 현재 Chromium 기반 동작이 동일하게 유지되는지 각 운영체제에서 확인해야 한다. 터미널은 대량 출력, 입력기 조합, 키 입력, 스크롤과 WebGL 렌더링을 우선 점검한다.

기존 Ubuntu 24.04.5 / aarch64 / PRoot-Distro 환경에서 Electron 앱이 `--no-sandbox`로 실행된 것은 사용자 확인 결과다. 이것만으로 Tauri가 해당 환경에서 더 잘 실행된다고 판단할 수 없다. WebKitGTK의 의존성, 그래픽 및 프로세스 실행 호환성은 실제 장비에서 따로 검증해야 한다. PRoot 시작 오류 해결만을 목적으로 전면 재작성을 결정하지 않는다.

## 권장 검증 순서

1. 기존 React 화면을 Tauri에서 띄우고 API 어댑터를 연결한다.
2. 로컬 터미널 하나를 구현한다. 한글 조합 입력, 대량 출력, 리사이즈, 붙여넣기, 세션 종료 후 프로세스 정리를 검증한다. 연속 출력 전달에는 Tauri Channel 등 스트리밍 수단을 검토한다.
3. 동일한 작업 조건에서 Electron과 패키지 크기, 배포 시 필요한 시스템 의존성, 메모리, 시작 시간과 입력 응답성을 비교한다. WebView 관련 프로세스도 측정 범위에 포함한다.
4. Windows·macOS·ARM64 Linux 및 사용자 PRoot 환경에서 실행과 핵심 터미널 기능을 각각 확인한다.
5. 결과가 목표에 부합하면 SSH·SFTP부터 순차 이식하고, 기존 볼트·백업·동기화 데이터의 호환성을 검증한 뒤 나머지 기능을 옮긴다.

기존 Electron 버전은 비교와 회귀 확인의 기준으로 유지한다. 전환 여부는 PoC 측정 결과와 지원 환경에서의 기능 검증을 바탕으로 결정한다.

## Node 백엔드를 유지하는 대안

Tauri는 별도 실행 파일을 sidecar로 포함할 수 있어 Node 백엔드를 별도 프로세스로 유지하는 이행 방식을 고려할 수 있다. 다만 기존 백엔드의 Electron 의존성을 분리해야 하며 Node 런타임과 네이티브 모듈 배포, 프로세스 간 통신·종료 관리 부담도 남는다. 최종 구조로 채택하기 전에 경량화 이득과 유지 비용을 비교한다.

## 확인한 내용과 미검증 범위

- 직접 확인: 저장소의 의존성, 화면 API 경계, Electron preload, PTY·시리얼·볼트 및 xterm.js 관련 코드, 배포 설정. Tauri 공식 문서의 프로세스·WebView·통신·sidecar 설명.
- 기존 사용자 확인: PRoot에서 Electron 앱이 `--no-sandbox`로 실행됨.
- 미검증: Tauri 빌드·실행, Rust 라이브러리 선정, 기능 이식, 기존 데이터 호환, 모든 대상 OS 및 PRoot 실행, 성능·용량 비교. 본 문서는 구현 완료나 전환 확정 기록이 아니다.

## 참고 자료

- [Tauri 프로세스 구조](https://v2.tauri.app/concept/process-model/)
- [플랫폼별 WebView](https://v2.tauri.app/reference/webview-versions/)
- [Rust에서 프런트엔드 호출 및 Channel](https://v2.tauri.app/develop/calling-frontend/)
- [외부 실행 파일 및 sidecar](https://v2.tauri.app/develop/sidecar/)
