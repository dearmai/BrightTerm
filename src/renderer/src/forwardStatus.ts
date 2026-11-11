import type { SessionForward } from '@shared/types'

export type ForwardHealthStatus = 'healthy' | 'checking' | 'unhealthy'
export const forwardHealthLabel = { healthy: '정상', checking: '확인 중', unhealthy: '이상' }
export function forwardHealthStatus(forward: SessionForward): ForwardHealthStatus {
  return forward.state === 'error' || forward.health === 'unhealthy' ? 'unhealthy'
    : forward.state === 'active' && forward.health === 'healthy' ? 'healthy' : 'checking'
}
export function overallForwardHealth(forwards: SessionForward[]): ForwardHealthStatus {
  return forwards.some((f) => forwardHealthStatus(f) === 'unhealthy') ? 'unhealthy'
    : forwards.some((f) => forwardHealthStatus(f) === 'checking') ? 'checking' : 'healthy'
}
