import type { ReconnectPolicy } from './types'

export const DEFAULT_RECONNECT_POLICY: ReconnectPolicy = {
  initialDelaySec: 2, mode: 'exponential', incrementSec: 2, multiplier: 2, maxDelaySec: 30, maxAttempts: 8
}

/** 백업·동기화로 들어온 값에도 타이머 범위를 보장한다. 0회는 무제한이다. */
export function normalizeReconnectPolicy(input?: Partial<ReconnectPolicy> | null): ReconnectPolicy {
  const number = (value: unknown, fallback: number, min: number, max: number, integer = true): number =>
    typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, integer ? Math.round(value) : value)) : fallback
  const d = DEFAULT_RECONNECT_POLICY
  const initialDelaySec = number(input?.initialDelaySec, d.initialDelaySec, 1, 86400)
  return {
    initialDelaySec,
    mode: ['fixed', 'linear', 'exponential'].includes(input?.mode ?? '') ? input!.mode! : d.mode,
    incrementSec: number(input?.incrementSec, d.incrementSec, 1, 86400),
    multiplier: number(input?.multiplier, d.multiplier, 1, 10, false),
    maxDelaySec: Math.max(initialDelaySec, number(input?.maxDelaySec, d.maxDelaySec, 1, 86400)),
    maxAttempts: input?.maxAttempts === 0 ? 0 : typeof input?.maxAttempts === 'number' && input.maxAttempts < 0 ? d.maxAttempts : number(input?.maxAttempts, d.maxAttempts, 1, 1000)
  }
}

export function resolveReconnectPolicy(app?: Partial<ReconnectPolicy>, host?: Partial<ReconnectPolicy>): ReconnectPolicy {
  return normalizeReconnectPolicy(host ?? app)
}

/** attempt는 0부터 시작하는 다음 재시도의 번호다. */
export function reconnectDelay(policy: ReconnectPolicy, attempt: number): number {
  const p = normalizeReconnectPolicy(policy)
  const index = Math.max(0, Math.floor(attempt))
  const delay = p.mode === 'fixed' ? p.initialDelaySec : p.mode === 'linear'
    ? p.initialDelaySec + p.incrementSec * index : p.initialDelaySec * p.multiplier ** index
  return Math.min(p.maxDelaySec, Math.round(delay * 100) / 100)
}

export function canReconnect(policy: ReconnectPolicy, attempted: number): boolean {
  return policy.maxAttempts === 0 || attempted < policy.maxAttempts
}

/** 인증 정보가 틀려 다시 시도해도 같은 결과가 나오는 접속 실패인지 본다. ssh2는 level 을 'client-authentication' 으로 준다 */
export function isAuthFailure(error: unknown): boolean {
  const level = (error as { level?: unknown } | null)?.level
  if (level === 'client-authentication') return true
  const message = error instanceof Error ? error.message : String(error ?? '')
  return /All configured authentication methods failed|사용자 이름이 입력되지 않았습니다/i.test(message)
}
