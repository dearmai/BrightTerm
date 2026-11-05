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

export class ConnectLog {
  private head: string[] = []
  private tail: string[] = []
  private dropped = 0

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
