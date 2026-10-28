// 접속 후 실행 명령을 한 줄씩 보낸다 — 보낸 줄의 출력이 잠잠해지면(프롬프트) 다음 줄
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[=>78DEHMc]/g

/** 멈출 프롬프트 — 다음 줄이 비밀번호로 들어가지 않게 */
export const SECRET_PROMPT = /(password|passphrase|passcode|암호|비밀번호)[^\n]*[:：]\s*$/i

export interface StartupIO {
  write(line: string): void
  /** 마지막으로 서버 출력을 받은 시각 (ms) */
  lastOutputAt(): number
  /** 최근 서버 출력 끝부분 */
  tail(): string
  /** 재접속·종료되면 false — 남은 줄을 버린다 */
  alive(): boolean
  notice(message: string): void
}

export interface StartupTiming { firstMs: number; quietMs: number; maxWaitMs: number; pollMs: number }
export const STARTUP_TIMING: StartupTiming = { firstMs: 400, quietMs: 300, maxWaitMs: 5000, pollMs: 50 }

/** 출력이 quietMs 잠잠하면 끝 — 출력이 계속 나와도 maxWaitMs 뒤에는 끝 */
function outputQuiet(io: StartupIO, minMs: number, since: number, t: StartupTiming): Promise<void> {
  const start = Date.now()
  return new Promise((resolve) => {
    const tick = (): void => {
      const now = Date.now()
      const last = Math.max(io.lastOutputAt(), since)
      if (!io.alive() || now - start >= t.maxWaitMs || (now - start >= minMs && now - last >= t.quietMs)) resolve()
      else setTimeout(tick, t.pollMs)
    }
    tick()
  })
}

/** 비밀번호 프롬프트가 보이면 남은 줄은 보내지 않는다. 보낸 줄 수를 돌려준다 */
export async function typeStartup(lines: string[], io: StartupIO, t: StartupTiming = STARTUP_TIMING): Promise<number> {
  let since = Date.now()
  for (let i = 0; i < lines.length; i++) {
    await outputQuiet(io, i ? 0 : t.firstMs, since, t)
    if (!io.alive()) return i
    if (i && SECRET_PROMPT.test(io.tail().replace(ANSI, ''))) {
      io.notice(`비밀번호 입력을 기다려 남은 자동 실행 명령 ${lines.length - i}줄은 보내지 않았습니다`)
      return i
    }
    io.write(lines[i] + '\r')
    since = Date.now()
  }
  return lines.length
}
