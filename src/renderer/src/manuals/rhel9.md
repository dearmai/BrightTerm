# RHEL 9

## 먼저 알아둘 것

마이너 릴리스마다 패키지가 올라갑니다. 예를 들어 RHEL 9 초기의 OpenSSH는 8.7이었지만 9.8은 9.9입니다. 메이저 버전만 보고 판단하지 말고 서버에서 `rpm -q`로 확인하세요.

아래 값은 Red Hat의 UBI 9.8 이미지에서 2026-11-05에 확인했습니다. 커널은 이미지에 없어 호환 배포판 Rocky Linux 9.8에서 확인했습니다.

| 구성요소 | 버전 |
|---|---|
| 커널 | 5.14 계열 |
| bash | 5.1.8 |
| zsh | 5.8 |
| OpenSSH | 9.9p1 |
| Python (시스템) | 3.9 |
| dnf / rpm | 4.14 / 4.16 |
| podman | 5.8 |

## RHEL 9에서 달라진 점

### 네트워크

- `network-scripts` 패키지가 없습니다. `ifup`·`ifdown` 스크립트 대신 NetworkManager를 씁니다.
- 새 프로필은 `/etc/NetworkManager/system-connections/`에 keyfile 형식으로 저장됩니다.
- `/etc/sysconfig/network-scripts/`의 ifcfg 프로필은 아직 동작하지만 사용 중단 예정입니다. **RHEL 10에서는 무시되므로** 올리기 전에 RHEL 9에서 변환하세요.

```
nmcli -f NAME,UUID,TYPE,FILENAME connection show   # 어느 파일을 쓰는지
sudo nmcli connection migrate                      # ifcfg 프로필을 keyfile로 변환
```

### SSH

- root의 비밀번호 로그인이 기본으로 막혀 있습니다(`PermitRootLogin prohibit-password`). 키 로그인은 됩니다. 일반 사용자로 접속해 `sudo`를 쓰는 방식을 권장합니다.
- `scp`가 기본으로 SFTP 프로토콜을 씁니다. 오래된 서버와 맞지 않으면 `scp -O`로 예전 프로토콜을 씁니다.

### 암호화 정책

`DEFAULT` 정책에서 TLS, SSH 등의 SHA-1 서명을 허용하지 않습니다. 또한 RHEL 6 같은 오래된 시스템과는 기본 설정으로 SSH 연결이 되지 않습니다.

```
update-crypto-policies --show
sudo update-crypto-policies --set DEFAULT:SHA1   # 필요한 경우에만. 보안이 약해집니다
```

오래된 장비를 위해 바꿨다면 작업 뒤 `DEFAULT`로 되돌리세요.

### cgroup

cgroup v2가 기본입니다. v1을 직접 쓰는 프로그램은 제대로 동작하지 않을 수 있습니다.

```
stat -fc %T /sys/fs/cgroup/    # cgroup2fs 면 v2
```

### 패키지

- `dnf module`로 소프트웨어 버전 묶음을 고를 수 있습니다(`dnf module list`). RHEL 10에는 모듈 콘텐츠가 없습니다.
- `chsh`는 `util-linux-user` 패키지에 있습니다(`sudo dnf install util-linux-user`). 없을 때는 `sudo usermod -s /bin/zsh 사용자`로도 쉘을 바꿀 수 있습니다.

## 공식 문서

- [RHEL 9 문서 전체](https://docs.redhat.com/en/documentation/red_hat_enterprise_linux/9)
- [RHEL 9 도입 시 고려 사항: 보안](https://docs.redhat.com/en/documentation/red_hat_enterprise_linux/9/html/considerations_in_adopting_rhel_9/assembly_security_considerations-in-adopting-rhel-9)
- [RHEL 9 도입 시 고려 사항: 네트워크](https://docs.redhat.com/en/documentation/red_hat_enterprise_linux/9/html/considerations_in_adopting_rhel_9/assembly_networking_considerations-in-adopting-rhel-9)
- [시스템 전체 암호화 정책](https://docs.redhat.com/en/documentation/red_hat_enterprise_linux/9/html/security_hardening/using-the-system-wide-cryptographic-policies_security-hardening)
- [RHEL 수명 주기](https://access.redhat.com/support/policy/updates/errata)
