# AIX 7.2 – 7.3

## 먼저 알아둘 것

Linux와 명령 체계가 많이 다릅니다. 옵션은 TL·SP에 따라 다를 수 있으니, 처음 쓰는 옵션은 서버에서 `man 명령`으로 확인하세요.

- 설정 변경은 대부분 전용 명령(`chdev`, `chuser`, `chfs`)이나 메뉴 도구 `smitty`로 합니다. 설정 데이터베이스(ODM)에 저장되는 값이 많아, 설정 파일 편집만으로는 반영되지 않을 수 있습니다.
- 서비스는 systemd가 아니라 SRC(`lssrc`, `startsrc`)와 `/etc/inittab`이 관리합니다.
- 디스크는 LVM이 기본입니다: 물리 디스크(PV) → 볼륨 그룹(VG) → 논리 볼륨(LV) → 파일 시스템.
- 오픈소스 도구는 대개 `/opt/freeware/bin`에 설치됩니다(AIX Toolbox).

```
smitty              # 전체 메뉴
smitty user         # 사용자 메뉴로 바로 이동 (tcpip, lvm, jfs2 등)
```

## Linux 명령 대응표

| Linux | AIX |
|---|---|
| `top` | `topas`, `nmon` |
| `free` | `svmon -G -O unit=GB` |
| `lscpu`, `dmidecode` | `prtconf`, `lparstat -i` |
| `lsblk` | `lspv`, `lsvg -l 볼륨그룹` |
| `systemctl status 이름` | `lssrc -s 이름` |
| `systemctl start·stop 이름` | `startsrc -s 이름`, `stopsrc -s 이름` |
| `dmesg`, `journalctl` | `errpt`, `alog -o -t boot` |
| `ip addr` | `ifconfig -a` |
| `ip route` | `netstat -rn` |
| `ss -tlnp` | `netstat -Aan \| grep LISTEN` |
| `strace` | `truss` |
| `lsof -p PID` | `procfiles -n PID` |
| `pstree` | `proctree PID` |
| `rpm -qa`, `dpkg -l` | `lslpp -L` (`rpm -qa`는 Toolbox 패키지) |
| `useradd`, `usermod` | `mkuser`, `chuser` |

### GNU 옵션 주의

기본 명령은 GNU 도구가 아닙니다. 아래처럼 GNU 확장을 쓴 스크립트는 그대로 동작하지 않는 경우가 많습니다.

| 하려는 일 | AIX 기본 명령으로 |
|---|---|
| `tar xzf a.tar.gz` | `gunzip -c a.tar.gz \| tar -xf -` |
| `sed -i 's/a/b/' f` | `sed 's/a/b/' f > f.new && mv f.new f` |
| `date -d yesterday` | `date -d`에 기대지 말고 Toolbox의 GNU `date` 사용 |
| `find . -maxdepth 1` | `find . ! -name . -prune` |

기본 `grep`은 아주 긴 줄을 잘라서 검사한다고 알려져 있으니 긴 줄이 있는 파일은 결과를 확인하세요. Toolbox의 GNU 도구를 쓰려면 경로를 직접 지정합니다(예: `/opt/freeware/bin/tar`).

## 버전·시스템 정보

```
oslevel -s                 # 예: 7300-02-01-2346
uname -a
uname -L                   # LPAR 번호와 이름
uname -M                   # 머신 모델
prtconf                    # 모델, CPU, 메모리, 디스크 요약
lparstat -i                # LPAR 설정 (엔타이틀먼트, 메모리 등)
getconf KERNEL_BITMODE     # 커널 비트 수
lsdev -Cc processor        # CPU 장치
lsdev -Cc adapter          # 어댑터
lscfg -vpl fcs0            # 장치 상세 (FC WWN 등)
lsattr -El sys0            # 시스템 속성
```

`oslevel -s` 결과는 `버전-TL-SP-빌드` 형식입니다. `7300-02-01-2346`은 7.3 TL2 SP1입니다. `oslevel`은 시간이 걸릴 수 있습니다.

