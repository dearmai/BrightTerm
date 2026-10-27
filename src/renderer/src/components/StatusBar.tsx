import { useEffect, useState } from 'react'
import { Lock, Unlock, ImageUp, Radio, Download, X, GitBranch } from 'lucide-react'
import { useApp } from '../state'
import { api } from '../api'
import { focusedEntry } from '../terms'
import { SC } from '../platform'
import { findPane } from '../layout'
import type { GitSyncStatus, SessionMetrics, UpdateInfo } from '@shared/types'

function dur(ms: number): string {
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const z = (n: number): string => String(n).padStart(2, '0')
  return `${z(h)}:${z(m)}:${z(s % 60)}`
}

function uptime(seconds: number | null | undefined): string {
  if (seconds == null) return '—'
  if (seconds < 60) return '1분 미만'
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor(seconds / 3600) % 24
  const minutes = Math.floor(seconds / 60) % 60
  return [days ? `${days}일` : '', hours ? `${hours}시간` : '', `${minutes}분`].filter(Boolean).join(' ')
}

/** 닫은 새 버전 알림 — 그 버전만 다시 안 띄운다(더 새 버전이 나오면 다시 뜬다) */
const DISMISS_KEY = 'bt.update.dismissed'
const readDismissed = (): string | null => {
  try {
    return localStorage.getItem(DISMISS_KEY)
  } catch {
    return null
  }
}

const STATE_LABEL: Record<string, string> = { connected: '연결됨', connecting: '접속 중', reconnecting: '재접속 대기', closed: '끊김', error: '실패' }

