# bash

## 버전 확인

```
echo $SHELL                # 로그인 쉘
ps -p $$ -o comm=          # 지금 쉘
echo $BASH_VERSION
```

RHEL 9은 5.1, RHEL 10은 5.2입니다. macOS의 `/bin/bash`는 3.2로 오래되어 아래 기능 일부가 없습니다.

## 시작 파일·프롬프트

| 파일 | 읽는 때 |
|---|---|
| `/etc/profile`, 그다음 `~/.bash_profile` | 로그인 쉘 |
| `~/.bashrc` | 로그인이 아닌 대화형 쉘 |
| `~/.bash_logout` | 로그인 쉘 종료 |
| `$BASH_ENV`가 가리키는 파일 | 스크립트 실행 |

RHEL의 기본 `~/.bash_profile`은 `~/.bashrc`를 읽고, `~/.bashrc`는 `/etc/bashrc`와 `~/.bashrc.d/*`를 읽습니다. 그래서 alias와 함수는 `~/.bashrc`나 `~/.bashrc.d/`에 두면 양쪽에서 적용됩니다.

```
# ~/.bashrc
export EDITOR=vim
export HISTSIZE=10000
export HISTCONTROL=ignoredups:erasedups
export HISTTIMEFORMAT='%F %T '
shopt -s histappend
alias ll='ls -l'
PS1='\u@\h \w \$ '
```

| 프롬프트 | 뜻 |
|---|---|
| `\u`, `\h` | 사용자, 호스트 |
| `\w`, `\W` | 현재 폴더 전체, 마지막 이름 |
| `\$` | root면 `#`, 아니면 `$` |
| `\t` | 시각 |

## 명령줄 편집·기록

| 키 | 동작 |
|---|---|
| `Ctrl+R` | 기록 검색 |
| `Ctrl+A`, `Ctrl+E` | 줄 처음·끝 |
| `Ctrl+U`, `Ctrl+K` | 커서 앞·뒤 지우기 |
| `Ctrl+W` | 앞 단어 지우기 |
| `Alt+.` | 직전 명령의 마지막 인자 |
| `Tab` | 완성 |

```
history 20
!!                         # 직전 명령 다시 실행
!vi                        # vi 로 시작한 마지막 명령
sudo !!                    # 직전 명령을 sudo 로
set -o vi                  # vi 키 (기본은 emacs)
```

## 변수와 확장

```
name=value                 # = 양옆에 공백 없음
export PATH=$PATH:/opt/app/bin
readonly LIMIT=10
unset name
```

| 표현 | 뜻 |
|---|---|
| `${v:-기본}` | 비었으면 기본값 사용 |
| `${v:=기본}` | 비었으면 기본값을 넣고 사용 |
| `${v:?메시지}` | 비었으면 오류를 내고 종료 |
| `${v:+값}` | 값이 있으면 `값` 사용 |
| `${#v}` | 길이 |
| `${v:1:3}` | 부분 문자열 |
| `${v#패턴}`, `${v##패턴}` | 앞에서 짧게·길게 제거 |
| `${v%패턴}`, `${v%%패턴}` | 뒤에서 짧게·길게 제거 |
| `${v/a/b}`, `${v//a/b}` | 처음 하나·전부 바꾸기 |
| `${v^^}`, `${v,,}` | 대문자, 소문자로 |

```
f=/var/log/app.tar.gz
echo "${f##*/}"            # app.tar.gz
echo "${f%/*}"             # /var/log
echo "${f%%.*}"            # /var/log/app
echo "${f/log/tmp}"        # /var/tmp/app.tar.gz
```

변수는 큰따옴표로 묶으세요. 묶지 않으면 공백에서 나뉘고 `*`가 파일 이름으로 바뀝니다.

### 특수 변수

| 변수 | 뜻 |
|---|---|
| `$?` | 직전 종료 코드 |
| `$$`, `$!` | 쉘 PID, 마지막 백그라운드 PID |
| `$#` | 인자 개수 |
| `"$@"` | 인자 전체 (각각 유지) |
| `${PIPESTATUS[@]}` | 파이프 각 명령의 종료 코드 |
| `$LINENO`, `$FUNCNAME` | 줄 번호, 함수 이름 |
| `$RANDOM`, `$SECONDS` | 난수, 경과 초 |

## 조건문

```
if [[ -f $file && -s $file ]]; then
  echo "내용 있음"
elif [[ $name == app* ]]; then
  echo "패턴 일치"
fi

if [[ $ver =~ ^([0-9]+)\.([0-9]+)$ ]]; then
  echo "주 ${BASH_REMATCH[1]} 부 ${BASH_REMATCH[2]}"
fi

if (( n > 10 )); then echo big; fi

case $1 in
  start|run) echo 시작 ;;
  stop)      echo 중지 ;;
  *)         echo "사용법: $0 start|stop"; exit 1 ;;
esac
```

| 검사 | 뜻 |
|---|---|
| `-f`, `-d`, `-L` | 파일, 폴더, 링크 |
| `-e`, `-s` | 존재, 크기가 0보다 큼 |
| `-r`, `-w`, `-x` | 읽기·쓰기·실행 권한 |
| `-z`, `-n` | 빈 문자열, 비지 않은 문자열 |
| `a -nt b`, `a -ot b` | a가 b보다 새로움, 오래됨 |
| `==`, `!=`, `=~` | 패턴, 정규식 비교 (`[[ ]]` 안에서) |
| `-eq`, `-lt`, `-gt` | 숫자 비교 |

