# 작업내역서

## 2026-11-12 — 서버 목록 ~/.ssh/config 동기화·저장된 비밀번호 보기

### 요청 및 변경

- 사용자가 서버 목록을 OpenSSH .ssh/config 에 동기화하고 부가 정보는 주석으로 관리하며, 서버별로 대상 여부를 고르게(기본 대상 아님) 요청했다("openssl"은 OpenSSH로 이해). 이어서 다른 PC도 동일하게 하고, 앱 설정에서 기능을 끄면 자동 동기화를 하지 않되 서버별 수동 반영 버튼을 두며, 앱 설정 기본값은 해제로 해 달라고 요청했다. 작업 중 저장된 서버 비밀번호를 UI 폼에서 평문으로 볼 수 있게 해 달라는 요청(볼트 잠금 해제 상태)도 받았다.
- src/shared/sshConfig.ts: 대상 SSH 서버를 Host 블록으로 만든다. HostName·Port·User·ProxyJump(점프 서버가 대상이면 그 이름, 아니면 user@host:port, 직접 입력한 베스천 포함)·ServerAliveInterval·Local/RemoteForward를 옮기고 별칭·그룹 경로·태그·환경·인증 방식·인코딩·프록시·접속 후 명령 줄 수·메모·BrightTerm id를 주석으로 남긴다. 주석의 줄바꿈·제어 문자는 공백으로 바꿔 옵션 주입을 막는다. Host 이름은 직접 지정(공백·와일드카드 등 불가) 또는 별칭에서 만들고 겹치면 -2를 붙인다. 비밀번호·개인 키는 쓰지 않는다.
- ~/.ssh/config 에는 표시 주석과 Include brightterm.conf 두 줄만 맨 앞에 넣고 서버는 ~/.ssh/brightterm.conf 에 쓴다. 본문에 직접 넣으면 사용자의 전역 옵션이 Host 블록 소속으로 바뀌거나 앞의 Host * 값에 가려지기 때문이다. 줄바꿈 형식을 유지하고, 심볼릭 링크는 대상 파일을 바꾸며, 임시 파일 후 이름 바꾸기로 쓴다. 반영된 서버가 없으면 앱이 만든 파일과 두 줄만 걷어 낸다.
- src/main/sshConfigSync.ts: 자동 동기화(설정 → 연결, PC별, 기본 꺼짐)를 켠 PC에서는 서버·그룹 변경(Git 동기화 포함)과 시작 시, 설정을 다시 켤 때 전체를 맞춘다. 끈 PC에서는 아무것도 자동으로 쓰거나 지우지 않는다. 수동 반영은 기존 파일에서 BrightTerm id 주석으로 해당 서버 블록만 추가·갱신·삭제하고 다른 블록(다른 PC가 쓴 것, 손으로 넣은 것)은 유지하며, 같은 Host 이름의 블록은 교체한다.
- 서버 편집 → 고급: SSH 서버에만 .ssh/config 동기화 스위치(기본 끔)·Host 이름·예상 ssh 이름·키 인증 안내·반영 상태를 보이고, 자동 동기화가 꺼진 PC에서는 config에 반영 / 다시 반영 / config에서 빼기 버튼을 보인다. 서버의 대상 여부는 서버 정보와 함께 Git 동기화된다.
- 저장된 비밀번호 보기: 서버 편집의 비밀번호·키 암호 입력 5곳(서버, 베스천, 프록시)에 눈 버튼을 두어 볼트에서 읽어 평문으로 보이고 다시 가린다. 공유 계정 선택 모드에서는 읽기 전용으로 보인다. 읽어 온 값을 그대로 저장하면 볼트에 다시 쓰지 않는다(공유 계정을 쓰는 서버에서 새 계정으로 갈라지는 문제 방지).
- README 기능 표와 테스트 안내를 갱신했다. 커밋은 04c6a96(.ssh/config 동기화), f449da2(비밀번호 보기)로 나눴고 HostEditor.tsx·styles.css는 기능별로 나눠 스테이징했다. main에 커밋하고 origin/main으로 푸시한다.

### 직접 검증한 결과

