# ksh (Korn shell)

## 어떤 ksh인지 확인

AIX에는 `/usr/bin/ksh`(기본)와 `/usr/bin/ksh93`(Enhanced Korn shell)이 함께 있습니다. 둘은 문법이 일부 다릅니다.

```
echo $SHELL                # 로그인 쉘
echo $0                    # 지금 쉘
ps -p $$                   # 지금 쉘 프로세스
what /usr/bin/ksh          # 버전 문자열
what /usr/bin/ksh93
```

`/usr/bin/ksh`는 ksh88 계열로 알려져 있지만, IBM 문서에 7.2·7.3의 버전이 명시되어 있지는 않으니 서버에서 확인하세요. 아래 명령은 ksh93이면 버전을 출력하고 ksh88이면 오류가 납니다.

```
print ${.sh.version}
```

## 시작 파일·프롬프트

| 파일 | 읽는 때 |
|---|---|
| `/etc/profile`, `~/.profile` | 로그인 쉘 |
| `$ENV`가 가리키는 파일 | 대화형 쉘을 시작할 때마다 |

```
# ~/.profile
export ENV=$HOME/.kshrc
export EDITOR=vi
export HISTSIZE=2000

# ~/.kshrc
set -o vi
PS1="$(hostname):"'$PWD $ '
alias ll='ls -l'
```

`PS1`의 `$PWD`는 작은따옴표 안에 두어야 프롬프트를 표시할 때마다 새로 계산됩니다. 함수와 alias는 `export`로 넘어가지 않으니 `.kshrc`에 둡니다.

## 명령줄 편집·기록

기본 설정에서는 줄 편집이 꺼져 있을 수 있습니다. `set -o vi` 또는 `set -o emacs`로 켭니다.

| 동작 | vi 모드 (Esc 후) | emacs 모드 |
|---|---|---|
| 이전 명령 | `k` | `Ctrl+P` |
| 다음 명령 | `j` | `Ctrl+N` |
| 기록 검색 | `/글자` Enter | `Ctrl+R` |
| 줄 처음·끝 | `0`, `$` | `Ctrl+A`, `Ctrl+E` |
| 파일 이름 완성 | `\` | `Esc Esc` |

```
fc -l                      # 최근 기록
fc -l -30
r                          # 직전 명령 다시 실행
r vi                       # vi 로 시작한 마지막 명령 다시 실행
```

### 키가 이상할 때

Backspace가 `^?`로 찍히면 지우기 키를 맞춥니다.

```
stty erase '^?'            # 또는 stty erase '^H'
stty -a                    # 현재 키 설정
```

방향키로 기록을 넘기는 동작은 ksh 버전과 설정에 따라 다릅니다. 안 되면 위 표의 키를 쓰세요.

## 변수와 확장

```
name=value                 # = 양옆에 공백 없음
export PATH=$PATH:/opt/freeware/bin
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
| `${v#패턴}`, `${v##패턴}` | 앞에서 짧게·길게 제거 |
| `${v%패턴}`, `${v%%패턴}` | 뒤에서 짧게·길게 제거 |

```
f=/var/log/app.tar.gz
print ${f##*/}             # app.tar.gz
print ${f%/*}              # /var/log
print ${f%%.*}             # /var/log/app
```

### typeset

```
typeset -i n=0             # 정수
typeset -u up=abc          # 대문자로 저장
typeset -l low=ABC         # 소문자로 저장
typeset -Z5 z=42           # 00042
typeset -L10 left          # 왼쪽 정렬 10자리
typeset -R10 right         # 오른쪽 정렬 10자리
typeset -x name=value      # export
```

### 특수 변수

| 변수 | 뜻 |
|---|---|
| `$?` | 직전 종료 코드 |
| `$$` | 쉘 PID |
| `$!` | 마지막 백그라운드 PID |
| `$#` | 인자 개수 |
| `"$@"` | 인자 전체 (각각 유지) |
| `$PPID`, `$PWD`, `$OLDPWD` | 부모 PID, 현재·이전 폴더 |
| `$RANDOM`, `$SECONDS`, `$LINENO` | 난수, 경과 초, 줄 번호 |

## 조건문

```
if [[ -f $file && -s $file ]]; then
  print "내용 있음"
elif [[ $name == app* ]]; then
  print "패턴 일치"
else
  print "그 밖"
fi

if (( n > 10 )); then print big; fi

case $1 in
  start|run) print 시작 ;;
  stop)      print 중지 ;;
  *)         print "사용법: $0 start|stop"; exit 1 ;;
esac
```

| 검사 | 뜻 |
|---|---|
| `-f`, `-d`, `-L` | 파일, 폴더, 링크 |
| `-e`, `-s` | 존재, 크기가 0보다 큼 |
| `-r`, `-w`, `-x` | 읽기·쓰기·실행 권한 |
| `-z`, `-n` | 빈 문자열, 비지 않은 문자열 |
| `a -nt b`, `a -ot b` | a가 b보다 새로움, 오래됨 |
| `==`, `!=` | 패턴과 비교 (`[[ ]]` 안에서) |
| `-eq`, `-lt`, `-gt` | 숫자 비교 |

`[[ ]]` 안에서는 변수를 따옴표로 묶지 않아도 단어가 나뉘지 않습니다. `[ ]`에서는 묶어야 합니다.

## 반복문·산술

```
for f in *.log; do
  print "$f"
done

i=0
while (( i < 3 )); do
  print $i
  (( i += 1 ))
done

while IFS= read -r line; do
  print -r -- "$line"
done < input.txt
```

