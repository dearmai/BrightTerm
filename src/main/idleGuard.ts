// 유휴 방지 명령 — 셸의 TMOUT 으로 끊기기 전에 명령을 보낸다.
// 잘못 보내면 vi 나 SQL 프롬프트에 글자가 들어가므로, 셸 프롬프트가 확실할 때만 보낸다.
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[=>78DEHMc]/g

/** 경고를 본 뒤 이만큼 잠잠하면 보낸다 — 경고 뒤에 프롬프트가 다시 그려질 시간 */
const WARNING_QUIET_MS = 3000

/** ksh 가 TMOUT 이 다 되면 내는 경고. 셸이 입력을 기다릴 때만 나온다 (뒤에 프롬프트가 다시 올 수 있음) */
const TIMEOUT_WARNING = /shell will time out in \d+ seconds\s*[^\n]*$/

/** 끝이 $ # % > 인 줄, 또는 user@host [/경로] 형태(AIX 등의 PS1) — [y/n] 같은 질문과 구분하려고 user@host 까지 본다 */
const PROMPT = /[$#%>]\s*$|\S+@\S+\s+\[[~/][^\]]*\]\s*$/
/** 프롬프트처럼 보이지만 셸이 아닌 것: DB·FTP 등의 프롬프트(같은 이름의 계정 mysql@db 는 셸), 이어 쓰기, 질문, 진행률 */
const NOT_SHELL = /^\s*(?:(?:SQL|RMAN|DGMGRL|mysql|MariaDB|postgres|psql|sqlite|ftp|sftp|gdb|dbx|db2|mongo|redis|irb|pdb)\b(?!\S*@)|>>>|\.\.\.)|[=-][#>]\s*$|^\s*>\s*$|\?|\d%\s*$|password|passphrase|암호|비밀번호/i

/** 커서를 옮겼으면 그 뒤만 현재 줄이다 — vi 처럼 화면을 그리는 프로그램은 여기서 걸러진다 */
function currentLine(tail: string): string {
  const parts = tail.split(/[\r\n]|\x1b\[[0-9;]*[Hf]/)
  return parts[parts.length - 1].replace(ANSI, '').replace(/[\x00-\x1f\x7f]/g, '')
}

/** 정규식 대신 * 와일드카드를 쓴다. *는 줄바꿈을 넘지 않는다. */
function matchesPromptLine(line: string, pattern: string): boolean {
  let i = 0, j = 0, star = -1, retry = 0
  while (i < line.length) {
    if (j < pattern.length && pattern[j] !== '*' && pattern[j] === line[i]) { i++; j++ }
    else if (pattern[j] === '*') { star = j++; retry = i }
    else if (star >= 0) { j = star + 1; i = ++retry }
    else return false
  }
  while (pattern[j] === '*') j++
  return j === pattern.length
}

export function isShellPrompt(tail: string, example?: string): boolean {
  const line = currentLine(tail)
  if (PROMPT.test(line) && !NOT_SHELL.test(line)) return true
  if (!example?.trim() || example.length > 1000) return false
  // SQL·비밀번호 등의 프롬프트는 추가 예시로도 허용하지 않는다. 단독 >는 여러 줄 예시로 확인한다.
  if (NOT_SHELL.test(line) && !/^\s*>\s*$/.test(line)) return false
  // 화면 이동·지우기는 프롬프트 문맥을 끊는다. ANSI 색상과 CRLF는 허용한다.
  const visible = tail.replace(/\x1b\[[0-9;]*[HfABCDGJK]/g, '\x00').replace(ANSI, '')
  const actual = visible.split(/\r\n|\r|\n/)
  const expected = example.trimEnd().split(/\r\n|\r|\n/)
  if (actual.length < expected.length || expected.length > 8) return false
  const suffix = actual.slice(-expected.length)
  return expected.every((pattern, index) => !suffix[index].includes('\x00') && matchesPromptLine(suffix[index].trimEnd(), pattern.trimEnd()))
}

/** 대체 화면(vi·less·top·tmux) 상태 — 마지막으로 켜고 끈 값을 따른다 */
export function nextAltScreen(current: boolean, output: string): boolean {
  let alt = current
  for (const m of output.matchAll(/\x1b\[\?([0-9;]*)([hl])/g)) {
    if (m[1].split(';').some((p) => p === '1049' || p === '1047' || p === '47')) alt = m[2] === 'h'
  }
  return alt
}

/** 터미널이 프로그램의 질의에 자동으로 보내는 응답 — 사용자 입력이 아니다 (장치 속성, 커서 위치, 창 포커스 등) */
export function isTerminalReport(data: string): boolean {
  return /^(?:\x1b\[[?>]?[0-9;]*[cRntIO]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1bP[^\x1b]*\x1b\\)+$/.test(data)
}

export interface IdleView {
  shellPromptExample?: string
  /** 최근 서버 출력 끝부분 */
  tail: string
  altScreen: boolean
  /** 사용자가 Enter 없이 입력 중이다 — 보내면 입력하던 줄에 붙어 실행된다 */
  lineOpen: boolean
  /** 마지막 입력·출력 뒤로 지난 시간 */
  idleMs: number
  intervalMs: number
}

export function shouldSendIdleCommand(v: IdleView): boolean {
  if (v.altScreen || v.lineOpen) return false
  if (TIMEOUT_WARNING.test(v.tail.replace(ANSI, '').replace(/\x07/g, ''))) return v.idleMs >= WARNING_QUIET_MS
  return v.idleMs >= v.intervalMs && isShellPrompt(v.tail, v.shellPromptExample)
}