- npm run typecheck 통과, npm run build 성공. 단위 테스트 98개 중 94 통과·0 실패·4 건너뜀(ssh-config 7개 추가: 대상 선택, Host 이름·중복, 옵션·주석·비밀 비기록, 점프 서버 주소화·IPv6, 주석 주입 방지, Include 추가/제거·CRLF 유지, 수동 병합).
- node test/e2e-ssh-config-podman.mjs 통과(임시 ~/.ssh, podman OpenSSH, Git for Windows OpenSSH 10.3 클라이언트): 기본값 꺼짐이면 쓰지 않음, 자동 켜기 후 켠 서버만 기록·사용자 config 보존·맨 앞 Include, UI 스위치·Host 이름 저장, ssh -G 해석(서버별 User가 사용자 Host * 보다 우선, 사용자 전역 옵션 유지), ProxyJump 경유 실제 로그인, 끄면 제거·모두 끄면 원래 config 복원, 자동 끔 상태에서 저장해도 쓰지 않음·버튼으로 반영해 실제 로그인·버튼으로 빼서 원래 config 복원.
- Windows 기본 OpenSSH 9.5에서 생성 파일(한글 주석·ProxyJump·LocalForward)을 절대 경로 Include로 읽어 ssh -G 결과를 확인했다. 이 PC의 실제 ~/.ssh ACL은 본인·SYSTEM·Administrators만이라 새 파일도 권한 검사를 통과할 조건이다.
- 스테이징한 .ssh/config 커밋 트리만 임시 폴더로 꺼내 tsc와 ssh-config 단위 테스트를 통과시켰다.
- node test/e2e-secret-reveal.mjs 통과: 보기·가리기, 그대로 저장 시 볼트 항목·updatedAt 변화 없음, 공유 계정 읽기 전용 보기와 계정 유지, 공유 계정을 '이 서버 전용'으로 보고 저장해도 계정을 새로 만들지 않음, 고친 값은 정상 저장.
- 회귀: e2e-session-log, e2e-connect-log 통과. e2e-ssh-startup은 테스트 내부 가짜 서버의 로컬 sh 파이프 EPIPE로 실패했고, 변경 전 HEAD(2f71dd6) 작업 폴더에서도 같은 오류로 실패해 이 Windows 환경의 기존 문제로 기록한다.

### 검증 범위

- 사용자의 실제 ~/.ssh 에는 쓰지 않았다. Windows 기본 OpenSSH가 상대 경로 Include를 실제 ~/.ssh 기준으로 읽는 동작은 이 환경에서 직접 확인하지 못했다(Git for Windows OpenSSH로는 HOME 기준 해석을 확인). macOS·Linux 실행, 키 인증 서버의 ssh 접속(IdentityFile·agent는 사용자 지정), 실제 다른 PC 간 Git 동기화는 미검증이다.
- 동기화는 앱 → 파일 단방향이다. brightterm.conf 를 직접 고치면 다음 반영 때 덮어쓴다.
- 비밀번호 보기는 README에 따로 적지 않았다. 설치 패키지는 생성하지 않았다.

## 2026-11-12 — 제3자 고지 생성 결과를 OS와 무관하게 고정

### 요청 및 변경

- 작업 트리에 남은 THIRD_PARTY_NOTICES.txt 수정의 커밋 요청에 대해 확인한 결과, Windows에서 ssh2의 선택적 네이티브 의존성 cpu-features·buildcheck가 설치되지 않아 재생성 시 두 고지가 빠지는 변경(26be069에서 의도적으로 추가한 항목 삭제)이었다. 사용자의 gitignore 문의에는 README 링크·법적 고지·스크립트의 커밋 지침 때문에 추적을 유지하고 생성기를 결정적으로 만드는 방안을 제안했고, 사용자가 수정을 요청했다.
- scripts/gen-notices.mjs: node_modules에서 찾지 못한 의존성은 package-lock.json에서 npm 해석 순서로 찾아 이름·버전과 하위 의존성을 얻는다. 라이선스 표기·전문은 기존 THIRD_PARTY_NOTICES.txt의 같은 이름·버전 항목을 원문 줄바꿈 그대로 유지한다. 기존 고지에도 없으면 파일을 쓰지 않고 실패(exit 1)하며 해당 패키지가 설치되는 OS에서 생성하라고 안내한다.
- 로컬의 두 항목 삭제 변경은 되돌렸다. 고지 파일 자체는 바뀌지 않으므로 생성기만 커밋한다. main에 커밋하고 origin/main으로 푸시한다.

