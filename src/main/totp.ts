import type { CredentialMeta, Host, HostTotpItem, TotpCode, TotpInput } from '@shared/types'
import { isTotpPrompt, isValidBase32, matchesPromptExample, normalizeBase32, normalizeTotpMeta, resolveTotpInput } from '@shared/totp'
import { vault } from './vault'
import { base32Decode, remainingSec, totpAt } from './totpCore'

function metaOf(id: string): CredentialMeta {
  const m = vault.list().find((c) => c.id === id)
  if (!m || m.kind !== 'totp' || !m.totp) throw new Error('TOTP 항목을 찾을 수 없습니다')
  return m
}

/** 지금 코드 — 볼트가 잠겨 있으면 오류 */
export function totpCode(id: string, timeMs = Date.now()): TotpCode & { name: string } {
  const m = metaOf(id)
  const secret = vault.get(id)?.totpSecret
  if (!secret) throw new Error(`TOTP "${m.name}" 의 비밀키가 없습니다`)
  const key = base32Decode(secret)
  try {
    return { id, name: m.name, code: totpAt(key, m.totp!, timeMs), remaining: remainingSec(m.totp!.period, timeMs), period: m.totp!.period }
  } finally {
    key.fill(0)
  }
}

/** 설정 화면 표시용 — 볼트가 잠겨 있으면 빈 목록 */
export function totpCodes(ids?: string[]): TotpCode[] {
  if (!vault.isUnlocked()) return []
  const list = vault.list().filter((c) => c.kind === 'totp' && (!ids || ids.includes(c.id)))
  const out: TotpCode[] = []
  for (const c of list) {
    try {
      const { name: _n, ...code } = totpCode(c.id)
      out.push(code)
    } catch { /* 깨진 항목은 건너뛴다 */ }
  }
  return out
}

export function saveTotp(input: TotpInput): CredentialMeta {
  const i = resolveTotpInput(input)
  const name = i.name?.trim()
  if (!name) throw new Error('TOTP 이름을 입력하세요')
  const prev = i.id ? vault.list().find((c) => c.id === i.id) : undefined
  if (i.id && (!prev || prev.kind !== 'totp')) throw new Error('TOTP 항목을 찾을 수 없습니다')
  const secret = i.secret?.trim() ? normalizeBase32(i.secret) : undefined
  if (secret !== undefined && !isValidBase32(secret)) throw new Error('TOTP 비밀키가 올바른 Base32 형식이 아닙니다 (A-Z, 2-7, 8자 이상)')
  if (!prev && !secret) throw new Error('TOTP 비밀키를 입력하세요')
  const { id: _id, name: _name, secret: _secret, ...metaInput } = i
  const totp = normalizeTotpMeta(metaInput, prev?.totp)
  if (secret) totpAt(base32Decode(secret), totp, Date.now()) // 알고리즘·키를 저장 전에 한 번 확인
  return vault.save_({ id: i.id, name: name.slice(0, 120), kind: 'totp', totp, ...(secret ? { totpSecret: secret } : {}) })
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * 한 번의 SSH 로그인에서 keyboard-interactive 의 OTP 프롬프트에 답한다.
 * 서버에 고른 TOTP 를 순서대로 한 번씩 쓴다 — 자기 프롬프트 예시가 있는 항목은 그 프롬프트에만 쓴다.
 * 다 쓰고도 다시 물으면(코드 거부) null 을 돌려 사용자에게 직접 묻게 한다.
 */
export class TotpResponder {
  private used = new Set<number>()

  private constructor(private items: HostTotpItem[], private examples: string[], private onInfo?: (msg: string) => void) {}

  static for(host: Host, examples: string[], onInfo?: (msg: string) => void): TotpResponder | null {
    const items = host.totp?.enabled ? host.totp.items.filter((x) => x.id) : []
    return items.length ? new TotpResponder(items, examples, onInfo) : null
  }

  /** 이 프롬프트가 OTP 를 묻는지 — 앱 템플릿이나 서버에 적은 프롬프트 예시와 맞으면 */
  matches(prompt: string): boolean {
    return this.items.some((x) => x.prompt?.trim() && matchesPromptExample(prompt, x.prompt)) || isTotpPrompt(prompt, this.examples)
  }

  private pick(prompt: string): number {
    const free = this.items.map((x, n) => [x, n] as const).filter(([, n]) => !this.used.has(n))
    const own = free.find(([x]) => x.prompt?.trim() && matchesPromptExample(prompt, x.prompt))
    if (own) return own[1]
    if (!isTotpPrompt(prompt, this.examples)) return -1
    return free.find(([x]) => !x.prompt?.trim())?.[1] ?? -1
  }

  get exhausted(): boolean {
    return this.used.size >= this.items.length
  }

  /** 프롬프트에 넣을 코드와 그 TOTP — 없으면 null (사용자에게 묻는다) */
  async answer(prompt: string): Promise<{ code: string; item: HostTotpItem } | null> {
    const n = this.pick(prompt)
    if (n < 0) {
      this.onInfo?.('자동 입력할 TOTP 가 더 없습니다 — OTP 를 직접 입력하세요')
      return null
    }
    this.used.add(n)
    try {
      let c = totpCode(this.items[n].id)
      // 코드가 곧 바뀌면 다음 코드를 기다린다 — 보내는 사이에 만료되지 않도록
      if (c.remaining <= 2) {
        await sleep(c.remaining * 1000 + 300)
        c = totpCode(this.items[n].id)
      }
      this.onInfo?.(`TOTP "${c.name}" 코드를 자동으로 입력했습니다`)
      return { code: c.code, item: this.items[n] }
    } catch (e) {
      this.onInfo?.(`TOTP 자동 입력 실패: ${(e as Error).message} — 직접 입력하세요`)
      return null
    }
  }
}