## 프로세스·성능

```
topas                      # 전체 현황 (q 로 종료)
nmon                       # 키로 항목 선택 (c CPU, m 메모리, d 디스크)
vmstat 2 5                 # CPU·메모리, 2초 간격 5회
iostat -D 2 5              # 디스크 상세
svmon -G -O unit=GB        # 메모리 전체
svmon -P PID -O unit=MB    # 프로세스별 메모리
ps -ef
ps aux | sort -rn -k 3 | head    # CPU 상위
ps aux | sort -rn -k 4 | head    # 메모리 상위
procfiles -n PID           # 프로세스가 연 파일
procstack PID              # 스택
proctree PID               # 프로세스 트리
truss -p PID               # 시스템 콜 추적
```

`vmstat` 메모리 값(`avm`, `fre`)은 기본이 4KB 페이지 수입니다. `vmstat`의 `pi`, `po`가 계속 0이 아니면 페이징 공간을 쓰고 있다는 뜻입니다.

## 스토리지 (LVM·JFS2)

### 조회

```
lspv                       # 디스크 목록과 소속 VG
lsvg                       # 전체 VG
lsvg -o                    # 활성 VG
lsvg rootvg                # VG 상세 (FREE PPs 가 남은 공간)
lsvg -l rootvg             # VG 안의 LV
lslv hd4                   # LV 상세
lsps -a                    # 페이징 공간
df -g                      # 파일 시스템 사용량 (GB)
lsfs                       # 파일 시스템 목록
du -sk * | sort -n         # 폴더별 사용량 (KB)
lspath                     # 멀티패스 경로
```

### 변경

```
cfgmgr                     # 새 장치 인식
chfs -a size=+1G /tmp      # 파일 시스템 1GB 늘리기
extendvg datavg hdisk2     # VG 에 디스크 추가
mkvg -y datavg hdisk2      # 새 VG 만들기
crfs -v jfs2 -g datavg -a size=10G -m /data -A yes
mount /data
```

`chfs`로 늘리려면 VG에 여유 PP가 있어야 합니다. `mkvg`, `extendvg`는 대상 디스크가 비어 있는지 `lspv`로 먼저 확인하세요.

## 서비스 (SRC·inittab)

```
lssrc -a                   # 전체 서비스
lssrc -g tcpip             # 그룹별
lssrc -s sshd
startsrc -s sshd
stopsrc -s sshd
refresh -s sshd            # 설정 다시 읽기
lsitab -a                  # 부팅 시 실행 항목 (/etc/inittab)
lsitab 이름
crontab -l
```

cron 기록은 `/var/adm/cron/log`에 남습니다.

## 사용자·보안

```
lsuser -f 사용자           # 전체 속성
lsuser -a account_locked unsuccessful_login_count 사용자
chuser account_locked=false 사용자           # 잠금 해제
chuser unsuccessful_login_count=0 사용자     # 실패 횟수 초기화
pwdadm 사용자              # 비밀번호 변경 (관리자)
pwdadm -c 사용자           # 다음 로그인 때 변경 요구 해제
mkuser pgrp=staff home=/home/kim kim
lsgroup ALL
ulimit -a                  # 현재 제한
chuser fsize=-1 사용자     # 파일 크기 제한 해제 (다음 로그인부터)
```

| 파일 | 내용 |
|---|---|
| `/etc/security/user` | 사용자별 로그인·비밀번호 정책 |
| `/etc/security/limits` | 사용자별 자원 제한 |
| `/etc/security/passwd` | 비밀번호 해시 |
| `/etc/security/failedlogin` | 실패한 로그인 (`who` 명령으로 읽기) |
| `/var/adm/sulog` | `su` 기록 |

```
who /etc/security/failedlogin | tail
last | head
```

IBM은 root 등 시스템 계정의 쉘을 ksh에서 바꾸면 스크립트가 실패할 수 있다고 안내합니다. `/usr/bin/sh`, `/usr/bin/ksh` 파일 자체는 절대 다른 파일로 교체하지 마세요. 부팅 단계에서 쓰입니다.

