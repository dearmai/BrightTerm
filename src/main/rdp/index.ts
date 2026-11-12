// 원격 데스크톱(RDP) — 허용 상태 확인, 내장 창(IronRDP) 또는 OS 의 원격 데스크톱 앱(.rdp 파일)으로 연결.
import { app, BrowserWindow, globalShortcut, ipcMain, shell, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { createServer, type Server, type Socket } from 'net'
import { spawn } from 'child_process'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomBytes, randomUUID } from 'crypto'
import type { Host, RdpCheck, RdpColorDepth, RdpExperience, RdpOptions } from '@shared/types'
import { buildRdpFile, builtinAudio, clientPatchOf, rdpExperience, rdpOptions } from '@shared/rdp'
import { store } from '../store'
import { vault } from '../vault'
import { ask } from '../ui'
import { checkRdp, openRdpRoute, type RdpRoute } from './route'
import { setSystemHotkeysDisabled, systemHotkeysDisabled } from './macKeys'
import { gatewayPort, registerTarget, unregisterTarget, closeGateway } from './gateway'

/** 창에 넘기는 접속 정보 — 비밀번호는 창이 IronRDP(CredSSP) 에 넣어야 해서 같이 간다 */
export interface RdpWindowInfo {
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
  /** 화면 위 막대의 설정 — 서버 설정(RdpOptions)에서 그대로 */
  options: RdpViewOptions
  /** 15비트로 멈춰 대신 쓰는 색 깊이 */
  depthFallback?: RdpColorDepth
}

/** 막대에서 보이고 바꾸는 값 — 화면·입력은 바로, 화질·소리는 다시 연결할 때 적용 */
export type RdpViewOptions = Required<Pick<RdpOptions, 'scale' | 'dpi' | 'unicodeKeyboard' | 'clipboard' | 'resolution' | 'colorDepth' | 'audio'>> & { experience: RdpExperience }

const VIEW_KEYS = ['scale', 'dpi', 'unicodeKeyboard', 'clipboard', 'resolution', 'colorDepth', 'audio', 'experience'] as const

function viewOptions(o: RdpOptions): RdpViewOptions {
  return {
    scale: o.scale ?? 'fit',
    dpi: o.dpi ?? 100,
    unicodeKeyboard: !!o.unicodeKeyboard,
    clipboard: o.clipboard,
    resolution: o.resolution,
    colorDepth: o.colorDepth ?? 32,
    audio: builtinAudio(o),
    experience: rdpExperience(o)
  }
}

/** 막대에서 바꾼 값을 서버 설정에 저장한다 — 받은 키만, 값 검사 후 */
function saveViewOptions(hostId: string, p: Partial<RdpViewOptions>): RdpViewOptions {
  const data = store.get()
  const host = data.hosts.find((h) => h.id === hostId)
  if (!host) throw new Error('서버를 찾을 수 없습니다')
  const o = rdpOptions(host)
  const next: RdpOptions = { ...o }
  for (const k of VIEW_KEYS) {
    if (!(k in p)) continue
    const v = p[k] as unknown
    if (k === 'scale' && (v === 'fit' || v === 'full' || v === 'real')) next.scale = v
    else if (k === 'dpi' && typeof v === 'number' && v >= 100 && v <= 300) next.dpi = Math.round(v)
    else if ((k === 'unicodeKeyboard' || k === 'clipboard') && typeof v === 'boolean') next[k] = v
    else if (k === 'resolution' && typeof v === 'string' && (v === 'window' || /^\d{3,5}x\d{3,5}$/.test(v))) next.resolution = v
    else if (k === 'colorDepth' && (v === 32 || v === 24 || v === 16 || v === 15)) next.colorDepth = v
    else if (k === 'audio' && (v === 'remote' || v === 'off')) next.audio = v
    else if (k === 'experience' && v && typeof v === 'object') {
      const e = rdpExperience(o)
      for (const key of Object.keys(e) as (keyof RdpExperience)[]) if (typeof (v as RdpExperience)[key] === 'boolean') e[key] = (v as RdpExperience)[key]
      next.experience = e
    }
  }
  store.patch({ hosts: data.hosts.map((h) => (h.id === hostId ? { ...h, rdp: next } : h)) })
  return viewOptions(next)
}

interface RdpSession {
  token: string
  hostId: string
  win: BrowserWindow
  route: RdpRoute
  info: RdpWindowInfo
  connected: boolean
  /** 메인 창의 탭에 열린 연결 — win 은 메인 창 */
  inTab: boolean
}

