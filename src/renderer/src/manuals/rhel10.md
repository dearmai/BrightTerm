# RHEL 10

## 먼저 알아둘 것

마이너 릴리스마다 패키지가 올라갑니다. 메이저 버전만 보고 판단하지 말고 서버에서 `rpm -q`로 확인하세요.

아래 값은 Red Hat의 UBI 10.2 이미지에서 2026-11-05에 확인했습니다. 커널은 이미지에 없어 Red Hat 릴리스 노트를 따랐습니다.

| 구성요소 | 버전 |
|---|---|
| 커널 | 6.12 계열 |
| bash | 5.2.26 |
| zsh | 5.9 |
| OpenSSH | 9.9p1 |
| Python (시스템) | 3.12 |
| dnf / rpm | 4.20 / 4.19 |
| podman | 5.8 |

## RHEL 10에서 달라진 점

### 네트워크

- ifcfg 형식 프로필을 지원하지 않습니다. NetworkManager가 무시하며 **RHEL 10에서는 keyfile로 변환할 수도 없습니다.** 올린 뒤 연결이 없다면 `nmcli`로 다시 만드세요.
- `dhclient`가 없습니다. `/etc/NetworkManager/NetworkManager.conf`에 `dhcp=dhclient`를 쓸 수 없으며, 기본값 `dhcp=internal`을 씁니다.

```
ls /etc/sysconfig/network-scripts/ 2>/dev/null     # 남은 ifcfg 파일 확인
nmcli -f NAME,UUID,TYPE,FILENAME connection show   # 어느 파일을 쓰는지
```

### 빠졌거나 바뀐 패키지

| 이전 | RHEL 10 |
|---|---|
| ISC DHCP (`dhcp-server`) | Kea (`kea`) |
| Redis (`redis`) | Valkey (`valkey`) |
| `sendmail` | Postfix (`postfix`) |
| TigerVNC | 제거됨 |
| Xorg 서버 | 제거됨. X11 프로그램은 Xwayland로 실행 |

### 모듈이 없음

RHEL 10에는 모듈 콘텐츠가 없습니다. RHEL 8·9의 `dnf module enable` 절차를 그대로 옮기면 동작하지 않으니, 필요한 버전은 패키지 이름으로 찾으세요.

### cgroup

cgroup v2만 쓸 수 있습니다. systemd가 v1 모드 부팅을 지원하지 않으므로 v1 경로(`/sys/fs/cgroup/cpu,cpuacct` 등)를 읽는 감시 도구와 스크립트는 고쳐야 합니다.

```
stat -fc %T /sys/fs/cgroup/    # cgroup2fs
```

### CPU

RHEL 10의 GCC 14는 x86-64-v3을 기본 대상으로 합니다. 오래된 CPU나 이 기능을 넘겨주지 않는 가상 머신은 올리기 전에 확인하세요.

```
grep -m1 -o avx2 /proc/cpuinfo   # x86-64-v3 의 조건 중 하나
```

### SSH

- root의 비밀번호 로그인은 RHEL 9처럼 기본으로 막혀 있습니다(`PermitRootLogin prohibit-password`).
- RHEL 10.2 문서에서는 `mlkem768x25519-sha256`이 SSH 키 교환의 우선 알고리즘입니다. 오래된 클라이언트는 다른 알고리즘으로 협상합니다.
- `/etc/ssh/sshd_config.d/`에 `40-redhat-crypto-policies.conf`와 `50-redhat.conf`가 있습니다. 내 설정은 이보다 앞서는 이름으로 두세요.

### 패키지 도구

- `chsh`는 `util-linux` 패키지에 들어 있습니다.
- RPM 4.19는 서명 검증에 Sequoia PGP를 씁니다. 오래된 키로 서명한 외부 패키지는 설치가 거부될 수 있습니다.

## 공식 문서

- [RHEL 10 문서 전체](https://docs.redhat.com/en/documentation/red_hat_enterprise_linux/10)
- [10.0 릴리스 노트: 제거된 기능](https://docs.redhat.com/en/documentation/red_hat_enterprise_linux/10/html/10.0_release_notes/removed-features)
- [RHEL 10 도입 시 고려 사항: 네트워크](https://docs.redhat.com/en/documentation/red_hat_enterprise_linux/10/html/considerations_in_adopting_rhel_10/networking)
- [RHEL 10 도입 시 고려 사항: 인프라 서비스](https://docs.redhat.com/en/documentation/red_hat_enterprise_linux/10/html/considerations_in_adopting_rhel_10/infrastructure-services)
- [RHEL 10 도입 시 고려 사항: 소프트웨어 관리](https://docs.redhat.com/en/documentation/red_hat_enterprise_linux/10/html/considerations_in_adopting_rhel_10/software-management)
- [RHEL 수명 주기](https://access.redhat.com/support/policy/updates/errata)
