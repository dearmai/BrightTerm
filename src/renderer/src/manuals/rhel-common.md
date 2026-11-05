# RHEL 공통 (9·10)

## 버전·시스템 정보

```
cat /etc/redhat-release
grep -E '^(ID|VERSION_ID|PRETTY_NAME)=' /etc/os-release
uname -r                   # 커널
hostnamectl                # 호스트 이름, OS, 커널, 가상화 여부
lscpu
free -h
lsblk -f                   # 디스크, 파일 시스템
rpm -q bash zsh openssh-server
```

Rocky Linux·AlmaLinux 같은 호환 배포판에도 이 문서의 명령 대부분이 그대로 쓰이지만, 저장소 이름과 `subscription-manager`는 다릅니다.

## 패키지 (dnf·rpm)

```
dnf search 단어
dnf info 패키지
dnf install 패키지
dnf remove 패키지
dnf check-update           # 받을 수 있는 업데이트 (있으면 종료 코드 100)
dnf update
dnf provides '*/bin/nmcli' # 이 파일이 든 패키지 찾기
dnf repolist
dnf repoquery --installed
```

### 변경 기록과 되돌리기

```
dnf history
dnf history info last
dnf history undo 번호
```

### 보안 업데이트

```
dnf updateinfo list --security
dnf update --security
dnf needs-restarting -r    # 재부팅이 필요한지 (필요하면 종료 코드 1)
```

### rpm으로 조회

```
rpm -qf /usr/bin/ssh       # 이 파일이 속한 패키지
rpm -ql openssh-clients    # 패키지의 파일 목록
rpm -qa --last | head      # 최근 설치한 패키지
rpm -V openssh-server      # 설치 뒤 바뀐 파일
rpm -q --changelog bash | head
```

## 구독·저장소

```
subscription-manager status
subscription-manager repos --list-enabled
sudo subscription-manager register
sudo subscription-manager repos --enable 저장소이름
```

저장소 파일은 `/etc/yum.repos.d/`에 있습니다. 구독 등록 전에는 Red Hat 저장소에서 패키지를 받을 수 없습니다.

## 서비스 (systemd)

```
systemctl status 이름
systemctl start·stop·restart·reload 이름
systemctl enable --now 이름   # 부팅 시 시작 + 지금 시작
systemctl disable --now 이름
systemctl is-enabled 이름
systemctl list-units --failed
systemctl list-unit-files --type=service
systemctl cat 이름            # 적용 중인 유닛 파일
systemctl list-timers
```

`start·stop·restart·reload`는 그중 하나를 고르라는 뜻입니다. 패키지가 설치한 유닛 파일을 직접 고치지 말고 덮어쓰기 파일을 만드세요.

```
sudo systemctl edit 이름      # /etc/systemd/system/이름.service.d/override.conf
sudo systemctl daemon-reload  # 유닛 파일을 직접 고쳤을 때
```

## 로그 (journalctl)

```
journalctl -u 이름 -f              # 서비스 로그 따라가기
journalctl -u 이름 -S "1 hour ago"
journalctl -b -p err               # 이번 부팅의 오류 이상
journalctl -b -1                   # 직전 부팅
journalctl -k                      # 커널 메시지
journalctl --list-boots
journalctl --disk-usage
```

`-b -1`이 비어 있으면 저널이 재부팅 뒤 남지 않는 설정일 수 있습니다. 텍스트 로그는 `/var/log/messages`, `/var/log/secure`(인증)에 있습니다.

## 프로세스·성능

```
ps -eo pid,ppid,user,%cpu,%mem,etime,cmd --sort=-%cpu | head
top
vmstat 1 5
iostat -xz 1 3             # sysstat 패키지
df -h
du -xh --max-depth=1 / | sort -h | tail
ss -tlnp                   # 듣고 있는 TCP 포트와 프로세스
lsof +L1                   # 지웠지만 열려 있어 공간을 차지하는 파일
```

## 네트워크 (nmcli)

```
ip -br addr
ip route
nmcli device status
nmcli connection show
nmcli connection show "이름"
```

고정 IP로 바꾸기:

```
sudo nmcli connection modify "이름" ipv4.method manual \
  ipv4.addresses 192.0.2.10/24 ipv4.gateway 192.0.2.1 ipv4.dns 192.0.2.53
sudo nmcli connection up "이름"
```

SSH로 접속한 인터페이스를 바꾸면 연결이 끊길 수 있으니 콘솔을 준비하세요. 프로필은 `/etc/NetworkManager/system-connections/`에 저장되며, Red Hat은 직접 편집하지 말고 `nmcli` 등으로 관리하도록 안내합니다.

