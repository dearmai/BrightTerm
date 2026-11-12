import { randomUUID } from 'crypto'
import { join } from 'path'
import * as iconv from 'iconv-lite'
import type { AdhocTarget, Host, SessionInfo, SessionState, TmuxPick } from '@shared/types'
import { ENV_COLORS } from '@shared/types'
import { DEFAULT_SHELL_PROMPT_EXAMPLE } from '@shared/shellPrompt'
import { resolveReconnectPolicy, reconnectDelay, canReconnect, isAuthFailure } from '@shared/reconnect'
import { hostKeys, mapKeys } from '@shared/terminal'
import { isMouseReport } from '@shared/mouse'
import type { Transport } from './transports/types'
import { SshTransport } from './transports/ssh'
import { TelnetTransport } from './transports/telnet'
import { SerialTransport } from './transports/serial'
import { LocalTransport, execLocalSh } from './transports/local'
import { execSh } from './transports/ssh'
import { proxyLabel } from './proxy'
import { typeStartup } from './startup'
import { isShellPrompt, isTerminalReport, nextAltScreen, shouldSendIdleCommand } from './idleGuard'
import { TMOUT_READ_COMMAND, readTmoutResult, describeTmout } from './idleTmout'
import { ConnectLog } from './connectLog'
import { persistSupported, startupPlan, tmuxMouse, tmuxMouseScript, tmuxName } from './persist'
import { send } from './ui'
import { store, dataDir } from './store'
import { SessionLogWriter } from './sessionLog'
import { logStem, resolveSessionLog } from '@shared/sessionLog'
import { vault } from './vault'
import { claimLaunch, type LaunchClaim } from './launch'
import { localNetworkHelp } from './localNetworkHelp'

/** SFTP 확인을 기다리는 시간 — 응답이 없으면 쓸 수 없는 것으로 본다 */
const SFTP_CHECK_MS = 10000

function withTimeout<T>(p: Promise<T>, fallback: T, ms = SFTP_CHECK_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([p, new Promise<T>((res) => { timer = setTimeout(() => res(fallback), ms) })]).finally(() => clearTimeout(timer))
}

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[=>78DEHMc]/g

export function resolveHostColor(h: Host): string | undefined {
  if (h.color) return h.color
  if (h.env && h.env !== 'none') return ENV_COLORS[h.env]
  const groups = store.get().groups
  let gid = h.groupId
  while (gid) {
    const g = groups.find((x) => x.id === gid)
    if (!g) break
    if (g.color) return g.color
    if (g.env && g.env !== 'none') return ENV_COLORS[g.env]
    gid = g.parentId
  }
  return undefined
}

export function resolveHostEnv(h: Host): Host['env'] {
  if (h.env && h.env !== 'none') return h.env
  const groups = store.get().groups
  let gid = h.groupId
  while (gid) {
    const g = groups.find((x) => x.id === gid)
    if (!g) break
    if (g.env && g.env !== 'none') return g.env
    gid = g.parentId
  }
  return 'none'
}

function adhocHost(t: AdhocTarget): Host {
  const protocol = t.protocol ?? 'ssh'
  if (protocol === 'local') {
    return {
      id: 'adhoc-' + randomUUID(),
      groupId: null,
      alias: '로컬 터미널',
      protocol,
      host: '',
      port: 0,
      username: '',
      authType: 'ask',
      tags: [],
      encoding: 'utf-8',
      termType: 'xterm-256color',
      keepaliveSec: 0,
      forwards: [],
      local: { cwd: t.cwd },
      sort: 0
    }
  }
  return {
    id: 'adhoc-' + randomUUID(),
    groupId: null,
    alias: t.title || `${t.username ? t.username + '@' : ''}${t.host}`,
    protocol,
    host: t.host,
    port: t.port ?? (protocol === 'telnet' ? 23 : 22),
    username: t.username ?? '',
    authType: 'ask',
    tags: [],
    encoding: 'utf-8',
    termType: 'xterm-256color',
    keepaliveSec: 30,
    forwards: [],
    sort: 0
  }
}