/** 탭으로 열었을 때 렌더러가 탭을 만드는 데 쓰는 값 */
export interface RdpTabInfo { token: string; hostId: string; title: string; color?: string }

const sessions = new Map<string, RdpSession>()
/** 15비트로 멈춘 서버 — 앱을 켜 둔 동안 16비트로 접속한다(저장한 설정은 그대로) */
const depthFallback = new Map<string, RdpColorDepth>()

/**
 * macOS 시스템 단축키(⌘Tab 앱 전환, ⌘Space Spotlight, ⌃Space 입력 소스 …)는 앱보다 먼저 처리된다.
 * 원격 화면에 포커스가 있고 그 창이 앞에 있을 때만 시스템 단축키를 끈다(macKeys). 끌 수 없으면 아래 조합만 전역 단축키로 잡는다
 */
const MAC_HOTKEYS = ['Command+Space', 'Control+Space', 'Command+Alt+Space', 'Control+Alt+Space']
let hot: { wc: WebContents; token: string } | null = null

function setHot(target: { wc: WebContents; token: string } | null): void {
  if (process.platform !== 'darwin') return
  if (hot && target && hot.wc === target.wc && hot.token === target.token) return
  if (hot && !systemHotkeysDisabled()) for (const k of MAC_HOTKEYS) globalShortcut.unregister(k)
  hot = target
  if (!hot) { setSystemHotkeysDisabled(false); return }
  // 시스템 단축키를 통째로 끄면 ⌘Tab·⌘Space 도 평범한 키로 들어와 IronRDP 가 그대로 보낸다
  if (setSystemHotkeysDisabled(true)) return
  // 끌 수 없으면(koffi 없음) 전역 단축키로 몇 가지만 잡는다
  const t = hot
  for (const k of MAC_HOTKEYS) {
    try { globalShortcut.register(k, () => { if (!t.wc.isDestroyed()) t.wc.send('rdp:hotkey', t.token, k) }) } catch { /* 다른 앱이 쓰는 조합 */ }
  }
}
let mainWin: BrowserWindow | null = null

const trustKey = (host: Host, o: RdpOptions): string => `rdp://${host.host}:${o.port || 3389}`

function credentials(host: Host, o: RdpOptions): { username: string; password: string; domain: string } {
  const read = (id?: string | null): { username?: string; password?: string } => {
    if (!id) return {}
    try { return vault.get(id) ?? {} } catch { return {} }
  }
  const sec = o.auth === 'own' ? read(o.credentialId) : o.auth === 'host' ? read(host.credentialId) : {}
  let username = o.username?.trim() || host.username || sec.username || ''
  let domain = o.domain?.trim() || ''
  // DOMAIN\user, user@domain 은 나눠 넣는다 (CredSSP 는 도메인을 따로 받는다)
  const m = /^([^\\]+)\\(.+)$/.exec(username)
  if (m) { domain ||= m[1]; username = m[2] }
  return { username, password: sec.password ?? '', domain }
}

/** 서버 인증서 — 처음 보거나 바뀌었으면 SSH 호스트 키처럼 묻는다 */
async function trustCertificate(host: Host, o: RdpOptions, fp: string): Promise<boolean> {
  const key = trustKey(host, o)
  const known = store.findKnownHost(key)
  if (known?.fingerprint === fp) return true
  const ok = await ask<boolean>({ kind: 'hostkey', sessionTitle: host.alias || host.host, hostPort: key, keyType: 'RDP TLS 인증서', fingerprint: fp, changed: !!known, oldFingerprint: known?.fingerprint })
  if (ok) store.setKnownHost({ hostPort: key, keyType: 'rdp-tls', fingerprint: fp, addedAt: Date.now() })
  return !!ok
}

function findHost(hostId: string): Host {
  const host = store.get().hosts.find((h) => h.id === hostId)
  if (!host) throw new Error('서버를 찾을 수 없습니다')
  if (!host.host) throw new Error('서버 주소가 없습니다')
  return host
}

export async function openRdp(hostId: string, openIn?: 'tab' | 'window'): Promise<{ mode: 'builtin' | 'external'; check: RdpCheck; tab?: RdpTabInfo }> {
  const host = findHost(hostId)
  const o = rdpOptions(host)
  store.touchHost(host.id)
  return o.mode === 'external' ? openExternal(host, o) : openBuiltin(host, o, (openIn ?? o.openIn) !== 'window' && !!mainWin)
}

/** 탭 연결을 정리한다 — 탭을 닫거나 메인 창이 새로 고쳐질 때 */
function release(token: string): void {
  const s = sessions.get(token)
  if (!s) return
  sessions.delete(token)
  if (s.inTab && !s.win.isDestroyed()) s.win.webContents.setIgnoreMenuShortcuts(false)
  if (hot?.token === token) setHot(null)
  unregisterTarget(token)
  s.route.close()
}

