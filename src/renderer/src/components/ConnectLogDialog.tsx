import { useEffect, useRef, useState } from 'react'
import { Copy } from 'lucide-react'
import { useApp } from '../state'
import { api } from '../api'
import { Modal } from './ui'

/** 탭 메뉴 → 접속 상세 로그. 열어 둔 동안 재접속·끊김도 이어서 보이도록 1초마다 다시 읽는다 */
export function ConnectLogDialog({ sessionId }: { sessionId: string }): JSX.Element {
  const title = useApp((s) => s.sessions[sessionId]?.title)
  const [text, setText] = useState('')
  const box = useRef<HTMLPreElement>(null)
  const close = (): void => useApp.setState({ dialog: null })

  useEffect(() => {
    let alive = true
    const read = (): void => { api.session.connectLog(sessionId).then((t) => { if (alive) setText(t) }, () => {}) }
    read()
    const timer = setInterval(read, 1000)
    return () => { alive = false; clearInterval(timer) }
  }, [sessionId])

  // 맨 아래를 보고 있을 때만 따라간다 — 위로 올려 읽는 중이면 그대로
  const atBottom = useRef(true)
  useEffect(() => {
    const el = box.current
    if (el && atBottom.current) el.scrollTop = el.scrollHeight
  }, [text])

  const copy = (): void => {
    navigator.clipboard.writeText(text)
    useApp.getState().toast('ok', '접속 로그를 복사했습니다')
  }

  return (
    <Modal title={`접속 상세 로그 · ${title ?? ''}`} onClose={close} size="lg"
      foot={<>
        <span className="left muted" style={{ fontSize: 12 }}>이 PC 메모리에만 있고 탭을 닫으면 사라집니다. 비밀번호·키는 기록하지 않지만 주소·계정 이름이 들어 있으니 공유할 때 확인하세요.</span>
        <button className="btn" disabled={!text} onClick={copy}><Copy size={14} />복사</button>
        <button className="btn primary" onClick={close}>닫기</button>
      </>}>
      <div className="modal-body">
        <pre ref={box} className="connect-log" onScroll={(e) => { const el = e.currentTarget; atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24 }}>{text || '기록이 없습니다'}</pre>
      </div>
    </Modal>
  )
}
