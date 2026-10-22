import type { Host, TmuxCheck, TmuxSessionInfo } from '@shared/types'

/**
 * 세션 유지(tmux). 접속 뒤 셸에 한 줄을 입력해 tmux 세션에 붙는다 — 세션이 없으면 만들고
 * (마우스 스크롤 켜기·상태 줄 끄기, 자동 실행 명령은 그 안에서), 있으면 그대로 다시 붙는다.
 * 창을 닫거나 앱을 꺼도 tmux 세션과 안의 프로그램(Claude Code 등)은 계속 돈다.
 * tmux 가 없으면 안내를 찍고 자동 실행 명령만 평소처럼 실행한다.
 * 셸 문법은 POSIX(sh·bash·zsh). tmux 쪽은 sh -c 로 감싸 사용자 셸과 무관하게 돈다.
 */

const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

const slug = (s: string | undefined): string =>
  (s ?? '').normalize('NFKD').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)

export function tmuxName(h: Host): string {
  const cwdBase = h.local?.cwd?.trim().replace(/[\\/]+$/, '').split(/[\\/]/).pop()
  const base = slug(h.persistName) || slug(h.alias) || slug(cwdBase) || h.id.slice(0, 8)
  return h.persistName?.trim() ? base : `bt-${base}`
}

/** Windows 로컬(PowerShell·cmd)에는 tmux 가 없다 — WSL 셸일 때만 */
export function persistSupported(h: Host): boolean {
  if (!h.persist) return false
  if (h.protocol === 'ssh') return true
  if (h.protocol !== 'local') return false
  if (process.platform !== 'win32') return true
  return /(^|[\\/])wsl(\.exe)?$/i.test(h.local?.shell?.trim() ?? '')
}

/** tmux 마우스 모드 — 켜면 휠로 tmux 스크롤, 끄면 드래그 선택을 터미널이 직접 한다. 지정하지 않으면 켠다 */
export const tmuxMouse = (h: Host): boolean => h.persistMouse ?? true

/** 이미 있는 tmux 세션의 마우스 모드를 바꾸는 sh 스크립트 */
export const tmuxMouseScript = (name: string, on: boolean): string => `tmux set-option -t ${q(`=${name}`)} mouse ${on ? 'on' : 'off'} >/dev/null\n`

/** 접속 직후 셸에 입력할 한 줄 — 세션 유지가 아니면 자동 실행 명령 그대로. session 은 고른 tmux 세션(없으면 기본 이름) */
export function startupLine(h: Host, session?: string): string | undefined {
  const startup = h.startupCommand?.trim() || undefined
  if (!persistSupported(h)) return startup
  const n = session || tmuxName(h)
  const t = q(`=${n}`)
  const create = [
    `tmux new-session -d -s ${q(n)} -c "$PWD"`,
    `tmux set-option -t ${q(n)} status off >/dev/null`,
    ...(startup ? [`tmux send-keys -t ${q(n)} -l ${q(startup)}`, `tmux send-keys -t ${q(n)} Enter`] : [])
  ].join(' && ')
  // 마우스 모드는 붙을 때마다 서버 설정대로 — 이미 있던 세션도 맞춘다
  const mouse = `tmux set-option -t ${t} mouse ${tmuxMouse(h) ? 'on' : 'off'} >/dev/null 2>&1`
  const inner = `tmux has-session -t ${t} 2>/dev/null || { ${create}; }; ${mouse}; TMUX= exec tmux attach-session -t ${t}`
  const missing = h.protocol === 'ssh'
    ? `echo 'BrightTerm: 서버에 tmux 가 없어 세션 유지를 쓰지 않습니다 (서버 편집 → 세션 유지 → 서버 확인에서 설치할 수 있습니다)'`
    : `echo 'BrightTerm: tmux 가 없어 세션 유지를 쓰지 않습니다 (설치: macOS brew install tmux / Ubuntu sudo apt install tmux)'`
  return ` if command -v tmux >/dev/null 2>&1; then sh -c ${q(inner)}; else ${missing}${startup ? `; ${startup}` : ''}; fi`
}