export class Session {
  info: SessionInfo
  transport: Transport | null = null
  /** 탭 메뉴의 접속 상세 로그 — 재접속해도 이어서 쌓는다 */
  readonly connectLog = new ConnectLog()
  private decoder: iconv.DecoderStream | null = null
  private cols = 120
  private rows = 32
  private userClosed = false
  private retry = 0
  /** 인증 실패 뒤 정상 접속하기 전까지는 자동 재접속하지 않는다 */
  private authFailed = false
  /** 직전 실패 원인 — 자동 재접속이 같은 원인으로 거듭 실패하면 진단을 다시 찍지 않는다 */
  private diagnosedError: string | null = null
  private retryTimer: NodeJS.Timeout | null = null
  private log: SessionLogWriter | null = null
  private lastOutputAt = 0
  private outputTail = ''
  // 유휴 방지 명령 판단용 (idleGuard.ts)
  private lastInputAt = 0
  private lineOpen = false
  private altScreen = false
  private idleTimer: NodeJS.Timeout | null = null
  private startupRunning = false
  private tmoutCheck: 'off' | 'waiting' | 'reading' | 'done' = 'off'
  private tmoutDeadline = 0
  private tmoutOutput = ''

  /** 세션 유지 서버에서 붙을 tmux 세션 — 한 번 붙으면 그 이름으로 고정해 재접속 때 묻지 않는다 */
  private tmux?: TmuxPick
  /** 실행 인자로 받은 비밀번호·키 — 볼트 대신 쓴다 */
  private secret?: LaunchClaim['secret']
  /** 실행 인자로 연 세션 — 일회용 토큰일 수 있어 자동 재접속하지 않는다 */
  private launched: boolean

  constructor(public host: Host, public persistent: boolean, tmux?: TmuxPick, launch?: LaunchClaim) {
    this.tmux = tmux
    this.secret = launch?.secret
    this.launched = !!launch
    this.info = {
      id: randomUUID(),
      hostId: persistent ? host.id : null,
      title: host.alias,
      protocol: host.protocol,
      target: this.targetLabel(),
      color: persistent ? resolveHostColor(host) : undefined,
      env: persistent ? resolveHostEnv(host) : 'none',
      state: 'connecting',
      canSftp: host.protocol === 'ssh',
      persist: persistSupported(host)
    }
  }

  private targetLabel(): string {
    const h = this.host
    if (h.protocol === 'serial') return `${h.serial?.path ?? '?'} @ ${h.serial?.baudRate ?? 9600}`
    if (h.protocol === 'local') return `로컬 · ${h.local?.cwd?.trim() || '~'}`
    return `${h.username ? h.username + '@' : ''}${h.host}:${h.port}`
  }

  private setState(state: SessionState, message?: string): void {
    this.connectLog.add(`상태: ${state}${message ? ` (${message})` : ''}`)
    if (state !== 'connected') this.info = { ...this.info, forwards: [] }
    this.info = { ...this.info, state, message, connectedAt: state === 'connected' ? Date.now() : this.info.connectedAt }
    send('session:state', this.info)
  }

  private emitText(s: string): void {
    send('session:data', this.info.id, s)
  }

  info_(msg: string, color = '36'): void {
    this.connectLog.add(msg)
    this.emitText(`\r\n\x1b[${color}m● ${msg}\x1b[0m\r\n`)
  }

  setSize(cols: number, rows: number): void {
    this.cols = cols
    this.rows = rows
    this.transport?.resize(cols, rows)
  }

