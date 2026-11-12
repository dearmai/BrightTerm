// 내장 원격 데스크톱 화면 — IronRDP(WASM) 웹 컴포넌트. 메인 프로세스의 RDCleanPath 프록시(ws://127.0.0.1)로 붙는다.
// 별도 창(rdp.html)과 메인 창의 탭이 같이 쓴다.
import { useEffect, useRef, useState } from 'react'
import { ClipboardCheck, ClipboardX, Keyboard, LogOut, Maximize, Minimize, Plug, RefreshCw, KeyRound, SlidersHorizontal } from 'lucide-react'
import '@devolutions/iron-remote-desktop'
import type { UserInteraction } from '@devolutions/iron-remote-desktop'
import { Backend, displayControl, init } from '@devolutions/iron-remote-desktop-rdp'
import type { RdpExperience } from '@shared/types'
import { RdpSettingsPanel, type RdpViewOptions } from './RdpSettings'
import './rdp.css'

interface Info {
  title: string
  hostId: string
  wsUrl: string
  token: string
  destination: string
  username: string
  domain: string
  password: string
  clipboard: boolean
  resolution: string
  color?: string
  route: string
  security?: string
  theme: 'dark' | 'light'
  options: RdpViewOptions
  depthFallback?: number
}

/** IronRDP ScreenScale */
const SCALE = { fit: 1, full: 2, real: 3 } as const

/** 접속할 때 쓴 값 — 화질·소리·클립보드 채널은 다시 연결해야 바뀐다 */
interface Applied { colorDepth: number; audio: string; experience: RdpExperience; clipboard: boolean }

type Phase =
  | { kind: 'loading' }
  | { kind: 'login'; error?: string }
  | { kind: 'connecting' }
  | { kind: 'connected' }
  | { kind: 'ended'; message: string; error?: boolean }

export type RdpViewState = 'connecting' | 'connected' | 'closed'

let wasmReady: Promise<void> | null = null
const ensureWasm = (): Promise<void> => (wasmReady ??= init(localStorage.getItem('bt.rdpLog') ?? 'WARN'))

/** IronError(WASM) → 사용자 문구. kind: 1 잘못된 비밀번호, 2 로그온 실패, 3 접근 거부, 4 프록시, 5 프록시 연결, 6 협상 */
function describe(e: unknown): { message: string; auth: boolean } {
  const err = e as { kind?: () => number; backtrace?: () => string; rdcleanpathDetails?: () => { tlsAlertCode?: number; wsaErrorCode?: number } | undefined; message?: string }
  const kind = typeof err?.kind === 'function' ? err.kind() : -1
  const detail = typeof err?.backtrace === 'function' ? err.backtrace() : err?.message ?? String(e)
  const short = detail.split('\n')[0]
  switch (kind) {
    case 1: return { message: '비밀번호가 틀렸습니다.', auth: true }
    case 2: return { message: '로그온에 실패했습니다 — 사용자 이름·도메인·비밀번호를 확인하세요.', auth: true }
    case 3: return { message: '접근이 거부되었습니다 — 이 계정이 원격 데스크톱 사용자 그룹에 있는지 확인하세요.', auth: true }
    case 4: {
      const d = typeof err.rdcleanpathDetails === 'function' ? err.rdcleanpathDetails() : undefined
      if (d?.tlsAlertCode === 42) return { message: '서버 인증서가 처음 확인한 것과 다릅니다. 창을 닫고 다시 연결해 인증서를 확인하세요.', auth: false }
      if (d?.wsaErrorCode) return { message: `서버에 연결하지 못했습니다 (WSA ${d.wsaErrorCode}).`, auth: false }
      return { message: `연결 중계 오류: ${short}`, auth: false }
    }
    case 5: return { message: `앱 내부 중계에 연결하지 못했습니다: ${short}`, auth: false }
    case 6: return { message: `RDP 협상 실패: ${short}`, auth: false }
    default: return { message: short || '알 수 없는 오류', auth: /credssp|logon|password|auth/i.test(short) }
  }
}

function sizeOf(resolution: string, el: HTMLElement): { width: number; height: number } {
  const m = /^(\d+)x(\d+)$/.exec(resolution)
  return m ? { width: +m[1], height: +m[2] } : evenSize(el)
}

function evenSize(el: HTMLElement): { width: number; height: number } {
  const r = el.getBoundingClientRect()
  const w = Math.max(640, Math.min(8192, Math.floor(r.width / 2) * 2))
  const h = Math.max(400, Math.min(8192, Math.floor(r.height / 2) * 2))
  return { width: w, height: h }
}