### 직접 검증한 결과

- Windows(두 패키지 미설치)에서 node scripts/gen-notices.mjs 실행 결과가 HEAD의 THIRD_PARTY_NOTICES.txt와 동일했다(git status 변경 없음, 44개). 두 번 연속 실행해도 동일했다.
- 기존 고지의 cpu-features 버전을 임시로 바꿔 항목이 없는 상황을 만들면 오류 메시지와 exit 1로 멈추고 파일을 쓰지 않았다. 확인 후 원복했다.

### 검증 범위

- macOS·Linux(두 패키지 설치)에서의 생성은 이번에 실행하지 않았다. 그 경로는 기존과 같은 node_modules 경로를 쓴다.
- Windows 설치본의 고지에는 Windows 빌드에 실제로 포함되지 않는 두 패키지도 들어간다(전체 플랫폼 기준의 상위 집합). 설치 패키지는 생성하지 않았다.

## 2026-11-12 — 접속 실패 시 터미널 접속 진단(ssh -v 요약)

### 요청 및 변경

- 사용자가 인증 실패 등 접속 실패 때 터미널에 ssh -vv 같은 주요 로그를 보여 원인을 파악할 수 있게 해 달라고 요청했다.
- src/main/connectLog.ts: 접속 시도마다 ssh2 debug 줄과 오류 원문을 따로 모으고(beginAttempt/debug), summarizeAttempt()가 원인 파악에 필요한 줄만 고른다. 접속 대상(Client: Trying), 소켓 오류, 서버 식별 문자열, 협상된 KEX·호스트 키·암호, 호스트 키 판정, 인증 요청·실패, DISCONNECT, 실패·거부·시간 초과·no matching 등 오류 줄, 오류 원문이다. 협상이 끝나지 않았으면 양쪽 알고리즘 목록을, 서버 식별 전에 끊겼으면 소켓 종료 줄을 넣는다. 인증 실패면 '서버 허용 방식 · 시도한 방식' 요약을 붙인다. 점프 서버 줄은 [별칭]을 유지하고 40줄을 넘으면 가운데를 줄인다.
- 화면 안내(info_)는 이미 터미널에 나오므로 진단 대상에서 뺐다. 패킷 데이터 줄(CHANNEL_DATA 등)은 기존처럼 기록하지 않는다.
- src/main/sessions.ts: 접속 실패(catch)에서 '● 접속 진단 (ssh -v 요약 · 전체: 탭 메뉴 → 접속 상세 로그)' 아래 회색 'debug:' 줄로 출력한다. 자동 재접속·Enter 재시도가 같은 원인으로 실패하면 한 줄 생략 안내만 보이고, 정상 접속하면 초기화한다. 제어 문자는 공백으로 바꿔 출력한다. 로컬 셸은 제외하고, 디버그 줄이 없는 텔넷·시리얼은 출력하지 않는다.
- main에 커밋하고 origin/main으로 푸시한다.

### 직접 검증한 결과

- npm run typecheck 통과, npm run build 성공. 단위 테스트 91개 중 87 통과·0 실패·4 건너뜀. 실제 ssh2 1.17 출력(OpenSSH 9.2, podman)으로 만든 진단 단위 테스트 4개를 추가했다.
- node test/e2e-connect-diagnosis-podman.mjs 통과: 비밀번호 틀림(인증 과정·허용/시도 방식, 터미널에 비밀번호 문자열 없음), 닫힌 포트(Socket error ECONNREFUSED, Enter 재시도 시 같은 원인 생략), ssh2가 지원하지 않는 KexAlgorithms만 허용한 sshd(양쪽 KEX 목록과 no matching key exchange algorithm), 진단에 화면 안내 줄 중복 없음.
- 회귀: test/e2e-connect-log.mjs, test/e2e-auth-reconnect-podman.mjs 통과.

### 검증 범위

- 공개키 인증 실패, 점프 서버 경유 실패, 프록시 실패는 E2E로 확인하지 않았다(점프 서버 표시는 단위 테스트만).
- 접속된 뒤의 끊김에는 진단을 보이지 않는다. 텔넷·시리얼은 ssh2 debug가 없어 기존 오류 문구만 나온다.
- macOS·Linux 앱 실행은 하지 않았다. 설치 패키지는 생성하지 않았다.

