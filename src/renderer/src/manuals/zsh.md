# zsh

## 버전 확인

```
echo $SHELL                # 로그인 쉘
ps -p $$ -o comm=          # 지금 쉘
echo $ZSH_VERSION
```

RHEL 9은 5.8, RHEL 10은 5.9입니다. RHEL에는 기본으로 설치되지 않습니다.

```
sudo dnf install zsh
sudo usermod -s /bin/zsh 사용자   # 다음 로그인부터 적용
```

## bash와 다른 점

bash에 익숙하면 이 표부터 보세요. 스크립트에서 가장 자주 부딪히는 차이입니다.

| 항목 | bash | zsh |
|---|---|---|
| 배열 첫 번호 | 0 | 1 |
| `$v`의 단어 나누기 | 공백에서 나뉨 | 나뉘지 않음 |
| 일치하는 파일이 없는 `*.log` | 글자 그대로 | 오류 (`no matches found`) |
| `read -p` | 프롬프트 | 다른 뜻. `read '?프롬프트: ' v` 사용 |
| 파이프의 마지막 명령 | 하위 쉘 (값이 안 남음) | 현재 쉘 (값이 남음) |
| 시작 파일 | `.bashrc` 등 | `.zshrc` 등 |

```
v='a b c'
for x in $v; do print $x; done         # a b c 한 줄
for x in ${=v}; do print $x; done      # 세 줄 (나누기)

a=(x y z)
print $a[1]                            # x
```

- 일치하는 파일이 없어도 되는 곳에는 `*.log(N)`을 쓰면 빈 목록이 됩니다.
- `?`, `*`, `[`가 든 인자는 따옴표로 묶으세요. URL이 흔한 예입니다: `curl 'https://example.com/?a=1'`
- bash용 스크립트는 첫 줄을 `#!/usr/bin/env bash`로 해서 bash로 실행하세요. zsh 안에서 sh처럼 실행해야 하면 `emulate -L sh`를 씁니다.

## 시작 파일

읽는 순서입니다. 각 파일은 `/etc/`의 전역 파일을 먼저 읽고 `~/`의 파일을 읽습니다.

| 파일 | 읽는 때 |
|---|---|
| `.zshenv` | 항상 (스크립트 포함) |
| `.zprofile` | 로그인 쉘 |
| `.zshrc` | 대화형 쉘 |
| `.zlogin` | 로그인 쉘, `.zshrc` 뒤 |
| `.zlogout` | 로그인 쉘 종료 |

- `.zshenv`는 스크립트에서도 읽으므로 출력을 내거나 시간이 걸리는 명령을 넣지 마세요.
- RHEL의 `/etc/zshrc`는 `/etc/profile.d/`의 스크립트도 읽습니다.
- `ZDOTDIR`을 지정하면 `~/` 대신 그 폴더의 파일을 읽습니다.

```
# ~/.zshrc
export EDITOR=vim
HISTFILE=~/.zsh_history
HISTSIZE=10000
SAVEHIST=10000
setopt HIST_IGNORE_DUPS SHARE_HISTORY
autoload -Uz compinit && compinit
bindkey -e                 # emacs 키 (vi 는 bindkey -v)
alias ll='ls -l'
PROMPT='%n@%m %~ %# '
```

`SAVEHIST`와 `HISTFILE`을 지정하지 않으면 기록이 파일에 저장되지 않습니다.

## 프롬프트

| 표현 | 뜻 |
|---|---|
| `%n`, `%m` | 사용자, 호스트 |
| `%~`, `%1~` | 현재 폴더 전체, 마지막 이름 |
| `%#` | root면 `#`, 아니면 `%` |
| `%T`, `%*` | 시각 |
| `%?` | 직전 종료 코드 |
| `%F{red}…%f` | 글자색 |

```
PROMPT='%F{green}%n@%m%f %1~ %(?..%F{red}[%?]%f )%# '
RPROMPT='%T'               # 오른쪽 표시
```

`%(?..글자)`는 직전 명령이 실패했을 때만 글자를 표시합니다.

## 명령줄 편집·기록

| 키 (emacs 모드) | 동작 |
|---|---|
| `Ctrl+R` | 기록 검색 |
| `Ctrl+A`, `Ctrl+E` | 줄 처음·끝 |
| `Ctrl+U` | 줄 전체 지우기 (bash는 커서 앞만) |
| `Ctrl+W` | 앞 단어 지우기 |
| `Alt+.` | 직전 명령의 마지막 인자 |
| `Tab` | 완성 (`compinit` 필요) |

```
history -20
fc -l -20
!!                         # 직전 명령 다시 실행
bindkey                    # 현재 키 설정
setopt                     # 켜진 옵션
```

## 파일 패턴 (glob)

zsh의 큰 장점입니다. `find` 없이 대부분 해결됩니다.

```
print -l **/*.log          # 하위 폴더까지
print -l *(.)              # 일반 파일만
print -l *(/)              # 폴더만
print -l *(@)              # 링크만
print -l *(.om[1,3])       # 최근 수정 3개
print -l *(.Lm+10)         # 10MB 초과
print -l *(.mh-1)          # 1시간 이내 수정
print -l *.log(N)          # 없으면 빈 목록 (오류 없음)
```

`(...)` 안의 글자는 조건입니다. `.`파일, `/`폴더, `@`링크, `om`수정 시간순, `L`크기, `m`수정 시각, `N`없어도 오류 없음입니다.

`setopt EXTENDED_GLOB`을 켜면 제외 패턴도 씁니다.

