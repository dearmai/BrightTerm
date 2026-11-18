import type { TotpAlgorithm, TotpInput, TotpMeta, TotpPurpose } from './types'

export const TOTP_DEFAULT_META: TotpMeta = { purpose: 'server', digits: 6, period: 30, algorithm: 'SHA1' }

const BASE32 = /^[A-Z2-7]+$/

/** 공백·하이픈·= 패딩을 빼고 대문자로 — 인증 앱이 보여 주는 'abcd efgh ...' 형식도 받는다 */
export function normalizeBase32(s: string): string {
  return s.replace(/[\s=-]/g, '').toUpperCase()
}

export function isValidBase32(s: string): boolean {
  const n = normalizeBase32(s)
  // 80비트(16자) 미만은 RFC 4226 권장보다 짧지만, 실제로 쓰이는 짧은 키도 있어 8자부터 받는다
  return n.length >= 8 && BASE32.test(n)
}

/** otpauth://totp/Issuer:account?secret=...&issuer=...&digits=6&period=30&algorithm=SHA1 */
export function parseOtpauth(uri: string): (Partial<TotpMeta> & { secret: string; label?: string }) | null {
  let u: URL
  try {
    u = new URL(uri.trim())
  } catch {
    return null
  }
  if (u.protocol !== 'otpauth:') return null
  if (u.hostname.toLowerCase() !== 'totp') throw new Error('TOTP(시간 기반) URI만 지원합니다 — HOTP 는 지원하지 않습니다')
  const secret = u.searchParams.get('secret') ?? ''
  if (!secret) throw new Error('URI에 secret 이 없습니다')
  const label = decodeURIComponent(u.pathname.replace(/^\/+/, ''))
  const [labelIssuer, account] = label.includes(':') ? [label.slice(0, label.indexOf(':')), label.slice(label.indexOf(':') + 1)] : ['', label]
  const out: Partial<TotpMeta> & { secret: string; label?: string } = { secret, label }
  const issuer = u.searchParams.get('issuer') || labelIssuer
  if (issuer) out.issuer = issuer.trim()
  if (account) out.account = account.trim()
  const digits = Number(u.searchParams.get('digits'))
  if (digits) out.digits = digits as TotpMeta['digits']
  const period = Number(u.searchParams.get('period'))
  if (period) out.period = period
  const alg = u.searchParams.get('algorithm')
  if (alg) out.algorithm = alg.toUpperCase().replace('-', '') as TotpAlgorithm
  return out
}

const PURPOSES: TotpPurpose[] = ['server', 'app', 'other']
const ALGORITHMS: TotpAlgorithm[] = ['SHA1', 'SHA256', 'SHA512']

/** 입력값을 검사해 저장할 메타로 — 잘못된 값은 오류 */
export function normalizeTotpMeta(i: Partial<TotpMeta>, prev?: TotpMeta): TotpMeta {
  const base = { ...TOTP_DEFAULT_META, ...prev }
  const digits = i.digits ?? base.digits
  const period = i.period ?? base.period
  const algorithm = i.algorithm ?? base.algorithm
  const purpose = i.purpose ?? base.purpose
  if (![6, 7, 8].includes(digits)) throw new Error('TOTP 자릿수는 6~8 이어야 합니다')
  if (!Number.isInteger(period) || period < 10 || period > 300) throw new Error('TOTP 주기는 10~300초여야 합니다')
  if (!ALGORITHMS.includes(algorithm)) throw new Error('지원하지 않는 TOTP 알고리즘입니다')
  if (!PURPOSES.includes(purpose)) throw new Error('알 수 없는 TOTP 용도입니다')
  const text = (v: string | undefined, max: number): string | undefined => (v?.trim() ? v.trim().slice(0, max) : undefined)
  return {
    purpose, digits, period, algorithm,
    issuer: 'issuer' in i ? text(i.issuer, 120) : base.issuer,
    account: 'account' in i ? text(i.account, 200) : base.account,
    note: 'note' in i ? text(i.note, 1000) : base.note
  }
}

/** 붙여 넣은 비밀키 칸이 otpauth URI 면 그 안의 설정까지 채운다 */
export function resolveTotpInput(input: TotpInput): TotpInput {
  const raw = input.secret?.trim()
  if (!raw || !/^otpauth:/i.test(raw)) return input
  const p = parseOtpauth(raw)
  if (!p) throw new Error('otpauth URI 를 읽을 수 없습니다')
  const { secret, label: _label, ...meta } = p
  return { ...meta, ...stripUndefined(input), name: input.name, secret }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([k, v]) => v !== undefined && v !== '' && k !== 'secret')) as Partial<T>
}

function escapeRegex(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 프롬프트가 예시와 맞는지 — 대소문자·연속 공백 무시, 예시가 프롬프트 안에 들어 있으면 맞다. *는 아무 글자.
 * 예: 'Verification code' 는 'Verification code: ' 와, 'OTP*:' 는 'OTP for alice: ' 와 맞는다
 */
export function matchesPromptExample(prompt: string, example: string): boolean {
  const ex = example.trim().replace(/\s+/g, ' ')
  if (!ex || ex.replace(/\*/g, '').trim() === '') return false
  const text = prompt.replace(/\s+/g, ' ')
  const re = new RegExp(ex.split('*').map(escapeRegex).join('.*'), 'i')
  return re.test(text)
}

export function isTotpPrompt(prompt: string, examples: string[]): boolean {
  return examples.some((ex) => matchesPromptExample(prompt, ex))
}