## 2026-11-12 — ksh 호환성 검증 환경(podman, AIX 7.2 근사)·세션 로그·인증 실패 재접속 정리

### 요청 및 변경

- 사용자가 podman으로 ksh 환경을 만들어 기능 호환성 검증 환경을 구축·검증하도록 요청했고, 작업 중 AIX 7.2에 탑재되는 ksh 버전을 확인해 해당 셸로도 검증하도록 추가 요청했다. 이후 실패한 단위 테스트 대응, 다른 세션에서 넘겨받은 세션 로그 기능과 기존 미커밋 변경을 포함한 커밋·푸시를 요청했다.
- AIX 7.2 셸 확인: 기본 /usr/bin/ksh(/bin/sh)는 ksh88 "Version M-11/16/88f", /usr/bin/ksh93은 "Version M 93t+ 2009-05-01"이다(공개 자료 기준). ksh88은 공개 소스가 없어 컨테이너로 재현하지 않았다.
- test/podman/ksh/: Containerfile(리눅스, /bin/ksh=ksh93u+m 1.0.4, /bin/mksh)과 Containerfile.aix72(AIX 7.2 근사, /usr/bin/ksh93=Debian ksh 93t+-2 바이너리 "Version JM 93t+ 2009-05-01", /usr/bin/ksh=pdksh 5.2.14를 ksh88 대용)를 만들었다. 패키지는 snapshot.debian.org 파일 해시로 고정했다. 두 이미지 모두 22번(SFTP 사용)과 2222번(SFTP 서브시스템 없음) sshd를 띄운다.
- test/e2e-ksh-podman.mjs(npm run test:ksh): 셸마다 자동 실행 명령(ksh 문법), TMOUT 조회, 서버 환경 감지·매뉴얼 추천, 상태 표시줄 지표, SFTP, 유휴 방지(간격 < TMOUT), TMOUT 경고 뒤 동작, SFTP 없는 서버의 셸 명령 파일 관리(특수 문자 이름 5개·300KB 바이너리 왕복·이름 변경·권한·미리보기·삭제), tmux 세션 유지·재연결·종료를 실제 앱으로 확인한다. AIX 근사 이미지는 'user@host [경로] ' PS1을 쓴다.
- 발견·수정: ksh93(93t+, 93u+m)의 TMOUT 경고 "shell will timeout in 60 seconds due to inactivity"를 유휴 방지가 인식하지 못해 경고 뒤 명령을 보내지 않았다. src/main/idleGuard.ts 정규식을 'time ?out'과 경고 줄 뒤 한 줄(프롬프트)까지 허용하도록 고치고 실제 출력을 단위 테스트에 추가했다.
- 단위 테스트 Windows 실행 수정: importers는 추적되지 않는 생성 파일 test/.imp.mjs 대신 소스를 직접 읽고, android-run은 WSL 런처 대신 Git for Windows bash를 쓰며, shellfs는 Git Bash 경로 변환 때문에 Windows에서 건너뛴다(같은 코드는 ksh podman E2E로 검증).
- 세션 로그(다른 세션 brightterm-12에서 구현해 이관): 앱 기본 설정과 서버별 설정(앱 따르기/켜기/끄기, 고급 규칙), 크기·날짜 회전, 개수·기간 보관, 선택적 gzip. 기본값 10MB·날짜 변경 회전·서버당 50개·30일·압축 끔.
- 인증 실패 재접속(이 세션 시작 전부터 있던 미커밋 변경): 인증 실패 시 정상 접속 전까지 자동 재접속을 중단한다. podman OpenSSH E2E 포함.
- 커밋을 범위별로 나눴다: daa5d98(인증 실패 재접속, sessions.ts는 해당 부분만 스테이징), 510b3b7(ksh93 경고·ksh podman E2E), 04b0e22(Windows 단위 테스트), eaae7c5(세션 로그), 이 문서 커밋. main에 커밋하고 origin/main으로 푸시한다.

### 직접 검증한 결과

