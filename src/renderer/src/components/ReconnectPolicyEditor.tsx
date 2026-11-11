import type { ReconnectPolicy } from '@shared/types'
import { normalizeReconnectPolicy, reconnectDelay } from '@shared/reconnect'
import { Field, Seg } from './ui'

export function ReconnectPolicyEditor({ value, onChange, disabled = false }: { value?: ReconnectPolicy; onChange: (value: ReconnectPolicy) => void; disabled?: boolean }): JSX.Element {
  const policy = normalizeReconnectPolicy(value)
  const set = (patch: Partial<ReconnectPolicy>): void => onChange(normalizeReconnectPolicy({ ...policy, ...patch }))
  const numeric = (key: 'initialDelaySec' | 'incrementSec' | 'multiplier' | 'maxDelaySec' | 'maxAttempts', label: string, min: number, max: number, hint?: string, step = 1): JSX.Element => (
    <Field label={label} hint={hint}><input className="input" type="number" aria-label={label} min={min} max={max} step={step} value={policy[key]}
      onChange={(e) => { if (e.target.value !== '') set({ [key]: Number(e.target.value) }) }} /></Field>
  )
  const preview = Array.from({ length: Math.min(policy.maxAttempts || 6, 6) }, (_, i) => reconnectDelay(policy, i)).join(' → ')
  return <fieldset className="reconnect-policy" disabled={disabled}>
    <div className="grid2">
      {numeric('initialDelaySec', '첫 재시도 대기 (초)', 1, 86400)}
      {numeric('maxAttempts', '최대 재시도 횟수', 0, 1000, '0 = 무제한')}
    </div>
    <Field label="대기 시간 증가 방식">
      <Seg value={policy.mode} onChange={(mode) => set({ mode })} options={[{ value: 'fixed', label: '고정' }, { value: 'linear', label: '일정 시간 증가' }, { value: 'exponential', label: '배수 증가' }]} />
    </Field>
    <div className="grid2">
      {policy.mode === 'linear' && numeric('incrementSec', '매회 추가 대기 (초)', 1, 86400)}
      {policy.mode === 'exponential' && numeric('multiplier', '매회 증가 배수', 1, 10, undefined, 0.1)}
      {policy.mode !== 'fixed' && numeric('maxDelaySec', '최대 대기 (초)', policy.initialDelaySec, 86400)}
    </div>
    <div className="hint">대기 순서: {preview}초{!policy.maxAttempts || policy.maxAttempts > 6 ? ' …' : ''}<br />재접속에 성공하면 대기 시간과 연속 재시도 횟수를 초기화합니다. 처음 접속부터 실패한 경우에는 자동 재시도하지 않습니다. 변경한 값은 다음 재시도 예약부터 적용됩니다.</div>
  </fieldset>
}