  async connect(): Promise<void> {
    const h = this.host
    this.connectLog.beginAttempt()
    this.setState(this.retry ? 'reconnecting' : 'connecting')
    if (h.protocol !== 'local') this.info_(`${this.info.title} (${this.info.target}) 접속 중...`, '90')
    const enc = this.encoding()
    this.decoder = iconv.getDecoder(enc) as unknown as iconv.DecoderStream
    try {
      let t: Transport
      let startup: string[] = []
      if (h.protocol === 'ssh') {
        const st = new SshTransport(h, {
          title: h.alias,
          cols: this.cols,
          rows: this.rows,
          onInfo: (m) => this.info_(m, '90'),
          onForwards: (forwards) => {
            this.info = { ...this.info, forwards }
            send('session:state', this.info)
          },
          onDebug: (m) => this.connectLog.debug(m),
          onSavePassword: (username, password) => this.savePassword(username, password),
          tmux: this.tmux,
          secret: this.secret
        })
        await st.start()
        if (st.tmuxSession) {
          this.tmux = { name: st.tmuxSession }
          this.info = { ...this.info, tmuxSession: st.tmuxSession }
        }
        if (st.plain) {
          // 세션 고르기에서 일반 접속을 골랐다 — 재접속 때도 tmux 없이
          this.host = { ...this.host, persist: false }
          this.info = { ...this.info, persist: false }
        }
        this.info = { ...this.info, tmuxMouse: st.tmuxSession ? tmuxMouse(h) : undefined }
        startup = startupPlan(st.plain ? { ...h, persist: false } : h, st.tmuxSession)
        t = st
      } else if (h.protocol === 'local') {
        const lt = new LocalTransport(h.local ?? {}, h.termType)
        await lt.start(this.cols, this.rows)
        if (lt.cwdFallback) this.info_(`시작 폴더(${h.local?.cwd})가 없어 홈 폴더에서 엽니다`, '33')
        startup = startupPlan(h)
        this.info = { ...this.info, tmuxMouse: persistSupported(h) ? tmuxMouse(h) : undefined }
        t = lt
      } else if (h.protocol === 'telnet') {
        if (h.proxy?.host) this.info_(`프록시 ${proxyLabel(h.proxy)} 경유 중...`, '90')
        const tt = new TelnetTransport(h.host, h.port, h.termType, h.proxy)
        await tt.start(this.cols, this.rows)
        t = tt
      } else {
        if (!h.serial) throw new Error('시리얼 설정이 없습니다')
        const s = new SerialTransport(h.serial)
        await s.start()
        t = s
      }
      this.transport = t
      // 접속하는 동안(tmux 세션 고르기 등) 바뀐 창 크기는 transport 가 없어 전달되지 못했다 — 지금 크기로 맞춘다
      t.resize(this.cols, this.rows)
      this.retry = 0
      this.authFailed = false
      this.diagnosedError = null
      t.on('data', (d: Buffer) => this.onData(d))
      t.on('close', (reason?: string) => this.onClose(reason))
      this.setState('connected')
      if (h.protocol !== 'local') this.emitText('\x1b[2K\r')
      if (this.persistent) store.touchHost(h.id)
      this.openLog()
      if (t instanceof SshTransport) void this.checkSftp(t)
      this.startupRunning = startup.length > 0
      if (h.protocol === 'ssh' || h.protocol === 'telnet') this.startIdleGuard()
      if (startup.length) void this.typeStartup(startup).finally(() => {
        if (this.transport === t) this.startupRunning = false
      })
    } catch (e) {
      const msg = (e as Error).message || String(e)
      this.connectLog.debug(`오류 원문: ${msg}`)
      this.info_(`${h.protocol === 'local' ? '셸 실행 실패' : '접속 실패'}: ${translateError(msg)}`, '31')
      const help = localNetworkHelp(e, h.protocol)
      if (help) this.info_(help, '33')
      this.showDiagnosis(msg)
      this.transport = null
      // 틀린 인증 정보로는 다시 시도해도 실패하고 계정 잠금만 부른다 — 정상 접속할 때까지 자동 재접속을 막는다
      if (isAuthFailure(e)) this.authFailed = true
      this.scheduleReconnect(true)
    }
  }

  private savePassword(username: string, password: string): void {
    try {
      if (!vault.isUnlocked() || !this.persistent) return
      const meta = vault.save_({ id: this.host.credentialId || undefined, name: this.host.alias, kind: 'password', username, password })
      const hosts = store.get().hosts.map((x) => (x.id === this.host.id ? { ...x, credentialId: meta.id, username: x.username || username, authType: x.authType === 'ask' ? 'password' as const : x.authType } : x))
      store.patch({ hosts })
      this.host = hosts.find((x) => x.id === this.host.id) ?? this.host
      send('store:changed')
      this.info_('비밀번호를 볼트에 저장했습니다', '90')
    } catch { /* ignore */ }
  }