- 최종 작업 트리: npm run typecheck 통과, npm run build 성공, 단위 테스트 87개 중 83 통과·0 실패·4 건너뜀(Windows의 shellfs 2개, 원래 조건부인 지표·실제 tmux 2개).
- node test/e2e-ksh-podman.mjs: ksh93(93u+m), mksh, aix-ksh93t(93t+ 2009-05-01), aix-ksh88-pdksh 4개 셸에서 36개 항목 통과. 정규식 수정 전에는 ksh93u+m에서 TMOUT 경고 뒤 유휴 방지 명령이 10초 안에 전송되지 않아 실패하는 것을 확인했고, 수정 후 경고 뒤 약 4초에 전송되어 접속이 유지됐다.
- node test/e2e-auth-reconnect-podman.mjs, test/e2e-session-log.mjs, test/e2e-connect-log.mjs, test/e2e-idle-guard.mjs 통과.
- 인증 실패 재접속 커밋은 스테이징된 트리만 임시 폴더로 꺼내 tsc와 reconnect 단위 테스트를 통과시킨 뒤 커밋했다.

### 검증 범위

- 실제 AIX 서버와 ksh88은 검증하지 않았다. pdksh는 ksh88 문법 대용일 뿐이며 TMOUT 동작이 다르다(mksh·pdksh는 경고 없이 바로 종료, 실제 ksh88은 경고 후 대기). ksh88 경고 처리는 기존 단위 테스트 문자열로만 확인된다. 93t+ 바이너리는 x86_64 Debian 빌드이며 AIX(POWER) 빌드와 옵션 표시(JM/M)가 다르다.
- /bin/mksh는 매뉴얼 추천에서 ksh로 분류되지 않는다. 의도 여부는 결정하지 않았고 코드를 바꾸지 않았다.
- 세션 로그는 이관 세션이 Windows에서 검증했다. macOS·Linux 실행, 실제 날짜 회전, 앱 종료 뒤 남은 파일 압축, 텔넷·시리얼·로컬 E2E는 미검증이다. 기존 로그 사용자에게 30일·50개 보관이 바로 적용되고 이전 형식 로그도 삭제 대상이 되는 업그레이드 영향은 사용자 결정 전이며 마이그레이션을 넣지 않았다.
- 설치 패키지는 생성하지 않았다. out/·dist/·node_modules/는 커밋하지 않았다.

## 2026-11-12 — Git 동기화 차이 미리보기 구현

### 요청 및 변경

- 사용자의 후속 요청으로 앞서 제안한 차이 미리보기 API와 화면을 구현했다. 중단된 커밋·푸시 요청도 이어서 처리한다.
- 충돌 화면에서 서버·폴더·스니펫·계정·볼트 정보를 종류별로 필터링하고 항목을 펼쳐 이 PC/원격 값을 비교한다. 계정의 실제 비밀값은 메인 프로세스에서 비교하며 응답에는 존재·다름 여부만 포함한다. 계정의 암호화 표현만 달라진 경우도 구분한다.
- 메모·자동 명령·스니펫 본문은 별도 펼치기로 표시하며 알려진 URL 자격 증명·민감 객체 필드를 마스킹한다. 알 수 없는 저장 필드 값은 표시하지 않는다. 긴 값은 2400자까지, 항목은 50개씩 표시한다.
- 조회는 설정·볼트·성공 기록·원격을 바꾸지 않는다. 로컬 Git 캐시만 갱신할 수 있다. 원격 키가 다르면 비밀번호를 받아 비교하고 복호화 키 버퍼는 종료 시 지운다. 파싱 오류에 비밀값 일부가 포함되지 않도록 오류 메시지도 정리했다.
- 미리보기 지문과 저장소 설정에 연결된 5분 토큰을 발급한다. 선택 직전 원격을 다시 읽고 로컬·원격 지문을 확인한다. 볼트 잠금·설정 변경·성공·새 충돌 시 토큰을 무효화한다. 원격 파일이 없으면 가져오기를 비활성화한다.
- 화면의 비교 결과는 로컬 목록·계정·설정·상태 변경과 잠금·만료 시 지운다. 입력 비밀번호는 설정 화면 내 메모리에서만 잠시 사용하며 잠금·닫기·적용 시 제거한다.
- docs/git-sync-conflict-preview.md를 제안서에서 실제 사용 안내·구현 범위로 갱신하고 README·CHANGELOG도 반영했다. 앞선 말풍선 알림 변경과 함께 main에 커밋하고 origin/main으로 푸시한다.

