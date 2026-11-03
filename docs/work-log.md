# 작업내역서

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