`=~` 오른쪽의 정규식은 따옴표로 묶지 마세요. 묶으면 글자 그대로 비교합니다.

## 반복문·산술

```
for f in *.log; do
  [[ -e $f ]] || continue   # 일치하는 파일이 없을 때 대비
  echo "$f"
done

for ((i = 0; i < 3; i++)); do echo "$i"; done

while IFS= read -r line; do
  printf '%s\n' "$line"
done < input.txt

echo $(( 7 / 2 ))           # 3 (정수만)
```

### 파이프와 변수

파이프의 각 명령은 하위 쉘에서 실행되므로 `while` 안에서 바꾼 값이 밖에 남지 않습니다. ksh와 다른 점입니다.

```
count=0
printf 'a\nb\n' | while read -r x; do (( count++ )); done
echo "$count"               # 0

count=0
while read -r x; do (( count++ )); done < <(printf 'a\nb\n')
echo "$count"               # 2
```

## 함수

```
backup() {
  local src=$1             # 이 함수 안에서만 쓰는 변수
  cp "$src" "$src.bak" || return 1
}

backup /etc/hosts
echo $?
```

`return`은 종료 코드(0–255)만 돌려줍니다. 값은 `echo`로 출력해 `result=$(함수)`로 받습니다.

## 배열

```
names=(kim lee park)
echo "${names[0]}"          # kim (0부터)
echo "${#names[@]}"         # 3
names+=(choi)
for n in "${names[@]}"; do echo "$n"; done

declare -A port             # 연관 배열
port[http]=80
port[https]=443
echo "${port[https]}"       # 443
for k in "${!port[@]}"; do echo "$k=${port[$k]}"; done

mapfile -t lines < input.txt  # 파일을 줄 단위 배열로
```

## 입출력

```
printf '%s\n' "$text"      # 있는 그대로 출력 (echo 보다 안전)
printf '%05d\n' 42         # 00042
read -r -p "이름: " name
read -r -s -p "암호: " pw   # 화면에 표시하지 않음

cmd > out.log 2>&1         # 출력과 오류를 함께 파일로
cmd &>> out.log            # 함께 이어 쓰기
cmd 2>/dev/null
diff <(sort a) <(sort b)   # 명령 출력을 파일처럼
grep foo <<< "$text"       # 문자열을 표준 입력으로
cat <<'EOF'                # 여기 문서 (따옴표면 변수 확장 안 함)
$HOME 그대로
EOF
```

`set -o noclobber`를 켜면 `>`가 기존 파일을 덮어쓰지 않고, `>|`로만 덮어씁니다.

## 작업 제어

```
jobs -l
fg %1
bg %1
kill %1
nohup ./long.sh > long.log 2>&1 &
disown %1                  # 쉘을 닫아도 끝나지 않게
type -a 명령                # 명령 위치·종류
```

## 스크립트 작성·디버깅

```
#!/usr/bin/env bash
set -euo pipefail
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT

while getopts "f:v" opt; do
  case $opt in
    f) file=$OPTARG ;;
    v) verbose=1 ;;
    *) exit 2 ;;
  esac
done
shift $((OPTIND - 1))
```

| 옵션 | 뜻 |
|---|---|
| `set -e` | 명령이 실패하면 종료 (`if`·`\|\|` 안에서는 예외) |
| `set -u` | 정의되지 않은 변수는 오류 |
| `set -o pipefail` | 파이프 중간의 실패도 실패로 |

```
bash -n script.sh          # 실행하지 않고 문법 검사
bash -x script.sh          # 실행 과정 출력
set -x                     # 스크립트 안에서 켜기 (set +x 로 끄기)
export PS4='+ ${BASH_SOURCE}:${LINENO}: '   # -x 출력에 파일과 줄 번호
```

## TMOUT (자동 로그아웃)

`TMOUT`을 초 단위로 설정하면 프롬프트에서 입력 없이 그 시간이 지났을 때 쉘이 종료됩니다. ksh와 달리 60초 전 경고 없이 `timed out waiting for input: auto-logout`을 찍고 바로 끝납니다.

```
echo "$TMOUT"
readonly -p | grep TMOUT   # 읽기 전용인지 확인
grep -rn TMOUT /etc/profile /etc/profile.d/ /etc/bashrc ~/.bash_profile ~/.bashrc
```

보안 정책으로 `readonly`로 지정된 경우가 많아 사용자가 바꾸지 못할 수 있습니다. SSH Keepalive는 연결만 유지하므로 `TMOUT`을 막지 못합니다. 정책이 허용한다면 서버 편집 → 고급의 **유휴 방지 명령**을 쓸 수 있습니다. 경고가 없으므로 간격을 `TMOUT`보다 짧게 지정해야 합니다.

## 공식 문서

- [GNU Bash 설명서](https://www.gnu.org/software/bash/manual/bash.html)
- [Bash 시작 파일](https://www.gnu.org/software/bash/manual/bash.html#Bash-Startup-Files)
- [Bash FAQ (Greg's Wiki)](https://mywiki.wooledge.org/BashFAQ)