### 직접 검증한 결과

- npm run typecheck, npm run build 통과.
- node --experimental-strip-types --test test/git-sync-diff.test.mjs: 4개 통과. 실제 필드·기본값·참조 표시, 계정 비밀값 비노출·암호문/실제 값 구분, 한쪽 항목·이전 스니펫 형식, URL·알 수 없는 필드 마스킹과 본문 숨김을 확인했다.
- node test/e2e-git-sync.mjs 전체 통과. 두 임시 프로필과 로컬 bare 저장소에서 읽기 전용 조회, 다른 볼트 키·잘못된 비밀번호, 비교 UI와 실제 가져오기, 잠금·저장소 설정 변경 및 비교 후 로컬/원격 수정에 대한 이전 선택 차단, 원격 파일 없음, 기존 동기화 회귀 시나리오를 확인했다.
- node test/e2e-git-sync-notice.mjs 통과. 앞선 말풍선 알림의 포커스·중복 억제·설정 이동을 재확인했다.
- /tmp/brightterm-git-sync-preview.png 렌더링을 확인해 비교 표·분류·접기/펼치기·긴 참조 ID 표시를 점검했다.

### 검증 범위

- 사용자 실제 저장소와 homelab 데이터는 조회·가져오기·덮어쓰기하지 않았다. Windows·Linux 설치본·Android 및 실제 외부 Git 인증 환경은 미검증이다.
- 항목별 병합은 지원하지 않는다. 기준 스냅샷이 없으므로 한쪽 항목을 삭제/추가로 단정하거나 최신 기기를 추측하지 않는다. 기존 전체 선택과 백업 정책을 유지한다.
- 설치 패키지는 생성하지 않았으며 out/·dist/·node_modules/는 커밋 대상이 아니다.

## 2026-11-12 — Git 동기화 문제 말풍선 알림·충돌 비교 제안

### 요청 및 변경

- 사용자는 Git 동기화 실패 시 우측 아이콘에 말풍선 알림을 요청했고, 사용할 데이터를 판단할 수 있도록 어떤 값이 다른지 확인하는 대책을 요청했다.
- GitSyncIndicator에 실패·충돌·비밀번호 확인 필요 상태의 말풍선을 추가했다. 상태 제목·원인·후속 안내·설정 이동·닫기를 제공한다.
- 키보드 포커스를 가져가지 않고, 닫은 알림과 같은 오류가 자동 재시도로 반복되면 재표시하지 않는다. 정상 복구 뒤 재발하거나 오류 내용·저장소·브랜치가 바뀌면 새로 표시한다.
- 실패 상태 조회 자체가 실패했을 때도 설정에서 확인하도록 알린다. 기존 동기화 처리와 데이터 선택·덮어쓰기 정책은 변경하지 않았다.
- docs/git-sync-conflict-preview.md에 읽기 전용 항목별 비교를 제안했다. 서버·폴더·스니펫·계정의 양쪽 차이, 비밀값 비노출, 기준 데이터가 없을 때 추가/삭제 방향을 추측하지 않는 표시, 미리보기 무효화·선택 시 재확인 방안을 포함한다. 비교 API·화면은 구현하지 않았다.

### 직접 검증한 결과

- npm run typecheck 및 npm run build 통과.
- node test/e2e-git-sync-notice.mjs 통과. 분리된 임시 프로필과 모의 상태 이벤트로 말풍선 위치, 포커스 유지, 동일 오류 재시도 중복 억제, 복구 뒤 재알림, 충돌·비밀번호 상태 및 설정 화면 이동을 확인했다.
- /tmp/brightterm-git-sync-notice.png를 생성하고 실제 렌더링을 확인했다. 우측 아이콘 아래 말풍선이 화면 경계 안에 표시되고 원인과 동작 버튼이 보였다.
- 실제 사용자 볼트·원격 동기화 저장소에 접근하거나 충돌 데이터를 선택하지 않았다. 기존 동기화 엔진은 수정하지 않았으며 이번에는 전체 동기화 E2E를 재실행하지 않았다.
- 사용자의 후속 요청에 따라 main에 커밋하고 origin/main으로 푸시한다. 생성된 out/·dist/·node_modules/는 커밋 대상이 아니다.

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