async function openBuiltin(host: Host, o: RdpOptions, inTab: boolean): Promise<{ mode: 'builtin'; check: RdpCheck; tab?: RdpTabInfo }> {
  const route = await openRdpRoute(host, o)
  let handed = false
  try {
    const check = await checkRdp(host, o, route)
    if (check.state !== 'ok') throw new Error(`${host.alias || host.host}: ${check.message}`)
    if (!check.fingerprint) throw new Error(`${host.alias || host.host}: ${check.message || '내장 연결은 TLS·NLA 를 쓰는 서버만 지원합니다'}`)
    if (!(await trustCertificate(host, o, check.fingerprint))) throw new Error('서버 인증서를 신뢰하지 않아 연결을 취소했습니다')
    const token = randomBytes(24).toString('base64url')
    const wsPort = await gatewayPort()
    const cred = credentials(host, o)
    const info: RdpWindowInfo = {
      title: host.alias || host.host,
      hostId: host.id,
      wsUrl: `ws://127.0.0.1:${wsPort}/rdp/${token}`,
      token,
      destination: route.target,
      ...cred,
      clipboard: o.clipboard,
      resolution: o.resolution,
      color: host.color,
      route: route.label,
      security: check.security,
      theme: store.get().settings.theme,
      options: viewOptions(o)
    }
    registerTarget(token, {
      route,
      fingerprint: check.fingerprint,
      servername: host.host,
      // 막대에서 바꾼 화질·소리가 다시 연결할 때 적용되게 접속마다 저장된 값을 읽는다
      patch: () => {
        const cur = rdpOptions(store.get().hosts.find((x) => x.id === host.id) ?? host)
        const fb = depthFallback.get(host.id)
        return clientPatchOf(fb && cur.colorDepth === 15 ? { ...cur, colorDepth: fb } : cur)
      },
      onLog: (m) => {
        console.log(`[rdp ${host.alias || host.host}] ${m}`)
        const s = sessions.get(token)
        if (s && !s.win.isDestroyed()) s.win.webContents.send('rdp:log', token, m)
      }
    })
    if (inTab && mainWin) {
      sessions.set(token, { token, hostId: host.id, win: mainWin, route, info, connected: false, inTab: true })
      handed = true
      return { mode: 'builtin', check, tab: { token, hostId: host.id, title: info.title, color: host.color } }
    }
    const win = createRdpWindow(info)
    const s: RdpSession = { token, hostId: host.id, win, route, info, connected: false, inTab: false }
    sessions.set(token, s)
    handed = true
    win.on('closed', () => { if (hot?.token === token) setHot(null); release(token) })
    return { mode: 'builtin', check }
  } finally {
    if (!handed) route.close()
  }
}