/* ── SSH 서버의 tmux 세션 고르기 ── 서버마다 기본 이름(bt-별칭) 과 새로 만든 bt-별칭-2, -3 … 을 그 서버 것으로 본다 */

/** 이 서버의 tmux 세션 목록을 찍는 sh 스크립트. tmux 가 없으면 BT_NOTMUX */
export const TMUX_LIST_SCRIPT = [
  'command -v tmux >/dev/null 2>&1 || { echo BT_NOTMUX; exit 0; }',
  `tmux list-sessions -F '#{session_name}|#{session_created}|#{session_activity}|#{session_attached}|#{pane_current_command}' 2>/dev/null`,
  'echo BT_OK'
].join('\n') + '\n'

export const tmuxKillScript = (name: string): string => `tmux kill-session -t ${q(`=${name}`)} 2>/dev/null\n`

const ownedBy = (base: string, name: string): boolean => name === base || (name.startsWith(base + '-') && /^\d+$/.test(name.slice(base.length + 1)))

/** null 이면 서버에 tmux 가 없다 */
export function parseTmuxList(out: string, base: string): TmuxSessionInfo[] | null {
  if (out.includes('BT_NOTMUX') || !out.includes('BT_OK')) return null
  const list: TmuxSessionInfo[] = []
  for (const line of out.split(/\r?\n/)) {
    const [name, created, activity, attached, command] = line.split('|')
    if (!name || command === undefined || !ownedBy(base, name)) continue
    list.push({ name, created: +created * 1000, activity: +activity * 1000, attached: +attached || 0, command })
  }
  return list.sort((a, b) => b.activity - a.activity)
}

/** 새 세션 이름 — 기본 이름이 비어 있으면 그것, 아니면 -2, -3 … */
export function nextTmuxName(base: string, taken: string[]): string {
  if (!taken.includes(base)) return base
  let i = 2
  while (taken.includes(`${base}-${i}`)) i++
  return `${base}-${i}`
}

/** 서버 확인 — tmux 버전, 배포판, root·sudo, 패키지 관리자 */
export const TMUX_CHECK_SCRIPT = [
  'command -v tmux >/dev/null 2>&1 && echo "TMUX=$(tmux -V 2>/dev/null)"',
  '[ -r /etc/os-release ] && ( . /etc/os-release; echo "OS=${PRETTY_NAME:-$ID}" )',
  '[ "$(uname -s 2>/dev/null)" = Darwin ] && echo "OS=macOS $(sw_vers -productVersion 2>/dev/null)"',
  'echo "UID=$(id -u)"',
  'command -v sudo >/dev/null 2>&1 && echo SUDO=1',
  'for p in apt-get dnf yum zypper apk pacman brew; do command -v $p >/dev/null 2>&1 && echo "PM=$p"; done',
  'echo BT_OK'
].join('\n') + '\n'

const INSTALL: Record<string, string[]> = {
  'apt-get': ['apt-get update', 'apt-get install -y tmux'],
  dnf: ['dnf install -y tmux'],
  yum: ['yum install -y tmux'],
  zypper: ['zypper --non-interactive install tmux'],
  apk: ['apk add tmux'],
  pacman: ['pacman -S --noconfirm tmux']
}

export function parseTmuxCheck(out: string): TmuxCheck {
  if (!out.includes('BT_OK')) throw new Error(`서버 정보를 읽지 못했습니다${out.trim() ? `: ${out.trim().slice(0, 200)}` : ' (sh 를 실행할 수 없는 서버일 수 있습니다)'}`)
  const val = (k: string): string | undefined => out.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim()
  const version = val('TMUX')
  const root = val('UID') === '0'
  const sudo = out.includes('SUDO=1')
  const pms = [...out.matchAll(/^PM=(\S+)$/gm)].map((m) => m[1])
  const pm = Object.keys(INSTALL).find((p) => pms.includes(p))
  let installCommand: string | undefined
  if (pm) installCommand = INSTALL[pm].map((c) => (root ? c : `sudo ${c}`)).join(' && ')
  else if (pms.includes('brew')) installCommand = 'brew install tmux'
  return {
    installed: !!version,
    version,
    os: val('OS'),
    installCommand,
    needsAdmin: !!pm && !root && !sudo
  }
}