`for ((i=0;...))` 형식은 ksh88에서 쓸 수 없습니다. 위 `while`을 쓰면 양쪽에서 동작합니다.

파이프 마지막 명령은 현재 쉘에서 실행되므로 bash와 달리 값이 남습니다.

```
print hello | read v
print $v                   # hello
```

## 함수

```
function backup {
  typeset src=$1           # 이 함수 안에서만 쓰는 변수
  cp "$src" "$src.bak" || return 1
}

backup /etc/hosts
print $?
```

`function 이름 { }` 형식에서는 `typeset`이 지역 변수를 만듭니다. `이름() { }` 형식의 범위는 ksh 버전마다 다르니, ksh에서는 `function` 형식을 권장합니다.

## 배열

```
set -A names kim lee park
print ${names[0]}          # kim
print ${names[*]}          # 전체
print ${#names[*]}         # 개수
names[3]=choi

for n in "${names[@]}"; do print "$n"; done
```

`arr=(a b c)`와 `typeset -A`(연관 배열)는 ksh93 문법입니다.

## 입출력

```
print -r -- "$text"        # 있는 그대로 출력 (echo 보다 안전)
print -u2 "오류"           # 표준 오류로
print -n "입력: "          # 줄바꿈 없이
read -r answer
read -r name?"이름: "      # 프롬프트와 함께 입력

cmd > out.log 2>&1         # 출력과 오류를 함께 파일로
cmd >> out.log             # 이어 쓰기
cmd 2>/dev/null
cat <<'EOF'                # 여기 문서 (따옴표면 변수 확장 안 함)
$HOME 그대로
EOF
```

- `echo`는 `\n` 같은 역슬래시를 해석할 수 있어 내용이 그대로 나오지 않을 수 있습니다. 변수 값은 `print -r --`로 출력하세요.
- `set -o noclobber`를 켜면 `>`가 기존 파일을 덮어쓰지 않고, `>|`로만 덮어씁니다.

### 코프로세스

```
bc |&                      # 백그라운드로 실행하고 양방향 연결
print -p "1+2"
read -p result
print $result              # 3
```

## 작업 제어

```
jobs -l
fg %1
bg %1
kill %1
nohup ./long.sh > long.log 2>&1 &
whence -v 명령             # 명령 위치·종류 (which 대신)
```

## 스크립트 작성·디버깅

```
#!/usr/bin/ksh
set -u                     # 정의되지 않은 변수는 오류
tmp=/tmp/job.$$
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

```
ksh -n script.ksh          # 실행하지 않고 문법 검사
ksh -x script.ksh          # 실행 과정 출력
set -x                     # 스크립트 안에서 켜기 (set +x 로 끄기)
```

`PS4='$LINENO: '`를 설정하면 `-x` 출력에 줄 번호가 함께 나옵니다.

## TMOUT (자동 로그아웃)

`TMOUT`을 초 단위로 설정하면 입력 없이 그 시간이 지났을 때 쉘이 종료됩니다.

```
echo $TMOUT
typeset -r | grep TMOUT    # 읽기 전용인지 확인
```

보안 정책으로 `/etc/profile`에서 `readonly`로 지정된 경우가 많아 사용자가 바꾸지 못할 수 있습니다. SSH Keepalive는 연결만 유지하므로 `TMOUT`을 막지 못합니다. 정책이 허용한다면 서버 편집 → 고급의 **유휴 방지 명령**을 쓸 수 있습니다.

## ksh88과 ksh93 차이

주로 ksh93에서만 되는 문법입니다. 스크립트를 양쪽에서 돌리려면 사용하지 마세요.

| 기능 | ksh93 문법 | ksh88 대안 |
|---|---|---|
| 부분 문자열 | `${v:1:3}` | `expr`, `cut`, `typeset -L` |
| 치환 | `${v/a/b}`, `${v//a/b}` | `sed` |
| 배열 대입 | `arr=(a b c)` | `set -A arr a b c` |
| 연관 배열 | `typeset -A m; m[key]=1` | 없음 |
| C식 반복 | `for ((i=0;i<3;i++))` | `while (( ... ))` |
| 소수 계산 | `(( x = 1.5 * 2 ))` | `bc`, `awk` |
| 내장 `printf` | `printf '%05d\n' 42` | 외부 `/usr/bin/printf` |
| 파이프 실패 감지 | `set -o pipefail` | 없음 |

- 스크립트 첫 줄에 `#!/usr/bin/ksh93`처럼 쓸 쉘을 명시하세요.
- AIX의 ksh93은 오래된 릴리스일 수 있어 최신 ksh93 설명서의 기능이 모두 되지는 않습니다. `print ${.sh.version}`으로 확인하세요.
- bash 전용 문법(`[[ =~ ]]`, `<<<`, `source`, `declare`)은 ksh88에서 쓸 수 없습니다. 파일 읽기는 `. ./파일`로 합니다.

## 공식 문서

- [AIX에서 쓸 수 있는 쉘](https://www.ibm.com/docs/en/ssw_aix_72/osmanagement/avail_shells.html)
- [ksh93 명령](https://www.ibm.com/docs/en/ssw_aix_72/k_commands/ksh93.html)
- [root 등 시스템 계정의 기본 쉘 변경 안내](https://www.ibm.com/support/pages/can-i-change-root-or-another-system-account-users-default-shell)
