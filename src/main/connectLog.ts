// 접속 상세 로그 (ssh -v 대신) — 메모리에만 두고 탭을 닫으면 사라진다. 파일에 쓰지 않는다.
// 오래 켜 둬도 처음 접속 과정과 최근 끊김이 모두 남도록 앞·뒤 줄을 따로 보관한다.
const HEAD_LINES = 1000
const TAIL_LINES = 1000
const MAX_LINE_CHARS = 2000

/** 패킷마다 찍히는 줄 — 양이 많을 뿐 아니라 길이로 입력 내용(비밀번호 길이 등)을 짐작할 수 있어 남기지 않는다 */
const NOISE = /\b(?:CHANNEL_DATA|CHANNEL_EXTENDED_DATA|CHANNEL_WINDOW_ADJUST)\b/

function stamp(d: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}

/** 접속 실패 때 터미널에 보일 진단 줄 수 */
const SUMMARY_LINES = 40
const ATTEMPT_LINES = 3000

/** ssh -v 에서 원인 파악에 쓰는 줄 — ssh2 debug 원문 기준. 점프 서버 줄은 앞에 [별칭] 이 붙는다 */
const KEY_LINE = [
  /^Client: Trying /,
  /^Socket (?:error|timeout)/i,
  /^Remote ident:/,
  /^Handshake: (?:KEX algorithm|Host key format|C->S cipher|S->C cipher):/i,
  /^Handshake completed/,
  /^Host (?:denied|accepted \(verified\))/,
  /USERAUTH_(?:REQUEST|FAILURE|SUCCESS|BANNER|INFO_REQUEST|PK_OK)/,
  /^Client: .* auth failed/,
  /DISCONNECT/,
  /\b(?:fail(?:ed|ure)?|error|denied|refused|reset|timed? ?out|no matching|unsupported|unable)\b/i,
  /^오류 원문:/
]
/** 협상 실패면 양쪽이 내놓은 알고리즘 목록이 원인이다 */
const OFFER_LINE = /^Handshake: \((?:local|remote)\) /
/** 서버가 식별 문자열도 보내기 전에 끊은 경우만 의미가 있다 */
const EARLY_CLOSE = /^Socket (?:ended|closed)/
const SCOPE = /^(\[[^\]]*\] )?(.*)$/s

/** 이번 접속 시도의 원문 줄에서 ssh -v 처럼 원인 파악에 필요한 줄만 고른다 */
export function summarizeAttempt(lines: string[]): string[] {
  const body = (l: string): string => SCOPE.exec(l)![2]
  const identified = lines.some((l) => body(l).startsWith('Remote ident:'))
  const handshakeFailed = identified && !lines.some((l) => body(l).startsWith('Handshake completed'))
  const picked: string[] = []
  for (const line of lines) {
    const b = body(line)
    if (!(KEY_LINE.some((re) => re.test(b)) || (handshakeFailed && OFFER_LINE.test(b)) || (!identified && EARLY_CLOSE.test(b)))) continue
    if (picked[picked.length - 1] !== line) picked.push(line.length > 600 ? `${line.slice(0, 600)}…` : line)
  }
  // 인증: 서버가 허용한 방식과 실제로 시도한 방식
  const allowed = [...lines.map(body).join('\n').matchAll(/USERAUTH_FAILURE \(([^)]*)\)/g)].pop()?.[1]
  if (allowed !== undefined) {
    const tried = [...new Set([...lines.map(body).join('\n').matchAll(/USERAUTH_REQUEST \(([^)]*)\)/g)].map((m) => m[1]).filter((m) => m !== 'none'))]
    picked.push(`인증 요약: 서버 허용 방식 ${allowed || '(없음)'} · 시도한 방식 ${tried.join(', ') || '(없음)'}`)
  }
  if (picked.length <= SUMMARY_LINES) return picked
  const head = 10
  return [...picked.slice(0, head), `… ${picked.length - SUMMARY_LINES}줄 생략 …`, ...picked.slice(picked.length - (SUMMARY_LINES - head - 1))]
}

export class ConnectLog {
  private head: string[] = []
  private tail: string[] = []
  private dropped = 0
  /** 이번 접속 시도의 원문 줄 (시각 없음) */
  private attempt: string[] = []

  /** 새 접속 시도 — 실패 진단은 이 뒤의 줄만 본다 */
  beginAttempt(): void {
    this.attempt = []
  }

  /** 이번 접속 시도의 핵심 줄 */
  attemptSummary(): string[] {
    return summarizeAttempt(this.attempt)
  }

  /** ssh2 debug 줄과 오류 원문 — 접속 진단 대상. 화면 안내(add)는 이미 터미널에 나오므로 진단에 넣지 않는다 */
  debug(message: string, now = new Date()): void {
    if (NOISE.test(message)) return
    this.attempt.push(message)
    if (this.attempt.length > ATTEMPT_LINES) this.attempt.splice(0, this.attempt.length - ATTEMPT_LINES)
    this.add(message, now)
  }

  add(message: string, now = new Date()): void {
    if (NOISE.test(message)) return
    const text = message.length > MAX_LINE_CHARS ? `${message.slice(0, MAX_LINE_CHARS)}…` : message
    const line = `${stamp(now)}  ${text}`
    if (this.head.length < HEAD_LINES) {
      this.head.push(line)
      return
    }
    this.tail.push(line)
    if (this.tail.length > TAIL_LINES) {
      this.tail.shift()
      this.dropped++
    }
  }

  text(): string {
    const gap = this.dropped ? [`… ${this.dropped}줄 생략 …`] : []
    return [...this.head, ...gap, ...this.tail].join('\n')
  }
}
