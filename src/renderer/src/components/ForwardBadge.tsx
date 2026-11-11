import { useState } from 'react'
import { createPortal } from 'react-dom'
import type { SessionInfo } from '@shared/types'
import { Modal } from './ui'
import { forwardHealthStatus as status, forwardHealthLabel as label, overallForwardHealth } from '../forwardStatus'

function bytes(value = 0): string {
  if (value < 1024) return `${value} B`
  const unit = Math.min(3, Math.floor(Math.log(value) / Math.log(1024)))
  return `${(value / 1024 ** unit).toFixed(1)} ${['B', 'KB', 'MB', 'GB'][unit]}`
}

export function ForwardBadge({ info }: { info?: SessionInfo }): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const forwards = info?.state === 'connected' ? info.forwards ?? [] : []
  if (!forwards.length && !open) return null
  const overall = overallForwardHealth(forwards)
  const summary = forwards.map((f) => `${f.type} ${f.bindHost || '127.0.0.1'}:${f.bindPort} → ${f.destHost}:${f.destPort}: ${label[status(f)]}${f.error || f.healthError ? ` (${f.error || f.healthError})` : ''}`).join('\n')
  return <>
    {!!forwards.length && <button type="button" className={`ph-forward forward-${overall}`}
      title={`${summary}\n클릭하여 TCP 점검 결과와 통계 보기`} aria-label={`포트 포워딩 ${label[overall]} ${forwards.length}개`} aria-haspopup="dialog" aria-expanded={open}
      onMouseDown={(e) => e.stopPropagation()} onClick={() => setOpen(true)}>
      <span className="forward-light" aria-hidden="true" />포워딩 {label[overall]} {forwards.length}
    </button>}
    {open && createPortal(<Modal title="포트 포워딩 모니터" size="sm" className="forward-monitor" onClose={() => setOpen(false)}>
      <div className="forward-monitor-body" role="dialog" aria-label="포트 포워딩 모니터">
        <div className="muted">{info?.title} · {info?.target}</div>
        {!forwards.length && <p>연결이 종료되었거나 활성 포워딩이 없습니다.</p>}
        {forwards.map((f) => <section className="forward-card" key={f.id}>
          <div className="forward-card-head"><strong>{f.type === 'L' ? '로컬 (L)' : '원격 (R)'}</strong><span className={`forward-health forward-${status(f)}`}><span className="forward-light" aria-hidden="true" />{label[status(f)]}</span></div>
          <div className="forward-route">{f.bindHost || '127.0.0.1'}:{f.bindPort} → {f.destHost}:{f.destPort}</div>
          {(f.error || f.healthError) && <div className="forward-error">{f.error || f.healthError}</div>}
          <div className="muted forward-check">{f.state === 'active' ? '리스너 할당됨' : f.state === 'error' ? '리스너 오류' : '리스너 준비 중'} · 목적지 TCP {f.health === 'healthy' ? '접속 성공' : f.health === 'unhealthy' ? '접속 실패' : '확인 중'}{f.checkedAt ? ` · ${new Date(f.checkedAt).toLocaleTimeString()}` : ''}</div>
          <dl className="forward-stats">
            <div><dt>현재 TCP 연결</dt><dd>{f.connections ?? 0}</dd></div>
            <div><dt>누적 TCP 연결</dt><dd>{f.totalConnections ?? 0}</dd></div>
            <div><dt>↑ 송신</dt><dd>{bytes(f.sentBytes)}</dd></div>
            <div><dt>↓ 수신</dt><dd>{bytes(f.receivedBytes)}</dd></div>
          </dl>
        </section>)}
        <p className="muted forward-note">TCP 점검은 시작 시와 이후 15초마다 수행합니다(제한 5초).<br />L: SSH 서버에서 목적지 접속, R: 이 PC에서 목적지 접속을 확인합니다. 원격 리스너의 외부 접근 여부와 서비스 로그인은 확인하지 않습니다.<br />점검 연결은 통계에서 제외합니다.<br />통계는 0.5초마다 갱신 · 공유 포워딩 시작 이후의 합계입니다.<br />같은 서버의 세션이 포워딩과 통계를 공유합니다. TCP 연결 수는 DB 로그인 수와 다릅니다.<br />송신: 포워딩 입구 → 목적지, 수신: 반대 방향. SSH 오버헤드는 제외합니다.</p>
      </div>
    </Modal>, document.body)}
  </>
}