  /** 접속 실패 원인 파악용 — 이번 시도의 핵심 디버그 줄(ssh -v 요약)을 터미널에 보인다. 비밀번호·입력 내용은 디버그 줄에 없다 */
  private showDiagnosis(error: string): void {
    if (this.host.protocol === 'local') return
    if (this.diagnosedError === error) {
      this.emitText('\x1b[90m  (직전과 같은 원인 — 접속 진단 생략. 전체: 탭 메뉴 → 접속 상세 로그)\x1b[0m\r\n')
      return
    }
    const lines = this.connectLog.attemptSummary()
    if (!lines.length) return
    this.diagnosedError = error
    const body = lines.map((l) => `\x1b[90m  debug: ${l.replace(/[\x00-\x1f\x7f]/g, ' ')}\x1b[0m`).join('\r\n')
    this.emitText(`\r\n\x1b[90m● 접속 진단 (ssh -v 요약 · 전체: 탭 메뉴 → 접속 상세 로그)\x1b[0m\r\n${body}\r\n`)
  }

  /** 서버별 설정이 있으면 그것, 없으면 앱 설정으로 이 연결의 출력을 기록한다 */
  private openLog(): void {
    this.closeLog()
    const { enabled, options } = resolveSessionLog(store.get().settings, this.savedHost())
    if (!enabled) return
    this.log = SessionLogWriter.open({
      stem: logStem(this.host.alias),
      title: `${this.info.title} (${this.info.target})`,
      options,
      baseDir: join(dataDir(), 'logs'),
      onNotice: (m) => this.info_(m, '33')
    })
    if (this.log) this.connectLog.add(`세션 로그: ${this.log.path}`)
  }

  private closeLog(): void {
    this.log?.close()
    this.log = null
  }

  private onData(d: Buffer): void {
    const s = this.decoder ? this.decoder.write(d) : d.toString('utf8')
    this.lastOutputAt = Date.now()
    if (s) {
      // 큰 출력에서 켜는 코드가 tail 밖으로 밀려나지 않게 받은 조각에서 본다 (앞 조각과 나뉜 경우까지)
      this.altScreen = nextAltScreen(this.altScreen, this.outputTail.slice(-12) + s)
      this.outputTail = (this.outputTail + s).slice(-300)
      this.emitText(s)
      this.log?.write(s)
      if (this.tmoutCheck === 'reading') {
        this.tmoutOutput = (this.tmoutOutput + s).slice(-2048)
        const value = readTmoutResult(this.tmoutOutput.replace(ANSI, ''))
        if (value !== undefined) {
          this.tmoutCheck = 'done'
          const interval = this.savedHost().idleCommandSec
          if (interval) {
            const result = describeTmout(value, interval)
            this.info_(result.message, result.warning ? '33' : '90')
          }
        }
      }
    }
  }

  /** 서버가 SFTP 서브시스템을 여는지 백그라운드로 확인 — 연 채널은 파일 패널이 그대로 쓴다.
   *  안 되면 명령 채널(exec)을 확인해, 되면 셸 명령으로 파일을 다룬다 */
  private async checkSftp(t: SshTransport): Promise<void> {
    this.info = { ...this.info, sftp: 'checking', canSftp: true }
    send('session:state', this.info)
    const ok = await withTimeout(t.sftp().then(() => true, () => false), false)
    const shell = !ok && (await withTimeout(t.exec('echo BT_OK').then((out) => out.includes('BT_OK'), () => false), false))
    if (this.transport !== t) return
    this.info = { ...this.info, sftp: ok ? 'ok' : shell ? 'shell' : 'unavailable', canSftp: ok || shell }
    send('session:state', this.info)
  }

  /** 접속 후 실행 명령을 한 줄씩 (startup.ts) — 재접속·종료되면 멈춘다 */
  private typeStartup(lines: string[]): Promise<number> {
    const t = this.transport
    return typeStartup(lines, {
      write: (line) => this.write(line),
      lastOutputAt: () => this.lastOutputAt,
      tail: () => this.outputTail,
      alive: () => !!t && this.transport === t,
      notice: (m) => this.info_(m, '33')
    })
  }

