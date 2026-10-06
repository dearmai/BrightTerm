import { useEffect, useState } from 'react'
import type { GitSyncConfig, GitSyncStatus } from '@shared/types'
import { api } from '../api'
import { useApp } from '../state'
import { Field, Toggle } from './ui'

export function GitSyncSettings(): JSX.Element {
  const [status, setStatus] = useState<GitSyncStatus | null>(null)
  const [config, setConfig] = useState<GitSyncConfig>({ enabled: false, remote: '', branch: 'main' })
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const toast = useApp.getState().toast
  useEffect(() => {
    let live = true
    api.gitSync.status().then((s) => { if (live) { setStatus(s); setConfig(s.config) } }).catch((e) => toast('error', e.message))
    const off = api.on.gitSync(setStatus)
    return () => { live = false; off() }
  }, [])
  const working = busy || status?.state === 'syncing'
  const dirty = !!status && (config.remote !== status.config.remote || config.branch !== status.config.branch || config.enabled !== status.config.enabled)
  const run = async (fn: () => Promise<GitSyncStatus>): Promise<void> => {
    setBusy(true)
    try { setStatus(await fn()) } catch (e) { toast('error', (e as Error).message) }
    finally { setBusy(false) }
  }
  const resolve = async (choice: 'local' | 'remote'): Promise<void> => {
    const ok = await useApp.getState().confirm({ title: choice === 'remote' ? '원격 데이터 가져오기' : '로컬 데이터 올리기',
      message: choice === 'remote' ? '현재 연결 목록과 볼트를 원격 내용으로 바꿀까요? 교체 전 로컬 데이터는 자동 백업됩니다.' : '현재 연결 목록과 볼트를 원격 저장소의 새 버전으로 올릴까요? 기존 원격 버전은 Git 기록에 남습니다.',
      danger: true, okText: choice === 'remote' ? '가져오기' : '올리기' })
    if (!ok) return
    const supplied = password
    setPassword('')
    await run(() => api.gitSync.resolve(choice, choice === 'remote' ? supplied || undefined : undefined))
  }
  return <>
    <h3>Git 동기화</h3>
    <div className="notice"><span>볼트와 연결 목록·폴더를 <b>함께 암호화</b>해 지정한 Git 저장소에 저장합니다. 다른 PC에서도 같은 저장소를 연결하세요. PC별 설정·SSH 호스트 키 신뢰 기록·OS 키링은 전송하지 않습니다.</span></div>
    <fieldset disabled={working || !status} style={{ border: 0, padding: 0, margin: 0, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <Field label="Git URL" hint="SSH 키 또는 Git 자격 증명 관리자에 등록된 인증을 사용합니다. URL에 비밀번호·토큰을 넣지 마세요.">
        <input className="input mono" aria-label="Git URL" placeholder="git@github.com:사용자/저장소.git" value={config.remote} onChange={(e) => setConfig({ ...config, remote: e.target.value })} />
      </Field>
      <Field label="브랜치"><input className="input mono" aria-label="동기화 브랜치" value={config.branch} onChange={(e) => setConfig({ ...config, branch: e.target.value })} /></Field>
      <div className="card"><Toggle label="자동 동기화" desc="앱 시작과 연결 정보·볼트 변경 시 동기화합니다. 잠겨 있으면 잠금 해제 후 암호화 데이터를 적용합니다." value={config.enabled} onChange={(enabled) => setConfig({ ...config, enabled })} /></div>
      <div className="row">
        <button className="btn primary" onClick={() => run(async () => { const s = await api.gitSync.configure(config); setConfig(s.config); toast('ok', 'Git 동기화 설정을 저장했습니다'); return s })}>설정 저장</button>
        <button className="btn" disabled={!status?.config.enabled || dirty} onClick={() => run(api.gitSync.sync)}>지금 동기화</button>
      </div>
    </fieldset>
    {status && <div className="card" role="status" style={{ marginTop: 16 }}>
      <div>{status.message}</div>
      <div className="muted">{status.lastSync ? `최근 성공: ${new Date(status.lastSync).toLocaleString()}` : '아직 동기화한 기록이 없습니다'}</div>
      {status.state === 'error' && <div className="muted">로컬 변경은 보존됩니다. 30초 후 자동 재시도하며, 지금 동기화로 다시 시도할 수도 있습니다.</div>}
    </div>}
    {status && ['conflict', 'password-required'].includes(status.state) && <div className="card">
      <p>양쪽 데이터를 자동으로 덮어쓰지 않습니다. 사용할 버전을 선택하세요.</p>
      <Field label="원격 볼트 마스터 비밀번호" hint="다른 PC에서 처음 가져오거나 원격 볼트의 키가 다를 때 입력합니다. 비밀번호는 저장하지 않습니다.">
        <input className="input" type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>
      <div className="row">
        <button className="btn" disabled={working || dirty} onClick={() => resolve('remote')}>원격 데이터 가져오기</button>
        <button className="btn" disabled={working || dirty} onClick={() => resolve('local')}>로컬 데이터 올리기</button>
      </div>
    </div>}
  </>
}
