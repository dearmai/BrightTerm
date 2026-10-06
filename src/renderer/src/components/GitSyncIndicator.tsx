import { useEffect, useState } from 'react'
import { CircleCheck, CircleAlert, GitBranch, GitMerge, KeyRound, LockKeyhole, RefreshCw } from 'lucide-react'
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

export function GitSyncIndicator(): JSX.Element {
  const [status, setStatus] = useState<GitSyncStatus | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let current = true
    let received = false
    const unsubscribe = api.on.gitSync((next) => {
      received = true
      setFailed(false)
      setStatus(next)
    })
    api.gitSync.status().then((next) => {
      if (current && !received) setStatus(next)
    }).catch(() => { if (current && !received) setFailed(true) })
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
  return <button
    className="ibtn git-sync-indicator"
    style={{ color: view.color }}
    title={title}
    aria-label={`${view.label} — 설정 열기`}
    data-state={status?.state ?? (failed ? 'error' : 'loading')}
    onClick={() => useApp.setState({ dialog: { kind: 'settings', section: 'git-sync' } })}
  ><Icon size={16} aria-hidden="true" /></button>
}
