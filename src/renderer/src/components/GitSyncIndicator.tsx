import { useEffect, useRef, useState } from 'react'
import { CircleCheck, CircleAlert, GitBranch, GitMerge, KeyRound, LockKeyhole, RefreshCw, X } from 'lucide-react'
import type { GitSyncStatus } from '@shared/types'
import { api } from '../api'
import { useApp } from '../state'

const states = {
  disabled: { icon: GitBranch, label: 'Git 동기화 꺼짐', color: 'var(--text-3)' },
  idle: { icon: GitBranch, label: 'Git 동기화 대기', color: 'var(--text-2)' },
  syncing: { icon: RefreshCw, label: 'Git 동기화 중', color: 'var(--accent)' },
  synced: { icon: CircleCheck, label: 'Git 동기화 완료', color: 'var(--ok)' },
  locked: { icon: LockKeyhole, label: 'Git 동기화: 잠금 해제 대기', color: 'var(--warn)' },
  conflict: { icon: GitMerge, label: 'Git 동기화 충돌', color: 'var(--warn)' },
  'password-required': { icon: KeyRound, label: 'Git 동기화: 비밀번호 확인 필요', color: 'var(--warn)' },
  error: { icon: CircleAlert, label: 'Git 동기화 실패', color: 'var(--danger)' }
}

type ProblemState = 'error' | 'conflict' | 'password-required'
interface Notice { state: ProblemState; message: string }

const advice: Record<ProblemState, string> = {
  error: '로컬 변경은 보존됩니다. 연결과 인증 설정을 확인하세요. 30초 후 자동 재시도합니다.',
  conflict: '자동 덮어쓰기를 중단했습니다. 설정에서 사용할 데이터를 선택하세요.',
  'password-required': '원격 볼트를 열 수 없습니다. 설정에서 원격 볼트의 마스터 비밀번호를 확인하세요.'
}

export function GitSyncIndicator(): JSX.Element {
  const [status, setStatus] = useState<GitSyncStatus | null>(null)
  const [failed, setFailed] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const lastProblem = useRef('')
  useEffect(() => {
    let current = true
    let received = false
    const receive = (next: GitSyncStatus): void => {
      setFailed(false)
      setStatus(next)
      if (next.state === 'error' || next.state === 'conflict' || next.state === 'password-required') {
        const key = JSON.stringify([next.state, next.message, next.config.remote, next.config.branch])
        // A retry's syncing → same error must not reopen a dismissed notice.
        if (lastProblem.current !== key) {
          lastProblem.current = key
          setNotice({ state: next.state, message: next.message })
        }
      } else if (next.state !== 'syncing') {
        setNotice(null)
        lastProblem.current = ''
      }
    }
    const unsubscribe = api.on.gitSync((next) => {
      received = true
      receive(next)
    })
    api.gitSync.status().then((next) => {
      if (current && !received) receive(next)
    }).catch(() => {
      if (current && !received) {
        setFailed(true)
        setNotice({ state: 'error', message: 'Git 동기화 상태를 확인하지 못했습니다. 설정에서 다시 확인하세요.' })
      }
    })
    return () => { current = false; unsubscribe() }
  }, [])
  const view = status ? states[status.state] : {
    icon: failed ? CircleAlert : GitBranch,
    label: failed ? 'Git 동기화 상태 확인 실패' : 'Git 동기화 상태 확인 중',
    color: failed ? 'var(--danger)' : 'var(--text-3)'
  }
  const Icon = view.icon
  const title = [view.label, status?.message,
    status?.lastSync ? `마지막 동기화: ${new Date(status.lastSync).toLocaleString()}` : '',
    '클릭하여 Git 동기화 설정 열기'].filter(Boolean).join('\n')
  const openSettings = (): void => {
    setNotice(null)
    useApp.setState({ dialog: { kind: 'settings', section: 'git-sync' } })
  }
  return <div className="git-sync-anchor">
    <button
    className="ibtn git-sync-indicator"
    style={{ color: view.color }}
    title={title}
    aria-label={`${view.label} — 설정 열기`}
    data-state={status?.state ?? (failed ? 'error' : 'loading')}
    onClick={openSettings}
    ><Icon size={16} aria-hidden="true" /></button>
    {notice && <div className="git-sync-notice" role="alert" aria-atomic="true" data-state={notice.state}
      onKeyDown={(e) => {
        if (e.key === 'Escape') { e.stopPropagation(); setNotice(null) }
      }}>
      <div className="git-sync-notice-head">
        <strong>{states[notice.state].label}</strong>
        <button className="ibtn sm" aria-label="Git 동기화 알림 닫기" onClick={() => setNotice(null)}><X size={14} /></button>
      </div>
      <div className="git-sync-notice-message">{notice.message}</div>
      <div className="muted">{failed ? '설정을 열어 동기화 상태를 다시 확인할 수 있습니다.' : advice[notice.state]}</div>
      <button className="btn sm" onClick={openSettings}>동기화 설정 열기</button>
    </div>}
  </div>
}
