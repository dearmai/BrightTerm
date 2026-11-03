# BrightTerm 작업 지침

## Linux 패키징

- ARM64 deb는 `make deb ARCH=arm64` 또는 의존성 설치 후 `npm run dist:linux:deb:arm64`로 빌드한다.
- x64 Linux에서 교차 빌드할 때는 `gcc-aarch64-linux-gnu`, `g++-aarch64-linux-gnu`가 필요하다.
- `npmRebuild: false`이므로 Electron의 대상 아키텍처만 바꾸는 것으로 네이티브 모듈 검증을 대신하지 않는다. `scripts/prepare-linux-native.cjs`에서 패키지의 `node-pty` 아키텍처를 확인하고 필요하면 별도로 빌드한다. 개발용 호스트 모듈은 보존한다.
- 패키징 변경은 deb의 `Architecture`와 포함된 네이티브 바이너리의 ELF 아키텍처를 확인한다. 빌드 성공, 앱 실행, 터미널 기능 검증은 구분해 기록한다.

## PRoot-Distro 실행

- Ubuntu 24.04.5 / aarch64 / `6.17.0-PRoot-Distro` 환경에서 기본 실행 시 `Trace/breakpoint trap`, zygote의 `Broken pipe`가 발생했고, 사용자가 `brightterm --no-sandbox`로 앱 실행에 성공했다.
- 같은 환경의 시작 오류는 우선 `--no-sandbox`로 샌드박스 호환 여부를 확인한다. 로그만으로 모든 SIGTRAP 오류를 같은 원인으로 단정하지 않는다.
- `--no-sandbox`는 Chromium 프로세스의 샌드박스 보호를 해제한다. PRoot에서 필요한 경우 실행 인자나 사용자 바로가기에 명시하며, 일반 Linux 패키지의 기본값이나 자동 감지 로직으로 추가하지 않는다.
- `--disable-gpu`, `--disable-dev-shm-usage`는 추가 진단용이며, 이번 사용자 환경에서는 필요성이 확인되지 않았다.

## 작업 기록

- 사용자에게 요청받은 작업내역서와 회고록은 `docs/work-log.md`, `docs/retrospective.md`에 날짜별로 남긴다.
- 직접 검증한 내용과 사용자 확인 결과, 미검증 범위를 구분한다. 생성된 `dist/`, `out/`, `node_modules/`는 커밋하지 않는다.