function createRdpWindow(info: RdpWindowInfo): BrowserWindow {
  const fixed = /^(\d{3,5})x(\d{3,5})$/.exec(info.resolution)
  const dark = info.theme !== 'light'
  const win = new BrowserWindow({
    width: fixed ? Math.min(+fixed[1], 2560) : 1280,
    height: fixed ? Math.min(+fixed[2] + 36, 1600) : 800,
    minWidth: 640,
    minHeight: 420,
    title: `${info.title} — 원격 데스크톱`,
    backgroundColor: dark ? '#0f1115' : '#f5f6f8',
    show: false,
    autoHideMenuBar: true,
    icon: join(__dirname, '../../resources/icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  })
  win.setMenuBarVisibility(false)
  win.once('ready-to-show', () => win.show())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.on('close', (e) => {
    const s = sessions.get(info.token)
    if (!s?.connected || (win as BrowserWindow & { _forceClose?: boolean })._forceClose) return
    e.preventDefault()
    win.webContents.send('rdp:confirmClose')
  })
  const q = `?t=${encodeURIComponent(info.token)}`
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/rdp.html${q}`)
  else win.loadFile(join(__dirname, '../renderer/rdp.html'), { search: q })
  return win
}

function sessionOf(e: IpcMainInvokeEvent, token: string): RdpSession {
  const s = sessions.get(token)
  if (!s || s.win.webContents.id !== e.sender.id) throw new Error('원격 데스크톱 세션이 없습니다')
  return s
}

// ---------------------------------------------------------------- 외부 앱

/** 점프 호스트·프록시·SSH 터널을 거치는 길은 외부 앱이 직접 갈 수 없어 이 PC 의 포트로 이어 준다 */
function localForward(route: RdpRoute): Promise<{ port: number; server: Server }> {
  return new Promise((resolve, reject) => {
    const conns = new Set<Socket>()
    let idle: NodeJS.Timeout | undefined
    const arm = (): void => {
      clearTimeout(idle)
      // 외부 앱이 붙지 않거나 다 끊은 지 2분이면 정리한다
      idle = setTimeout(() => { if (!conns.size) { server.close(); route.close() } }, 120000)
    }
    const server = createServer((c) => {
      conns.add(c)
      clearTimeout(idle)
      route.connect().then((up) => {
        c.pipe(up).pipe(c)
        const end = (): void => { c.destroy(); up.destroy() }
        c.on('close', end); up.on('close', end)
        c.on('error', end); up.on('error', end)
      }, () => c.destroy())
      c.on('close', () => { conns.delete(c); if (!conns.size) arm() })
    })
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { arm(); resolve({ port: (server.address() as { port: number }).port, server }) })
  })
}

async function openExternal(host: Host, o: RdpOptions): Promise<{ mode: 'external'; check: RdpCheck }> {
  const route = await openRdpRoute(host, o)
  let handed = false
  try {
    const check = await checkRdp(host, o, route)
    if (check.state !== 'ok') throw new Error(`${host.alias || host.host}: ${check.message}`)
    let address = host.host
    let port = o.port || 3389
    if (!route.label.startsWith('직접')) {
      const f = await localForward(route)
      handed = true
      address = '127.0.0.1'
      port = f.port
    }
    const { username, domain } = credentials(host, o)
    const dir = join(tmpdir(), 'brightterm-rdp')
    await fs.mkdir(dir, { recursive: true })
    const safe = (host.alias || host.host).replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(0, 60) || 'server'
    const file = join(dir, `${safe}-${randomUUID().slice(0, 8)}.rdp`)
    await fs.writeFile(file, buildRdpFile({ address, port, username, domain, clipboard: o.clipboard, resolution: o.resolution, colorDepth: o.colorDepth, experience: o.experience, audio: o.audio, dpi: o.dpi }))
    // 앱이 파일을 읽은 뒤 지운다
    setTimeout(() => { fs.rm(file, { force: true }).catch(() => {}) }, 120000)
    if (process.platform === 'win32') {
      const p = spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'mstsc.exe'), [file], { detached: true, stdio: 'ignore' })
      p.on('error', () => {})
      p.unref()
    } else {
      const err = await shell.openPath(file)
      if (err) throw new Error(process.platform === 'darwin'
        ? `.rdp 파일을 열 앱이 없습니다 — App Store 에서 Windows App(Microsoft Remote Desktop)을 설치하거나 내장 연결을 쓰세요 (${err})`
        : `.rdp 파일을 열 앱이 없습니다 — Remmina(remmina-plugin-rdp) 등을 설치하거나 내장 연결을 쓰세요 (${err})`)
    }
    return { mode: 'external', check }
  } finally {
    if (!handed) route.close()
  }
}

// ---------------------------------------------------------------- IPC · 수명

/** RDP 전용 비밀번호를 볼트에 저장하고 서버를 'RDP 전용 비밀번호' 로 바꾼다 */
async function savePassword(s: RdpSession, username: string, domain: string, password: string): Promise<void> {
  if (!vault.isUnlocked()) throw new Error('볼트가 잠겨 있어 저장하지 못했습니다')
  const data = store.get()
  const host = data.hosts.find((h) => h.id === s.hostId)
  if (!host) return
  const o = rdpOptions(host)
  const shared = o.credentialId && data.hosts.some((h) => h.id !== host.id && (h.credentialId === o.credentialId || h.rdp?.credentialId === o.credentialId))
  const meta = vault.save_({ id: o.auth === 'own' && o.credentialId && !shared ? o.credentialId : undefined, name: `${host.alias || host.host} RDP`, kind: 'password', username, password })
  const rdp: RdpOptions = { ...o, auth: 'own', credentialId: meta.id, username: username || undefined, domain: domain || undefined }
  store.patch({ hosts: data.hosts.map((h) => (h.id === host.id ? { ...h, rdp } : h)) })
}

export function rdpCount(): number {
  return [...sessions.values()].filter((s) => s.connected).length
}

export function closeAllRdp(): void {
  for (const s of [...sessions.values()]) {
    if (s.inTab) { release(s.token); continue }
    const w = s.win as BrowserWindow & { _forceClose?: boolean }
    w._forceClose = true
    if (!w.isDestroyed()) w.close()
  }
  closeGateway()
}

export function registerRdp(main: BrowserWindow): void {
  mainWin = main
  main.on('closed', () => { mainWin = null; closeAllRdp() })
  // 메인 창을 새로 고치면 탭이 사라진다 — 탭 연결을 정리한다
  main.webContents.on('did-start-loading', () => { for (const s of [...sessions.values()]) if (s.inTab) release(s.token) })
  const handle = <T extends unknown[], R>(ch: string, fn: (e: IpcMainInvokeEvent, ...a: T) => R | Promise<R>): void => {
    ipcMain.handle(ch, async (e, ...args) => {
      try {
        return { ok: true, value: await fn(e, ...(args as T)) }
      } catch (err) {
        return { ok: false, error: (err as Error).message || String(err) }
      }
    })
  }
  // 편집 중인(저장 전) 서버도 확인할 수 있게 Host 를 그대로 받는다
  handle('rdp:check', (_e, host: Host) => {
    if (!host?.host) throw new Error('서버 주소를 먼저 입력하세요')
    return checkRdp(host, rdpOptions(host))
  })
  handle('rdp:open', (_e, hostId: string, openIn?: 'tab' | 'window') => openRdp(hostId, openIn === 'tab' || openIn === 'window' ? openIn : undefined))
  handle('rdp:info', (e, token: string) => {
    const s = sessionOf(e, token)
    // 저장한 비밀번호가 바뀌었을 수 있다 — 창을 다시 연결할 때마다 새로 읽는다
    const host = store.get().hosts.find((h) => h.id === s.hostId)
    if (host) Object.assign(s.info, credentials(host, rdpOptions(host)), { options: viewOptions(rdpOptions(host)), color: host.color, depthFallback: rdpOptions(host).colorDepth === 15 ? depthFallback.get(host.id) : undefined })
    return s.info
  })
  handle('rdp:state', (e, token: string, connected: boolean) => {
    const s = sessionOf(e, token)
    s.connected = !!connected
    if (!s.inTab) s.win.setTitle(`${s.info.title} — 원격 데스크톱${connected ? '' : ' (연결 끊김)'}`)
  })
  handle('rdp:savePassword', (e, token: string, username: string, domain: string, password: string) => savePassword(sessionOf(e, token), String(username ?? ''), String(domain ?? ''), String(password ?? '')))
  // 원격 화면에 포커스가 있는 동안 앱 메뉴 단축키(⌘Q·⌘W·⌘H·⌘C …)를 끈다 — 키가 그대로 원격으로 간다
  handle('rdp:captureKeys', (e, token: string, on: boolean) => {
    const s = sessionOf(e, token)
    if (s.win.isDestroyed()) return
    s.win.webContents.setIgnoreMenuShortcuts(!!on)
    if (on && s.win.isFocused()) setHot({ wc: s.win.webContents, token })
    else if (hot?.token === token) setHot(null)
  })
  // 창이 뒤로 가면 전역 단축키를 바로 놓는다 — 다른 앱의 ⌘Space 를 가로채지 않게
  app.on('browser-window-blur', (_e, w) => { if (hot && hot.wc === w.webContents) setHot(null) })
  app.on('will-quit', () => setHot(null))
  app.on('render-process-gone', (_e, wc) => { if (hot?.wc === wc) setHot(null) })
  // 15비트 접속이 멈추면(일부 Windows) 16비트로 다시 연결한다
  handle('rdp:depthFallback', (e, token: string) => {
    const s = sessionOf(e, token)
    depthFallback.set(s.hostId, 16)
    return 16
  })
  handle('rdp:setOptions', (e, token: string, p: Partial<RdpViewOptions>) => {
    const s = sessionOf(e, token)
    if (p && 'colorDepth' in p) depthFallback.delete(s.hostId)
    s.info.options = saveViewOptions(s.hostId, p ?? {})
    mainWin?.webContents.send('store:changed')
    return s.info.options
  })
  handle('rdp:fullscreen', (e, token: string) => {
    const s = sessionOf(e, token)
    s.win.setFullScreen(!s.win.isFullScreen())
    return s.win.isFullScreen()
  })
  handle('rdp:close', (e, token: string) => {
    const s = sessionOf(e, token)
    if (s.inTab) return release(token)
    const w = s.win as BrowserWindow & { _forceClose?: boolean }
    w._forceClose = true
    w.close()
  })
  handle('rdp:focusMain', () => {
    if (!mainWin) return
    if (mainWin.isMinimized()) mainWin.restore()
    mainWin.focus()
  })
  app.on('before-quit', () => closeAllRdp())
}