export function StatusBar(): JSX.Element {
  const s = useApp((st) => {
    const tab = st.tabs.find((t) => t.id === st.activeTab)
    const pane = tab && findPane(tab.root, tab.focused)
    return pane ? st.sessions[pane.sessionId] : undefined
  })
  const [sample, setSample] = useState<{ id: string; metrics: SessionMetrics | null } | null>(null)
  useEffect(() => {
    if (!s || s.state !== 'connected') { setSample(null); return }
    const id = s.id
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async (): Promise<void> => {
      const metrics = await api.session.metrics(id).catch(() => null)
      if (cancelled) return
      setSample({ id, metrics })
      timer = setTimeout(poll, 5000)
    }
    void poll()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [s?.id, s?.state, s?.connectedAt])
  const metrics = s?.state === 'connected' && sample?.id === s.id ? sample.metrics : null
  const pct = (value: number | null | undefined): string => value == null ? '—' : `${value.toFixed(1)}%`
  const vault = useApp((st) => st.vault)
  const tab = useApp((st) => st.tabs.find((t) => t.id === st.activeTab))
  const hosts = useApp((st) => st.hosts)
  const fontFamily = useApp((st) => st.settings.fontFamily)
  const checkUpdates = useApp((st) => st.settings.checkUpdates)
  const [update, setUpdate] = useState<UpdateInfo | null>(null)
  const [sync, setSync] = useState<GitSyncStatus | null>(null)
  useEffect(() => {
    api.gitSync.status().then(setSync).catch(() => undefined)
    return api.on.gitSync(setSync)
  }, [])
  const [dismissed, setDismissed] = useState(readDismissed)
  const [, tick] = useState(0)
  useEffect(() => {
    api.update.get().then(setUpdate).catch(() => undefined)
    return api.on.update((u) => {
      setUpdate(u)
      // 실행 중 처음 알게 된 새 버전은 한 번 알려 준다(닫아 둔 버전·알림 끔이면 조용히)
      if (u && u.version !== readDismissed() && useApp.getState().settings.checkUpdates) {
        useApp.getState().toast('info', `BrightTerm ${u.version}이 나왔습니다 — 아래 상태 표시줄의 '새 버전'을 누르면 내려받기 페이지가 열립니다`)
      }
    })
  }, [])
  const dismiss = (v: string): void => {
    setDismissed(v)
    try {
      localStorage.setItem(DISMISS_KEY, v)
    } catch {
      /* 저장 못 해도 이번 실행에서는 닫힌다 */
    }
  }
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 1000)
    return () => clearInterval(t)
  }, [])
  const e = focusedEntry()
  const host = s?.hostId ? hosts.find((h) => h.id === s.hostId) : undefined
  return (
    <div className="statusbar" style={{ fontFamily }}>
      {s ? (
        <>
          <span className="sb-item sb-session" title={`현재 활성 서버: ${s.title} · ${s.target}`} style={{ color: s.color ?? 'var(--text)' , fontWeight: 600 }}><span className={`dot ${s.state}`} /><span>{s.title}</span></span>
          <span className="sb-item sb-target" title={s.target}>{s.target}</span>
          <span className="sb-item">{STATE_LABEL[s.state]}{s.state === 'connected' && s.connectedAt ? ` · ${dur(Date.now() - s.connectedAt)}` : s.message ? ` · ${s.message}` : ''}</span>
          <span className="sb-item sb-metric" title="SSH 명령의 왕복 응답 시간입니다. 점프 호스트·프록시 경로와 서버의 명령 처리 시간을 포함하며 ICMP ping과 다릅니다. 로컬·Telnet·시리얼은 지원하지 않습니다.">Ping {metrics?.pingMs == null ? '—' : `${metrics.pingMs} ms`}</span>
          <span className="sb-item sb-metric" title="서버 전체 CPU 사용률 · 약 1초간 측정 · 활성 세션만 주기적으로 갱신 · 조회할 수 없으면 —">CPU {pct(metrics?.cpu)}</span>
          <span className="sb-item sb-metric" title="메모리 사용률 · Linux: MemAvailable 기준, macOS: 여유·비활성·speculative 페이지를 제외한 비율 · 조회할 수 없으면 —">Memory {pct(metrics?.memory)}</span>
          <span className="sb-item sb-metric" title="루트(/) 파일시스템 디스크 사용률(df 기준) · 조회할 수 없으면 —">Disk {pct(metrics?.disk)}</span>
          <span className="sb-item sb-metric sb-uptime" title="서버가 마지막으로 부팅된 후 경과한 시간 · 현재 SSH 연결 시간과 별개 · 조회할 수 없으면 —">Uptime {uptime(metrics?.uptimeSec)}</span>
          {tab?.broadcast && <span className="sb-item bc"><Radio size={11} />동시 입력 ON</span>}
        </>
      ) : (
        <span className="sb-item muted">연결된 세션 없음</span>
      )}
      <span className="sb-fill" />
      {sync?.config.enabled && <span className="sb-item sb-btn" title={sync.message}
        style={{ color: ['error', 'conflict', 'password-required'].includes(sync.state) ? 'var(--danger)' : undefined }}
        onClick={() => useApp.setState({ dialog: { kind: 'settings', section: 'git-sync' } })}>
        <GitBranch size={12} />{sync.state === 'syncing' ? 'Git 동기화 중' : sync.state === 'synced' ? 'Git 동기화됨' : sync.state === 'locked' ? 'Git 잠금 해제 대기' : ['conflict', 'password-required'].includes(sync.state) ? 'Git 확인 필요' : sync.state === 'error' ? 'Git 동기화 실패' : 'Git 동기화 대기'}
      </span>}
      {checkUpdates && update && update.version !== dismissed && (
        <span className="sb-item sb-update">
          <span className="sb-btn" title="릴리스 페이지를 브라우저로 엽니다" onClick={() => api.app.openExternal(update.url)}><Download size={12} />새 버전 {update.version}</span>
          <span className="sb-btn sb-x" title="이 버전 알림 닫기" onClick={() => dismiss(update.version)}><X size={11} /></span>
        </span>
      )}
      {(s?.canSftp || s?.protocol === 'local') && s.state === 'connected' && <span className="sb-item muted sb-image-hint" title={s.protocol === 'local' ? '클립보드 이미지를 이 PC에 저장하고 경로를 입력합니다 (Claude Code 등 CLI에서 이미지 첨부)' : '클립보드 이미지를 서버에 올리고 경로를 입력합니다 (Claude Code 등 CLI에서 이미지 첨부)'}><ImageUp size={12} />이미지 붙여넣기 {SC.paste}</span>}
      {host && <span className="sb-item">{(host.encoding || 'utf-8').toUpperCase()}</span>}
      {e && <span className="sb-item">{e.term.cols}×{e.term.rows}</span>}
      <span className="sb-item sb-btn" title={vault.unlocked ? '클릭하면 볼트를 잠급니다' : '볼트 잠김'} onClick={() => vault.unlocked && api.vault.lock()}>
        {vault.unlocked ? <Unlock size={12} /> : <Lock size={12} />}{vault.unlocked ? '볼트 열림' : '볼트 잠김'}
      </span>
    </div>
  )
}