  /** 접속 중에 서버 설정을 바꿔도 바로 적용되도록 저장된 값을 본다 (저장 안 한 서버는 this.host) */
  private savedHost(): Host {
    return store.get().hosts.find((h) => h.id === this.host.id) ?? this.host
  }

  private announceIdleGuard(): void {
    const { idleCommandSec, idleCommand } = this.savedHost()
    if (!idleCommandSec) return
    if (this.sshTransport()?.tmuxSession) {
      this.tmoutCheck = 'done'
      this.info_('유휴 방지는 설정되어 있지만 tmux 세션 유지 창에서는 동작하지 않습니다. 해당 tmux 셸의 TMOUT 값도 자동 조회하지 않습니다.', '33')
      return
    }
    this.info_(`유휴 방지 켜짐 — ${idleCommandSec}초 간격, ${idleCommand === '' ? 'Enter만 전송' : '명령 ' + JSON.stringify(idleCommand ?? 'date')}. 셸 프롬프트에서 입력 중이 아닐 때만 보냅니다. Keepalive는 셸의 TMOUT을 막지 못합니다.`, '90')
    this.info_('현재 접속한 셸의 TMOUT 값을 확인합니다. 안전한 셸 프롬프트를 기다린 뒤 조회 명령을 한 번 보냅니다.', '90')
    this.tmoutCheck = 'waiting'
    this.tmoutDeadline = Date.now() + 60000
  }

  private startIdleGuard(): void {
    this.stopIdleGuard()
    this.outputTail = ''
    this.altScreen = false
    this.lineOpen = false
    this.lastInputAt = Date.now()
    this.announceIdleGuard()
    this.idleTimer = setInterval(() => {
      const { idleCommandSec, idleCommand, shellPromptExample = DEFAULT_SHELL_PROMPT_EXAMPLE } = this.savedHost()
      if (!idleCommandSec) { this.tmoutCheck = 'off'; return }
      if (this.tmoutCheck === 'off') this.announceIdleGuard()
      if (this.sshTransport()?.tmuxSession || this.startupRunning) return
      const idleMs = Date.now() - Math.max(this.lastInputAt, this.lastOutputAt)
      if (this.tmoutCheck === 'waiting' || this.tmoutCheck === 'reading') {
        if (Date.now() >= this.tmoutDeadline) {
          this.info_(this.tmoutCheck === 'reading'
            ? 'TMOUT 값을 확인하지 못했습니다(조회 응답 10초 초과). 값이 없거나 0이라고 판단하지 않으며, 유휴 방지는 설정된 간격으로 계속 동작합니다.'
            : '안전한 셸 프롬프트를 확인하지 못해 TMOUT 자동 조회를 건너뛰었습니다. 유휴 방지는 설정된 간격으로 계속 동작합니다.', '33')
          this.tmoutCheck = 'done'
        } else if (this.tmoutCheck === 'waiting' && !this.altScreen && !this.lineOpen && idleMs >= 500 && isShellPrompt(this.outputTail, shellPromptExample)) {
          this.tmoutCheck = 'reading'
          this.tmoutOutput = ''
          this.tmoutDeadline = Date.now() + 10000
          this.write(TMOUT_READ_COMMAND + '\r')
          return
        } else if (this.tmoutCheck === 'reading') return
      }
      if (shouldSendIdleCommand({ shellPromptExample, tail: this.outputTail, altScreen: this.altScreen, lineOpen: this.lineOpen, idleMs, intervalMs: idleCommandSec * 1000 })) {
        this.write((idleCommand ?? 'date') + '\r')
      }
    }, 1000)
    this.idleTimer.unref()
  }

  private stopIdleGuard(): void {
    if (this.idleTimer) clearInterval(this.idleTimer)
    this.idleTimer = null
    this.tmoutCheck = 'off'
    this.tmoutOutput = ''
  }