```
setopt EXTENDED_GLOB
print -l *~*.bak           # .bak 제외
```

파일 이름 일괄 변경:

```
autoload -Uz zmv
zmv -n '(*).log' '$1.txt'  # -n 은 미리 보기. 확인 뒤 -n 을 빼고 실행
```

## 변수와 확장

bash와 같은 `${v:-기본}`, `${v##패턴}`, `${v%패턴}`, `${v//a/b}`를 쓸 수 있습니다. zsh에는 `(...)` 플래그가 더 있습니다.

```
f=/var/log/app.tar.gz
print ${f:t}               # app.tar.gz (마지막 이름)
print ${f:h}               # /var/log (폴더)
print ${f:r}               # /var/log/app.tar (확장자 제거)
print ${f:e}               # gz (확장자)

v='a,b,c'
print -l ${(s:,:)v}        # 쉼표로 나누기 (세 줄)
print ${(U)v}              # A,B,C
a=(c a b)
print ${(o)a}              # a b c (정렬)
print ${(j:-:)a}           # c-a-b (잇기)
```

## 배열

```
names=(kim lee park)
print $names[1]            # kim (1부터)
print $names[-1]           # park
print $#names              # 3
names+=(choi)
for n in $names; do print $n; done

typeset -A port            # 연관 배열
port[http]=80
port[https]=443
print $port[https]         # 443
for k v in ${(kv)port}; do print "$k=$v"; done
```

`setopt KSH_ARRAYS`를 켜면 0부터 세지만 다른 스크립트와 어긋나므로 전역으로 켜지 마세요.

## 조건문·반복문

```
if [[ -f $file && -s $file ]]; then
  print "내용 있음"
elif [[ $name == app* ]]; then
  print "패턴 일치"
fi

if [[ $ver =~ '^([0-9]+)\.([0-9]+)$' ]]; then
  print "주 $match[1] 부 $match[2]"
fi

for f in *.log(N); do print $f; done
for ((i = 1; i <= 3; i++)); do print $i; done
repeat 3 print hi

while IFS= read -r line; do
  print -r -- $line
done < input.txt
```

정규식 결과는 `BASH_REMATCH`가 아니라 `$match`에 들어갑니다.

## 함수·입출력

```
backup() {
  local src=$1
  cp $src $src.bak || return 1
}

print -r -- $text          # 있는 그대로 출력
print -u2 오류             # 표준 오류로
print -P '%F{red}빨강%f'   # 프롬프트 표현 해석
read 'name?이름: '         # 프롬프트와 함께 입력
read -s 'pw?암호: '        # 화면에 표시하지 않음

cmd > out.log 2>&1
cmd &>> out.log
diff <(sort a) <(sort b)
cat <<'EOF'
$HOME 그대로
EOF
```

zsh는 기본으로 기존 파일 덮어쓰기를 허용합니다. `setopt NO_CLOBBER`를 켜면 `>|`로만 덮어씁니다.

## 스크립트·디버깅

```
#!/usr/bin/env zsh
emulate -L zsh             # 사용자 설정의 영향을 받지 않게
setopt ERR_EXIT NO_UNSET PIPE_FAIL
tmp=$(mktemp)
trap 'rm -f $tmp' EXIT
```

```
zsh -n script.zsh          # 실행하지 않고 문법 검사
zsh -x script.zsh          # 실행 과정 출력
zsh -f                     # 시작 파일 없이 실행 (설정 문제 가려내기)
whence -v 명령              # 명령 위치·종류
```

## 플러그인 프레임워크

Oh My Zsh 같은 프레임워크를 쓰면 `~/.zshrc`가 시작 시간과 프롬프트를 좌우합니다. 프롬프트가 깨지거나 느리면 `zsh -f`로 들어가 프레임워크 문제인지 먼저 가려내세요.

BrightTerm의 유휴 방지 명령은 프롬프트 모양을 보고 판단합니다. 프롬프트가 `$ # % >`로 끝나지 않고 `사용자@호스트 [경로]` 형태도 아니면 셸로 인식하지 못합니다.

## TMOUT (자동 로그아웃)

`TMOUT`을 초 단위로 설정하면 프롬프트에서 입력 없이 그 시간이 지났을 때 쉘이 종료됩니다. ksh와 달리 60초 전 경고 없이 `zsh: timeout`을 찍고 바로 끝납니다. `TRAPALRM` 함수를 정의하면 종료하는 대신 그 함수를 실행합니다.

```
echo $TMOUT
typeset -p TMOUT           # 읽기 전용이면 -r 표시
grep -n TMOUT /etc/zshenv /etc/zprofile /etc/zshrc ~/.zshenv ~/.zprofile ~/.zshrc
```

SSH Keepalive는 연결만 유지하므로 `TMOUT`을 막지 못합니다. 정책이 허용한다면 서버 편집 → 고급의 **유휴 방지 명령**을 쓸 수 있습니다. 경고가 없으므로 간격을 `TMOUT`보다 짧게 지정해야 합니다.

## 공식 문서

- [Zsh 설명서](https://zsh.sourceforge.io/Doc/Release/)
- [Zsh 시작 파일](https://zsh.sourceforge.io/Doc/Release/Files.html)
- [파일 패턴 (Filename Generation)](https://zsh.sourceforge.io/Doc/Release/Expansion.html#Filename-Generation)
- [Zsh 사용자 안내서](https://zsh.sourceforge.io/Guide/zshguide.html)