export interface RdpViewProps {
  token: string
  /** window: 별도 창(rdp.html) / tab: 메인 창의 탭 */
  mode: 'window' | 'tab'
  /** 탭이 보이는 중인지 — 보이게 되면 원격 화면에 포커스 */
  active?: boolean
  onState?: (s: RdpViewState) => void
  /** 탭 닫기 — 없으면 창을 닫는다 */
  onClose?: () => void
}

export function RdpView({ token, mode, active = true, onState, onClose }: RdpViewProps): JSX.Element {
  const call = <T,>(ch: string, ...a: unknown[]): Promise<T> => window.bt.call<T>(ch, token, ...a)
  const tab = mode === 'tab'
  const close = (): void => { if (onClose) onClose(); else void call('rdp:close') }
  const [info, setInfo] = useState<Info | null>(null)
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' })
  const [user, setUser] = useState('')
  const [domain, setDomain] = useState('')
  const [password, setPassword] = useState('')
  const [save, setSave] = useState(true)
  const [warn, setWarn] = useState('')
  const [full, setFull] = useState(false)
  const [barHot, setBarHot] = useState(false)
  const [confirmClose, setConfirmClose] = useState(false)
  const [panel, setPanel] = useState(false)
  /** 중계의 진행 단계 — 어디서 멈췄는지 보인다 */
  const [steps, setSteps] = useState<string[]>([])
  const stepsRef = useRef<string[]>([])
  stepsRef.current = steps
  /** 15비트 접속이 로그온 정보까지 못 가고 멈췄는지 — 그러면 16비트로 한 번 다시 연결한다 */
  const fellBack = useRef(false)
  /** 다시 연결해도 남길 안내 — connect() 가 경고를 지우므로 */
  const notice = useRef('')
  const stuckAt15 = (): boolean => {
    const at = stepsRef.current.findIndex((m) => m.includes('색 깊이 15비트'))
    return at >= 0 && !stepsRef.current.slice(at).some((m) => m.startsWith('로그온 정보'))
  }
  const [slow, setSlow] = useState(false)
  const [applied, setApplied] = useState<Applied | null>(null)
  const opts = useRef<RdpViewOptions | null>(null)
  opts.current = info?.options ?? null
  const host = useRef<HTMLDivElement>(null)
  const ui = useRef<UserInteraction | null>(null)
  const attempt = useRef(0)

  useEffect(() => {
    call<Info>('rdp:info').then((i) => {
      if (!tab) {
        document.documentElement.dataset.theme = i.theme
        document.title = `${i.title} — 원격 데스크톱`
      }
      setInfo(i)
      setUser(i.domain ? `${i.domain}\\${i.username}` : i.username)
      if (i.password && i.username) void connect(i, i.username, i.domain, i.password, false)
      else setPhase({ kind: 'login' })
    }, (e) => setPhase({ kind: 'ended', message: (e as Error).message, error: true }))
    const off = tab ? () => {} : window.bt.on('rdp:confirmClose', () => setConfirmClose(true))
    const offLog = window.bt.on('rdp:log', ((t: string, m: string) => { if (t === token) setSteps((x) => [...x.slice(-7), m]) }) as never)
    return () => {
      off()
      offLog()
      // 탭을 닫으면 연결도 끝낸다
      attempt.current++
      try { ui.current?.shutdown() } catch { /* */ }
    }
  }, [])

  const fallback16 = async (): Promise<void> => {
    if (fellBack.current) return
    fellBack.current = true
    attempt.current++
    try { ui.current?.shutdown() } catch { /* */ }
    try { await call('rdp:depthFallback') } catch { /* */ }
    notice.current = '15비트 접속이 멈춰 16비트로 다시 연결했습니다. 앱을 켜 둔 동안 이 서버는 16비트로 접속합니다(저장한 설정은 15비트 그대로).'
    void reconnect()
  }

  // 15비트는 일부 Windows 가 화면 협상에서 멈춘다 — 10초 안에 로그온 정보까지 못 가면 16비트로
  useEffect(() => {
    if (phase.kind !== 'connecting' || fellBack.current || !stuckAt15()) return
    const t = setTimeout(() => { if (stuckAt15()) void fallback16() }, 10000)
    return () => clearTimeout(t)
  }, [phase.kind, steps])

  // 오래 걸리면 어디서 멈췄는지와 확인할 것을 보인다
  useEffect(() => {
    if (phase.kind !== 'connecting') { setSlow(false); return }
    const t = setTimeout(() => setSlow(true), 20000)
    return () => clearTimeout(t)
  }, [phase.kind])

  useEffect(() => {
    onState?.(phase.kind === 'connected' ? 'connected' : phase.kind === 'connecting' || phase.kind === 'loading' ? 'connecting' : 'closed')
  }, [phase.kind])

  // 원격 화면에 포커스가 있는 동안 키를 모두 원격으로 — 앱 메뉴 단축키를 끄고(⌘Q·⌘W·⌘H…), macOS 시스템 단축키(⌘Space 등)를 먼저 잡는다
  const [capture, setCapture] = useState(false)
  useEffect(() => {
    if (phase.kind !== 'connected') return
    const isMac = navigator.platform.startsWith('Mac')
    const remote = (): boolean => document.activeElement?.tagName === 'IRON-REMOTE-DESKTOP'
    let cap = false
    const update = (): void => {
      const on = remote() && document.hasFocus()
      if (on === cap) return
      cap = on
      setCapture(on)
      call('rdp:captureKeys', on).catch(() => {})
    }
    const later = (): void => { setTimeout(update, 0) }
    const send = (type: 'keydown' | 'keyup', code: string, key: string, mods: KeyboardEventInit): void => {
      window.dispatchEvent(new KeyboardEvent(type, { code, key, bubbles: true, ...mods }))
    }
    // macOS 는 ⌘ 를 누른 동안 다른 키의 keyup 을 보내지 않는다 — 원격에서 키가 눌린 채 남지 않게 바로 뗀다
    const MODS = new Set(['MetaLeft', 'MetaRight', 'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'CapsLock'])
    const kd = (e: KeyboardEvent): void => {
      if (!isMac || !e.isTrusted || !e.metaKey || MODS.has(e.code) || !remote()) return
      const { code, key, shiftKey, ctrlKey, altKey } = e
      setTimeout(() => send('keyup', code, key, { metaKey: true, shiftKey, ctrlKey, altKey }), 0)
    }
    // 전역 단축키로 잡은 조합 — 수정 키는 이미 원격에 눌려 있으니 Space 만 보낸다
    const offHot = window.bt.on('rdp:hotkey', ((t: string, combo: string) => {
      if (t !== token || !remote()) return
      const mods = { metaKey: combo.includes('Command'), ctrlKey: combo.includes('Control'), altKey: combo.includes('Alt') }
      send('keydown', 'Space', ' ', mods)
      send('keyup', 'Space', ' ', mods)
    }) as never)
    document.addEventListener('focusin', later)
    document.addEventListener('focusout', later)
    window.addEventListener('focus', later)
    window.addEventListener('blur', later)
    window.addEventListener('keydown', kd)
    update()
    return () => {
      document.removeEventListener('focusin', later)
      document.removeEventListener('focusout', later)
      window.removeEventListener('focus', later)
      window.removeEventListener('blur', later)
      window.removeEventListener('keydown', kd)
      offHot()
      if (cap) call('rdp:captureKeys', false).catch(() => {})
      setCapture(false)
    }
  }, [phase.kind])

  // 탭으로 돌아오면 원격 화면이 키보드를 받게
  useEffect(() => {
    if (!active || phase.kind !== 'connected') return
    const id = requestAnimationFrame(() => (host.current?.querySelector('iron-remote-desktop') as HTMLElement | null)?.focus())
    return () => cancelAnimationFrame(id)
  }, [active, phase.kind])

  // 창 크기에 맞춤: 창 크기를 바꾸면 원격 화면 크기도 바꾼다(Display Control)
  useEffect(() => {
    if (!info || info.options.resolution !== 'window' || phase.kind !== 'connected' || !host.current) return
    let t: number | undefined
    const ro = new ResizeObserver(() => {
      clearTimeout(t)
      t = window.setTimeout(() => {
        if (!host.current || !ui.current) return
        // 숨은 탭·접힌 화면은 크기가 0 — 원격 화면을 줄이지 않는다
        if (host.current.getBoundingClientRect().width < 100) return
        const s = evenSize(host.current)
        ui.current.resize(s.width, s.height, opts.current?.dpi ?? 100)
      }, 500)
    })
    ro.observe(host.current)
    return () => { ro.disconnect(); clearTimeout(t) }
  }, [info?.options.resolution, phase.kind])

  /** 시도마다 웹 컴포넌트를 새로 만든다 — 끝난 세션의 상태가 남지 않게 */
  const mount = (i: Info): Promise<UserInteraction> => new Promise((resolve) => {
    const box = host.current!
    box.replaceChildren()
    const el = document.createElement('iron-remote-desktop') as HTMLElement & { module?: unknown }
    el.setAttribute('scale', i.options.scale)
    el.setAttribute('flexcenter', 'true')
    el.setAttribute('verbose', 'false')
    el.module = Backend
    el.addEventListener('ready', (ev) => {
      const u = (ev as CustomEvent<{ irgUserInteraction: UserInteraction }>).detail.irgUserInteraction
      // 클립보드는 연결 전에 정해야 한다 — 이 이벤트 바로 뒤에 컴포넌트가 클립보드를 준비한다
      u.setEnableClipboard(i.options.clipboard)
      u.setEnableAutoClipboard(i.options.clipboard)
      u.setKeyboardUnicodeMode(i.options.unicodeKeyboard)
      u.onWarningCallback((w: string) => setWarn(w))
      // 컴포넌트는 ready 바로 뒤에 클립보드 권한을 비동기로 확인하고 나서야 클립보드 콜백을 단다.
      // 그 전에 연결하면 cliprdr 채널 없이 붙는다 — 같은 확인을 뒤에 줄 세워 끝날 때까지 기다린다
      const settle = (): void => { setTimeout(() => resolve(u), 0) }
      if (i.options.clipboard) navigator.permissions.query({ name: 'clipboard-read' as PermissionName }).then(settle, settle)
      else settle()
    }, { once: true })
    box.appendChild(el)
  })

  const connect = async (i: Info, username: string, dom: string, pw: string, remember: boolean): Promise<void> => {
    const my = ++attempt.current
    setSteps([])
    setPhase({ kind: 'connecting' })
    setWarn(notice.current)
    notice.current = ''
    try {
      await ensureWasm()
      const u = await mount(i)
      ui.current = u
      const size = sizeOf(i.options.resolution, host.current!)
      const config = u.configBuilder()
        .withUsername(username)
        .withPassword(pw)
        .withServerDomain(dom)
        .withDestination(i.destination)
        .withProxyAddress(i.wsUrl)
        .withAuthToken(i.token)
        .withDesktopSize(size)
        .withExtension(displayControl(true))
        .build()
      const session = await u.connect(config)
      if (my !== attempt.current) return
      u.setVisibility(true)
      u.setScale(SCALE[i.options.scale] as never)
      // 배율은 연결 뒤 Display Control 로 — 접속 요청에는 배율을 넣을 자리가 없다
      if (i.options.dpi !== 100) setTimeout(() => { if (my === attempt.current) { const sz = sizeOf(i.options.resolution, host.current!); u.resize(sz.width, sz.height, i.options.dpi) } }, 1500)
      setApplied({ colorDepth: i.options.colorDepth, audio: i.options.audio, experience: i.options.experience, clipboard: i.options.clipboard })
      setPhase({ kind: 'connected' })
      void call('rdp:state', true)
      if (remember) call('rdp:savePassword', username, dom, pw).catch((e) => setWarn(`비밀번호를 저장하지 못했습니다: ${(e as Error).message}`))
      ;(host.current?.querySelector('iron-remote-desktop') as HTMLElement | null)?.focus()
      const end = await session.run()
      if (my !== attempt.current) return
      void call('rdp:state', false)
      setPhase({ kind: 'ended', message: `연결이 끝났습니다${end?.reason?.() ? ` — ${end.reason()}` : ''}` })
    } catch (e) {
      if (my !== attempt.current) return
      // 15비트로 시작해 끊긴 경우도 16비트로 한 번 더
      if (!fellBack.current && stuckAt15()) { void fallback16(); return }
      void call('rdp:state', false)
      const d = describe(e)
      console.warn('[rdp]', e)
      if (d.auth) setPhase({ kind: 'login', error: d.message })
      else setPhase({ kind: 'ended', message: d.message, error: true })
    }
  }

  const submit = (e: React.FormEvent): void => {
    e.preventDefault()
    if (!info) return
    const m = /^([^\\]+)\\(.+)$/.exec(user.trim())
    const u = m ? m[2] : user.trim()
    const d = m ? m[1] : domain.trim()
    void connect(info, u, d, password, save)
  }

  const disconnect = (): void => {
    attempt.current++
    try { ui.current?.shutdown() } catch { /* */ }
    void call('rdp:state', false)
    setPhase({ kind: 'ended', message: '연결을 끊었습니다' })
  }

  const reconnect = async (): Promise<void> => {
    const i = await call<Info>('rdp:info')
    setInfo(i)
    if (i.password && i.username) void connect(i, i.username, i.domain, i.password, false)
    else setPhase({ kind: 'login' })
  }

  /** 막대의 설정 — 서버 설정에 저장하고, 접속 중이면 바로 적용할 수 있는 것은 바로 */
  const change = async (p: Partial<RdpViewOptions>): Promise<void> => {
    if (!info) return
    const prev = info.options
    setInfo({ ...info, options: { ...prev, ...p } })
    let next: RdpViewOptions
    try {
      next = await call<RdpViewOptions>('rdp:setOptions', p)
    } catch (e) {
      setWarn(`설정을 저장하지 못했습니다: ${(e as Error).message}`)
      setInfo({ ...info, options: prev })
      return
    }
    setInfo((x) => (x ? { ...x, options: next } : x))
    const u = ui.current
    if (!u || phase.kind !== 'connected') return
    if (p.scale) u.setScale(SCALE[next.scale] as never)
    if (p.unicodeKeyboard !== undefined) u.setKeyboardUnicodeMode(next.unicodeKeyboard)
    if (p.clipboard !== undefined && applied?.clipboard) u.setEnableAutoClipboard(next.clipboard)
    if (p.resolution !== undefined || p.dpi !== undefined) {
      const sz = sizeOf(next.resolution, host.current!)
      u.resize(sz.width, sz.height, next.dpi)
    }
  }

  const toggleFull = async (): Promise<void> => setFull(await call<boolean>('rdp:fullscreen'))
  const closeLabel = tab ? '탭 닫기' : '창 닫기'
  const connected = phase.kind === 'connected'

  return (
    <div className={`rdp-app ${tab ? 'in-tab' : ''} ${full ? 'full' : ''}`} onMouseMove={(e) => full && setBarHot(e.clientY < 8 || (barHot && e.clientY < 48))}>
      <div className={`rdp-bar ${full && !barHot ? 'hidden' : ''}`} onMouseDown={() => { if (document.activeElement?.tagName === 'IRON-REMOTE-DESKTOP') (document.activeElement as HTMLElement).blur() }} style={info?.color ? { borderTop: `2px solid ${info.color}` } : undefined}>
        <span className={`dot ${connected ? 'connected' : phase.kind === 'connecting' ? 'connecting' : 'closed'}`} />
        <b className="rdp-title">{info?.title ?? '원격 데스크톱'}</b>
        <span className="muted rdp-sub" title={info?.route}>{info?.route}{info?.security ? ` · ${info.security}` : ''}</span>
        <span className="grow" />
        {info && (
          <button className={`ibtn rdp-clip ${info.options.clipboard ? 'on' : ''}`} title={info.options.clipboard ? '클립보드 동기화 켜짐 — 누르면 끕니다' : '클립보드 동기화 꺼짐 — 누르면 켭니다'} onClick={() => void change({ clipboard: !info.options.clipboard })}>
            {info.options.clipboard ? <ClipboardCheck size={14} /> : <ClipboardX size={14} />}
          </button>
        )}
        <button className="btn sm" disabled={!connected} onClick={() => ui.current?.ctrlAltDel()} title="Ctrl+Alt+Del 보내기"><Keyboard size={13} />Ctrl+Alt+Del</button>
        <button className="btn sm" disabled={!connected} onClick={() => ui.current?.metaKey()} title="Windows 키 보내기">⊞ Win</button>
        {capture && <span className="rdp-capture" title="원격 화면에 포커스가 있어 모든 키를 원격으로 보냅니다 — ⌘ 는 Windows 키, 앱 단축키는 꺼집니다. 이 막대를 누르면 앱 단축키가 돌아옵니다.">⌘ → ⊞ 원격 입력 중</span>}
        {info && <button className={`ibtn rdp-settings-btn ${panel ? 'on' : ''}`} onClick={() => setPanel((v) => !v)} title="화면·화질·소리 설정"><SlidersHorizontal size={15} /></button>}
        <button className="ibtn" onClick={() => void toggleFull()} title={full ? '전체 화면 끝내기' : '전체 화면'}>{full ? <Minimize size={15} /> : <Maximize size={15} />}</button>
        {connected
          ? <button className="btn sm" onClick={disconnect}><LogOut size={13} />연결 끊기</button>
          : phase.kind === 'ended' && <button className="btn sm primary" onClick={() => void reconnect()}><RefreshCw size={13} />다시 연결</button>}
      </div>
      {warn && <div className="rdp-warn" onClick={() => setWarn('')}>{warn}</div>}
      {panel && info && (
        <RdpSettingsPanel
          options={info.options}
          applied={phase.kind === 'connected' ? applied : null}
          fallbackDepth={info.depthFallback}
          onChange={(p) => void change(p)}
          onReconnect={() => { setPanel(false); disconnect(); void reconnect() }}
          onClose={() => setPanel(false)}
        />
      )}
      <div className="rdp-screen" ref={host} />
      {phase.kind !== 'connected' && (
        <div className="rdp-overlay">
          {phase.kind === 'loading' && <div className="muted">준비 중…</div>}
          {phase.kind === 'connecting' && (
            <div className="rdp-card">
              <Plug size={18} /> {info?.title} 에 연결 중…
              <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>{info?.route}</div>
              {steps.length > 0 && <div className="rdp-steps">{steps.map((m, k) => <div key={k} className={k === steps.length - 1 ? 'now' : ''}>{m}</div>)}</div>}
              {slow && (
                <div className="rdp-slow">
                  {steps.at(-1)?.startsWith('인증') || steps.at(-1)?.startsWith('서버 응답')
                    ? 'NLA 로그인 단계에서 멈췄습니다. 사용자 이름(Microsoft 계정이면 전자 메일, 도메인 계정이면 도메인\\사용자)과 비밀번호를 확인하세요.'
                    : steps.at(-1)?.startsWith('서버에 연결 중') ? '서버까지 가는 길에서 멈췄습니다 — 경로(점프 호스트)와 방화벽을 확인하세요.' : '응답을 기다리고 있습니다.'}
                  <div className="row" style={{ marginTop: 8, justifyContent: 'center' }}>
                    <button className="btn sm" onClick={disconnect}>취소</button>
                  </div>
                </div>
              )}
            </div>
          )}
          {phase.kind === 'ended' && (
            <div className={`rdp-card ${phase.error ? 'error' : ''}`}>
              <div>{phase.message}</div>
              {phase.error && steps.length > 0 && <div className="rdp-steps">{steps.slice(-4).map((m, k) => <div key={k}>{m}</div>)}</div>}
              <div className="row" style={{ marginTop: 12, justifyContent: 'center' }}>
                <button className="btn primary" onClick={() => void reconnect()}><RefreshCw size={13} />다시 연결</button>
                <button className="btn" onClick={close}>{closeLabel}</button>
              </div>
            </div>
          )}
          {phase.kind === 'login' && (
            <form className="rdp-card login" onSubmit={submit}>
              <div className="row" style={{ gap: 8, marginBottom: 4 }}><KeyRound size={18} /><b>{info?.title} 로그인</b></div>
              {phase.error && <div className="err">{phase.error}</div>}
              <div className="field"><label>사용자 이름 (도메인\사용자 가능)</label><input className="input mono" value={user} onChange={(e) => setUser(e.target.value)} autoFocus={!user} placeholder="Administrator" /></div>
              {!/\\/.test(user) && <div className="field"><label>도메인 (선택)</label><input className="input mono" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="비워 두면 로컬 계정" /></div>}
              <div className="field"><label>비밀번호</label><input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus={!!user} autoComplete="off" /></div>
              <label className="row" style={{ fontSize: 12.5 }}><input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} />연결되면 볼트에 저장 (이 서버의 RDP 전용 비밀번호)</label>
              <div className="row" style={{ marginTop: 10, justifyContent: 'flex-end' }}>
                <button type="button" className="btn" onClick={close}>취소</button>
                <button type="submit" className="btn primary" disabled={!user.trim()}>연결</button>
              </div>
            </form>
          )}
        </div>
      )}
      {confirmClose && (
        <div className="rdp-overlay">
          <div className="rdp-card">
            <div>원격 데스크톱 연결을 끊고 창을 닫을까요?</div>
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>원격 세션은 서버에 남아 있어 다시 연결하면 이어집니다(로그오프하지 않음).</div>
            <div className="row" style={{ marginTop: 12, justifyContent: 'center' }}>
              <button className="btn" onClick={() => setConfirmClose(false)}>취소</button>
              <button className="btn primary" autoFocus onClick={() => { disconnect(); close() }}>닫기</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