  private onClose(reason?: string): void {
    this.transport = null
    this.stopIdleGuard()
    this.closeLog()
    if (this.userClosed) return
    if (this.host.protocol === 'local') {
      this.setState('closed')
      this.info_(`${reason ?? '셸이 종료되었습니다'} — Enter 키를 누르면 새 셸을 엽니다.`, '90')
      return
    }
    this.info_(reason ? `연결 끊김: ${reason}` : '연결이 끊어졌습니다', '33')
    this.scheduleReconnect(false)
  }

  private scheduleReconnect(failed: boolean): void {
    const host = this.savedHost()
    const settings = store.get().settings
    const auto = (host.autoReconnect ?? settings.autoReconnect) && this.host.protocol !== 'serial' && !this.launched
    const policy = resolveReconnectPolicy(settings.reconnectPolicy, host.reconnectPolicy)
    // only auto-retry when a previously working session drops (or retries in progress)
    if (auto && this.authFailed && this.retry > 0) this.info_('인증에 실패해 자동 재접속을 중단합니다. 인증 정보를 확인한 뒤 다시 접속하세요. 정상 접속 후에는 자동 재접속이 다시 동작합니다.', '33')
    if (auto && !this.authFailed && (!failed || this.retry > 0) && canReconnect(policy, this.retry)) {
      const delay = reconnectDelay(policy, this.retry)
      this.retry++
      const count = policy.maxAttempts ? `${this.retry}/${policy.maxAttempts}` : `${this.retry}회 · 무제한`
      this.setState('reconnecting', `${delay}초 후 재접속 (${count})`)
      this.info_(`${delay}초 후 자동 재접속합니다 (${count}). Enter: 즉시 재접속`, '90')
      this.retryTimer = setTimeout(() => { this.retryTimer = null; void this.connect() }, delay * 1000)
    } else {
      if (auto && !this.authFailed && this.retry > 0 && !canReconnect(policy, this.retry)) this.info_(`자동 재접속 최대 ${policy.maxAttempts}회에 도달해 중단합니다.`, '33')
      this.retry = 0
      this.setState(failed ? 'error' : 'closed')
      this.info_('Enter 키를 누르면 다시 접속합니다.', '90')
    }
  }

  reconnectNow(): void {
    if (this.transport) return
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.connect()
  }

  /** 로컬 셸은 항상 UTF-8 (pty 가 문자열로 주고받는다) */
  private encoding(): string {
    const h = this.host
    if (h.protocol === 'local') return 'utf-8'
    return h.encoding === 'cp949' ? 'euc-kr' : h.encoding || 'utf-8'
  }

  write(data: string): void {
    const mouse = isMouseReport(data)
    if (mouse && (this.info.state !== 'connected' || this.savedHost().mouseReporting === false)) return
    if (!this.transport) {
      if (data === '\r' && this.info.state !== 'connecting') this.reconnectNow()
      return
    }
    if (!mouse && !isTerminalReport(data)) {
      this.lastInputAt = Date.now()
      this.lineOpen = !/[\r\n]$/.test(data)
    }
    // 로컬 셸은 pty 가 알아서 하고, 시리얼 Enter 는 시리얼 설정을 따른다
    if (this.host.protocol !== 'local') data = mapKeys(data, hostKeys(this.host), this.host.protocol !== 'serial')
    const enc = this.encoding()
    this.transport.write(enc === 'utf-8' ? Buffer.from(data, 'utf8') : iconv.encode(data, enc))
  }

  sshTransport(): SshTransport | null {
    return this.transport instanceof SshTransport ? this.transport : null
  }

  /** 붙어 있는 tmux 세션의 마우스 모드를 바꾼다. 재접속 때도 바꾼 값으로 붙는다 */
  async setTmuxMouse(on: boolean): Promise<void> {
    if (this.info.tmuxMouse === undefined) throw new Error('tmux 세션에 붙어 있지 않습니다')
    const ssh = this.sshTransport()
    if (ssh?.client && ssh.tmuxSession) await execSh(ssh.client, tmuxMouseScript(ssh.tmuxSession, on))
    else if (this.transport instanceof LocalTransport) await execLocalSh(tmuxMouseScript(tmuxName(this.host), on))
    else throw new Error('연결되지 않음')
    this.host = { ...this.host, persistMouse: on }
    this.info = { ...this.info, tmuxMouse: on }
    send('session:state', this.info)
  }

