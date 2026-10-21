import { useEffect, useState } from 'react'
import { KeyRound } from 'lucide-react'
import { useApp } from '../state'
import { api } from '../api'
import { Modal } from './ui'
import type { LocalPublicKey } from '@shared/types'

/** 비밀번호로 접속하는 서버의 authorized_keys 에 이 PC 의 공개키를 넣는다 */
export function SshKeyDialog({ hostId }: { hostId: string }): JSX.Element {
  const host = useApp((s) => s.hosts.find((h) => h.id === hostId))
  const [keys, setKeys] = useState<LocalPublicKey[] | null>(null)
  const [sel, setSel] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const close = (): void => useApp.setState({ dialog: null })
  const st = useApp.getState

  useEffect(() => {
    api.sshKey.list().then((k) => {
      setKeys(k)
      setSel(k[0]?.path ?? null)
    }).catch((e) => {
      setKeys([])
      st().toast('error', (e as Error).message)
    })
  }, [])

  const key = keys?.find((k) => k.path === sel)
  const target = host ? `${host.username ? host.username + '@' : ''}${host.host}${host.port !== 22 ? ':' + host.port : ''}` : ''

  const install = async (): Promise<void> => {
    if (!host || !key) return
    setBusy(true)
    try {
      const r = await api.sshKey.install(host.id, key.path)
      st().toast(r === 'added' ? 'ok' : 'info', r === 'added' ? `${host.alias}에 ${key.name} 키를 등록했습니다` : `${host.alias}에 ${key.name} 키가 이미 등록돼 있어 건너뛰었습니다`)
      close()
    } catch (e) {
      st().toast('error', `키 등록 실패: ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="SSH 키 등록" icon={<KeyRound size={18} />} onClose={() => !busy && close()}
      foot={<>
        <button className="btn" disabled={busy} onClick={close}>취소</button>
        <button className="btn primary" disabled={!key || !host || busy} onClick={install}>{busy ? '등록 중...' : '등록'}</button>
      </>}>
      <div className="modal-body">
        <div className="notice">
          <div>
            선택한 공개키를 <b>{host?.alias}</b> (<span className="kbd">{target}</span>)의 <span className="kbd">~/.ssh/authorized_keys</span>에 추가합니다.
            접속할 때 저장된 비밀번호를 쓰고, 없으면 물어봅니다. 같은 키가 이미 등록돼 있으면 아무것도 바꾸지 않습니다.
          </div>
        </div>
        {keys === null && <div className="muted">~/.ssh 에서 키를 찾는 중...</div>}
        {keys && keys.length === 0 && (
          <div className="empty">
            ~/.ssh 에 공개키(.pub)가 없습니다.<br />
            터미널에서 <span className="kbd">ssh-keygen -t ed25519</span>로 키를 만든 뒤 다시 여세요.
          </div>
        )}
        {keys && keys.length > 0 && (
          <div className="import-list">
            {keys.map((k) => (
              <label key={k.path} className="key-row">
                <input type="radio" name="sshkey" checked={sel === k.path} onChange={() => setSel(k.path)} />
                <span className="key-main">
                  <span><b>{k.name}</b> <span className="muted">{k.type}{k.comment ? ` · ${k.comment}` : ''}</span></span>
                  <span className="key-fp">{k.fingerprint}</span>
                </span>
                {!k.hasPrivate && <span className="pill" title="같은 이름의 개인 키 파일이 ~/.ssh 에 없습니다">개인 키 없음</span>}
              </label>
            ))}
          </div>
        )}
        {key && !key.hasPrivate && <div className="notice warn"><div>이 PC 에는 <b>{key.name.slice(0, -4)}</b> 개인 키가 없어서, 등록해도 이 PC 에서는 이 키로 로그인할 수 없습니다.</div></div>}
      </div>
    </Modal>
  )
}
