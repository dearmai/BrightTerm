/** 터미널 출력에서 OTP 프롬프트 찾기 — 순수 함수(테스트용으로 의존성 없음) */

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[=>78DEHMc]/g

/**
 * 출력 끝의, 아직 줄이 바뀌지 않은 마지막 줄이 입력을 기다리는 프롬프트처럼 보이면 그 줄을 돌려준다.
 * 'OTP: ', 'Verification code? ', '[OTP] > ', 'Enter token (6 digits): ' 처럼 :·?·>·]·) 로 끝나야 한다.
 * 숫자나 *로 끝나면(코드를 이미 넣어 서버가 되울린 줄) 프롬프트가 아니다.
 */
export function pendingPromptLine(tail: string): string | null {
  const text = tail.replace(ANSI, '')
  const line = text.slice(Math.max(text.lastIndexOf('\n'), text.lastIndexOf('\r')) + 1)
  const t = line.trimEnd()
  if (!t || t.length > 200) return null
  return /[:?>\])：]$/.test(t) ? t : null
}