## 네트워크

```
ifconfig -a
netstat -rn                # 라우팅
netstat -in                # 인터페이스 통계
netstat -Aan | grep LISTEN # 대기 포트
entstat -d ent0            # 어댑터 상태 (링크, 속도, 오류)
lsattr -El en0             # IP 등 인터페이스 속성
no -a                      # 네트워크 튜닝 값
ping -c 3 대상
traceroute 대상
tcpdump -i en0 port 22
```

### 포트를 쓰는 프로세스 찾기

`netstat -Aan`의 첫 열(PCB 주소)을 `rmsock`에 넘깁니다.

```
netstat -Aan | grep '\.8080 '
rmsock 첫열주소 tcpcb
```

`rmsock`은 프로세스가 잡고 있는 소켓이면 해당 프로세스를 알려 주고, 프로세스가 없는 소켓이면 제거합니다.

### 설정 위치

- IP·라우팅: `smitty tcpip` 또는 `chdev -l en0 -a 속성=값` (`ifconfig`로 바꾼 값은 재부팅 후 사라집니다)
- DNS: `/etc/resolv.conf`, 조회 순서는 `/etc/netsvc.conf`의 `hosts=local,bind`
- 튜닝 영구 적용: `no -p -o 이름=값`

## 로그·오류

```
errpt                      # 오류 요약 (최신이 위)
errpt -a | more            # 상세
errpt -aj 식별자           # 특정 오류 상세
errpt -d H                 # 하드웨어 오류만
errpt -T PERM              # 영구 오류만
alog -L                    # alog 종류
alog -o -t boot            # 부팅 로그
alog -o -t console         # 콘솔 로그
```

`errpt` 열의 `T`는 유형(P 영구, T 일시, I 정보), `C`는 분류(H 하드웨어, S 소프트웨어)입니다.

syslog는 `/etc/syslog.conf`에 지정한 파일이 미리 있어야 기록됩니다.

```
touch /var/adm/messages
refresh -s syslogd
```

`errclear 0`은 오류 기록을 모두 지웁니다. 장애 분석에 필요할 수 있으니 필요할 때만 쓰세요.

## 패키지·패치

```
lslpp -L | grep 이름       # 설치 목록에서 찾기
lslpp -l bos.rte           # 파일셋 상태
lslpp -w /usr/bin/ksh      # 이 파일이 속한 파일셋
lslpp -f 파일셋            # 파일셋의 파일
lslpp -h 파일셋            # 설치 이력
lppchk -v                  # 파일셋 일관성 검사
instfix -i | grep ML       # TL 완성 여부
instfix -ik IJ12345        # APAR 적용 여부
emgr -l                    # 임시 수정(ifix) 목록
```

### 설치

```
installp -pagXYd /경로 파일셋    # -p 는 미리보기
installp -agXYd /경로 파일셋     # 설치
emgr -p -e 파일.epkg.Z           # ifix 미리보기
emgr -e 파일.epkg.Z              # ifix 적용
```

Toolbox가 구성되어 있으면 `/opt/freeware/bin/dnf`로 오픈소스 패키지를 설치할 수 있습니다.

## 부팅·종료·백업

```
bootlist -m normal -o      # 부팅 순서
bootinfo -s hdisk0         # 디스크 크기 (MB)
shutdown -Fr               # 즉시 재시작
shutdown -F                # 즉시 종료
mksysb -i /backup/host.mksysb     # rootvg 백업
savevg -if /backup/datavg.bak datavg
```

`-F`는 사용자에게 경고 없이 바로 진행합니다. 운영 서버에서는 접속 중인 서버가 맞는지 먼저 확인하세요.

## 공식 문서

- [AIX 7.3 문서](https://www.ibm.com/docs/en/aix/7.3)
- [AIX 7.2 문서](https://www.ibm.com/docs/en/aix/7.2)
- [AIX Toolbox for Open Source Software](https://www.ibm.com/support/pages/aix-toolbox-open-source-software-overview)