  /** killTmux: 세션 유지 창이면 붙어 있던 tmux 세션도 서버에서 끝낸 뒤 끊는다 */
  async close(killTmux = false): Promise<void> {
    this.userClosed = true
    this.stopIdleGuard()
    if (this.retryTimer) clearTimeout(this.retryTimer)
    const t = this.transport
    this.transport = null
    if (killTmux && t instanceof SshTransport) await t.killTmux()
    t?.close()
    this.closeLog()
  }
}

function translateError(m: string): string {
  if (/ECONNREFUSED/.test(m)) return '서버가 접속을 거부했습니다 (포트 확인)'
  if (/ETIMEDOUT|Timed out/i.test(m)) return '응답 시간 초과 (주소·방화벽 확인)'
  if (/ENOTFOUND|EAI_AGAIN/.test(m)) return '호스트 이름을 찾을 수 없습니다'
  if (/EHOSTUNREACH|ENETUNREACH/.test(m)) return '네트워크에 도달할 수 없습니다'
  if (/All configured authentication methods failed/i.test(m)) return '인증 실패 (사용자 이름/비밀번호/키 확인)'
  if (/host key|Host denied/i.test(m)) return '호스트 키를 승인하지 않아 접속을 중단했습니다'
  if (/Access denied|File not found|cannot open/i.test(m)) return m + ' (포트 사용 중이거나 권한 없음)'
  return m
}

class SessionManager {
  sessions = new Map<string, Session>()
  /** 실행 인자로 연 세션의 브릿지 파이프 */
  private bridges = new Map<string, LaunchClaim['bridge']>()

  /** run: 세션 유지 없이 접속해 이 명령만 입력한다(서버에 tmux 설치 등). launch: 실행 인자로 들어온 요청 id */
  open(opts: { hostId?: string; adhoc?: AdhocTarget; cols?: number; rows?: number; tmux?: TmuxPick; run?: string; launch?: string }): SessionInfo {
    let host: Host | undefined
    let persistent = true
    if (opts.hostId) host = store.get().hosts.find((h) => h.id === opts.hostId)
    if (!host && opts.adhoc) {
      host = adhocHost(opts.adhoc)
      persistent = false
    }
    if (!host) throw new Error('서버를 찾을 수 없습니다')
    const h = structuredClone(host)
    if (opts.run) Object.assign(h, { persist: false, startupCommand: opts.run })
    if (opts.tmux === 'none') h.persist = false
    const claim = opts.launch ? claimLaunch(opts.launch) : undefined
    const s = new Session(h, persistent, opts.tmux, claim)
    if (opts.cols && opts.rows) s.setSize(opts.cols, opts.rows)
    this.sessions.set(s.info.id, s)
    if (claim?.bridge) this.bindBridge(s.info.id, claim.bridge)
    // give renderer a tick to register the terminal before data arrives
    setTimeout(() => s.connect(), 30)
    return s.info
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id)
  }

  async close(id: string, killTmux = false): Promise<void> {
    const s = this.sessions.get(id)
    this.sessions.delete(id)
    const b = this.bridges.get(id)
    this.bridges.delete(id)
    b?.destroy()
    await s?.close(killTmux)
  }

  /** 브릿지(putty.exe 등)가 끝나면(보안 프로그램이 접속 시간 만료로 끝내는 경우 등) 세션도 닫는다 */
  private bindBridge(id: string, sock: NonNullable<LaunchClaim['bridge']>): void {
    if (sock.destroyed) return
    this.bridges.set(id, sock)
    sock.on('close', () => {
      if (!this.bridges.delete(id)) return
      this.close(id)
      send('launch:closed', id)
    })
  }

  closeAll(): void {
    for (const s of this.sessions.values()) s.close()
    this.sessions.clear()
    for (const b of this.bridges.values()) b?.destroy()
    this.bridges.clear()
  }
}

export const sessions = new SessionManager()
