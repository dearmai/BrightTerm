import { useEffect, useRef, useState } from 'react'
import type { GitSyncConfig, GitSyncStatus, GitSyncPreview } from '@shared/types'
import { api } from '../api'
import { useApp } from '../state'
import { Field, Toggle } from './ui'
import { GitSyncPreviewPanel } from './GitSyncPreviewPanel'

export function GitSyncSettings(): JSX.Element {
  const [status, setStatus] = useState<GitSyncStatus | null>(null)
  const [config, setConfig] = useState<GitSyncConfig>({ enabled: false, remote: '', branch: 'main' })
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<GitSyncPreview | null>(null)
  const [previewError, setPreviewError] = useState('')
  const requestVersion = useRef(0)
  const alive = useRef(true)
  const unlocked = useApp((s) => s.vault.unlocked)
  const hosts = useApp((s) => s.hosts)
  const groups = useApp((s) => s.groups)
  const snippets = useApp((s) => s.snippets)
  const creds = useApp((s) => s.creds)
  const toast = useApp.getState().toast
  useEffect(() => {
    let live = true
    api.gitSync.status().then((s) => { if (live) { setStatus(s); setConfig(s.config) } }).catch((e) => toast('error', e.message))
    alive.current = true
    const off = api.on.gitSync((s) => { setStatus(s); setPreview(null); requestVersion.current++ })
    return () => { live = false; alive.current = false; requestVersion.current++; off() }
  }, [])
  useEffect(() => {
    requestVersion.current++
    setPreview(null)
    setPassword('')
    setPreviewError('')
  }, [unlocked, hosts, groups, snippets, creds, config.remote, config.branch, config.enabled])
  useEffect(() => {
    if (status && !['conflict', 'password-required'].includes(status.state)) { setPreview(null); setPassword('') }
  }, [status?.state])
  useEffect(() => {
    if (!preview) return
    const timer = setTimeout(() => { setPreview(null); setPassword(''); setPreviewError('미리보기가 만료되었습니다. 다시 비교하세요.') }, Math.max(0, preview.expiresAt - Date.now()))
    return () => clearTimeout(timer)
  }, [preview])
  const working = busy || status?.state === 'syncing'
  const dirty = !!status && (config.remote !== status.config.remote || config.branch !== status.config.branch || config.enabled !== status.config.enabled)
  const run = async (fn: () => Promise<GitSyncStatus>): Promise<void> => {
    setBusy(true)
    try { setStatus(await fn()) } catch (e) { toast('error', (e as Error).message) }
    finally { setBusy(false) }
  }
  const resolve = async (choice: 'local' | 'remote'): Promise<void> => {
    if (!preview) return
    const token = preview.token
    const ok = await useApp.getState().confirm({ title: choice === 'remote' ? '원격 데이터 가져오기' : '로컬 데이터 올리기',
      message: choice === 'remote' ? '현재 연결 목록과 볼트를 원격 내용으로 바꿀까요? 교체 전 로컬 데이터는 자동 백업됩니다.' : '현재 연결 목록과 볼트를 원격 저장소의 새 버전으로 올릴까요? 기존 원격 버전은 Git 기록에 남습니다.',
      danger: true, okText: choice === 'remote' ? '가져오기' : '올리기' })
    if (!ok) return
    const supplied = password
    setPassword('')
    await run(() => api.gitSync.resolve(choice, choice === 'remote' ? supplied || undefined : undefined, token))
    setPreview(null)
  }
  const compare = async (): Promise<void> => {
    const version = ++requestVersion.current
    setBusy(true)
    setPreview(null)
    setPreviewError('')
    try {
      const result = await api.gitSync.preview(password || undefined)
      if (!alive.current || version !== requestVersion.current) return
      if (result.state === 'ready') setPreview(result.preview)
      else { setPreviewError(result.message); setPassword('') }
    } catch (e) {
      if (alive.current && version === requestVersion.current) setPreviewError((e as Error).message)
    } finally { if (alive.current) setBusy(false) }
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
      <p>먼저 차이를 확인한 뒤 사용할 버전을 선택하세요. 미리보기만으로 데이터가 바뀌지 않습니다.</p>
      <Field label="원격 볼트 마스터 비밀번호" hint="키가 다른 경우에만 필요합니다. 이 설정 화면에서만 잠시 사용하며 저장하지 않습니다. 잠그거나 화면을 닫으면 입력을 지웁니다.">
        <input className="input" aria-label="원격 볼트 마스터 비밀번호" disabled={working || !unlocked} type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>
      <div className="row"><button className="btn primary" disabled={working || dirty || !unlocked} onClick={compare}>{busy ? '처리 중…' : preview ? '차이 다시 확인' : '차이 미리보기'}</button>
        {!unlocked && <span className="muted">로컬 볼트를 먼저 잠금 해제하세요.</span>}</div>
      {previewError && <div className="err" role="alert">{previewError}</div>}
      {preview && <GitSyncPreviewPanel key={preview.token} preview={preview} />}
      <div className="row">
        <button className="btn" disabled={working || dirty || !preview?.remoteExists || !unlocked} onClick={() => resolve('remote')}>원격 데이터 가져오기</button>
        <button className="btn" disabled={working || dirty || !preview || !unlocked} onClick={() => resolve('local')}>로컬 데이터 올리기</button>
      </div>
    </div>}
  </>
}