## 방화벽 (firewalld)

```
sudo firewall-cmd --state
sudo firewall-cmd --get-active-zones
sudo firewall-cmd --list-all
sudo firewall-cmd --permanent --add-service=http
sudo firewall-cmd --permanent --add-port=8080/tcp
sudo firewall-cmd --reload
```

`--permanent`는 저장만 하므로 `--reload`까지 해야 적용됩니다. `--permanent` 없이 쓰면 바로 적용되지만 다시 읽거나 재부팅하면 사라집니다.

## SELinux

권한이 맞는데 `Permission denied`가 나면 먼저 SELinux를 확인하세요.

```
getenforce
sestatus
ls -Z 파일
ps -eZ | grep 이름
sudo ausearch -m AVC -ts recent    # 최근 거부 기록
sudo restorecon -Rv /경로          # 파일 레이블을 정책대로 복구
```

웹 콘텐츠 폴더와 포트를 추가하는 예입니다.

```
sudo semanage fcontext -a -t httpd_sys_content_t "/web(/.*)?"
sudo restorecon -Rv /web
sudo semanage port -a -t http_port_t -p tcp 8081
getsebool -a | grep httpd
sudo setsebool -P httpd_can_network_connect on
```

- `semanage`는 `policycoreutils-python-utils`, `ausearch`는 `audit` 패키지에 있습니다.
- `mv`로 옮긴 파일은 원래 레이블을 유지합니다. 옮긴 뒤 `restorecon`을 실행하세요.
- `sudo setenforce 0`은 재부팅 전까지 Permissive로 바꿉니다. 원인을 가려낼 때만 잠시 쓰세요.

## 디스크·LVM

```
lsblk -f
sudo pvs
sudo vgs
sudo lvs
sudo lvextend -r -L +10G /dev/볼륨그룹/논리볼륨   # 파일 시스템까지 함께 확장
xfs_info /마운트지점
```

- XFS는 늘리기만 되고 줄일 수 없습니다.
- `/etc/fstab`을 고친 뒤에는 재부팅 전에 `sudo mount -a`와 `sudo findmnt --verify`로 확인하세요. 잘못된 항목은 부팅을 막을 수 있습니다.

## 사용자·sudo

```
sudo useradd -m -s /bin/bash kim
sudo passwd kim
sudo usermod -aG wheel kim    # wheel 그룹은 기본적으로 sudo 가능
id kim
sudo chage -l kim             # 비밀번호 만료 정보
sudo -l                       # 내가 쓸 수 있는 sudo 권한
sudo visudo -f /etc/sudoers.d/이름
sudo faillock --user kim      # 로그인 실패 잠금 확인
sudo faillock --user kim --reset
authselect current
```

## SSH 서버

```
sudo sshd -T | grep -iE 'permitrootlogin|passwordauthentication'   # 실제 적용 값
sudo sshd -t                  # 설정 문법 검사
sudo systemctl reload sshd
ls /etc/ssh/sshd_config.d/
```

- `sshd -T`는 `prohibit-password`를 `without-password`로 표시합니다. 같은 값입니다.
- 바꿀 값은 `/etc/ssh/sshd_config.d/`에 새 파일로 둡니다. OpenSSH는 처음 읽은 값을 쓰고, 이 폴더의 파일은 이름순으로 읽으며, 같은 폴더에 `50-redhat.conf`가 있으므로 `10-local.conf`처럼 앞서는 이름을 쓰세요.
- 설정을 바꿀 때는 기존 접속을 끊지 말고 새 접속이 되는지 확인한 뒤 닫으세요.
- 포트를 바꾸면 SELinux(`semanage port -a -t ssh_port_t -p tcp 포트`)와 방화벽도 함께 바꿔야 합니다.

## 암호화 정책

OpenSSH, OpenSSL 등의 허용 알고리즘을 시스템 전체에서 정합니다.

```
update-crypto-policies --show
sudo update-crypto-policies --set DEFAULT
```

오래된 장비에 접속이 안 될 때 `LEGACY`로 바꾸면 시스템 전체가 약해지므로, 먼저 상대 장비를 고치거나 필요한 연결에만 옵션을 지정하세요. 바꾼 뒤에는 재부팅해야 모든 서비스에 적용됩니다.

## 시간·성능 프로필

```
timedatectl
sudo timedatectl set-timezone Asia/Seoul
chronyc tracking
chronyc sources -v
tuned-adm active
tuned-adm list
```
