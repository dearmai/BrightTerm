import { EventEmitter } from 'events'
import { createHash } from 'crypto'
import { createServer, Server, connect as netConnect } from 'net'
import { Client, ClientChannel, ConnectConfig, SFTPWrapper, utils, AnyAuthMethod, AuthenticationType } from 'ssh2'
import type { Host, CredentialSecret, TmuxPick, TmuxSessionInfo } from '@shared/types'
import type { Transport } from './types'
import { eraseChar, hostKeys } from '@shared/terminal'
import { connectSshClient } from './sshConnection'
import { ask } from '../ui'
import { store } from '../store'
import { vault } from '../vault'
import { proxyConnect, proxyLabel } from '../proxy'
import { startupLine, persistSupported, tmuxName, TMUX_LIST_SCRIPT, parseTmuxList, nextTmuxName, tmuxKillScript } from '../persist'

export interface SshContext {
  title: string
  cols: number
  rows: number
  /** Called when the user typed a password and chose to save it */
  onSavePassword?: (username: string, password: string) => void
  /** Called with informative text to show in the terminal */
  onInfo?: (msg: string) => void
  /** 세션 유지 서버에서 붙을 tmux 세션 — 없으면 이전 세션이 있을 때 물어본다 */
  tmux?: TmuxPick
}

/**
 * 서버에서 sh 스크립트를 실행하고 출력(stdout+stderr)을 돌려준다.
 * 로그인 셸이 fish·csh 여도 되도록 명령줄이 아니라 sh 표준입력으로 보낸다.
 */
export function execSh(client: Client, script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    client.exec('sh -s', (err, ch) => {
      if (err) return reject(err)
      let text = ''
      ch.on('data', (d: Buffer) => (text += d.toString('utf8')))
      ch.stderr.on('data', (d: Buffer) => (text += d.toString('utf8')))
      ch.on('close', () => resolve(text))
      ch.end(script)
    })
  })
}

function keyTypeOf(blob: Buffer): string {
  try {
    const len = blob.readUInt32BE(0)
    return blob.subarray(4, 4 + len).toString('ascii')
  } catch {
    return 'unknown'
  }
}

export function fingerprint(blob: Buffer): string {
  return 'SHA256:' + createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')
}

function secretFor(host: Host): CredentialSecret {
  if (!host.credentialId) return {}
  try {
    return vault.get(host.credentialId) ?? {}
  } catch {
    return {}
  }
}

/** 서버 안에 적은 베스천을 접속용 Host 로 — 저장되지 않는 임시 객체 */
function inlineJumpHost(host: Host): Host {
  const j = host.jump!
  return {
    id: `${host.id}:jump`,
    groupId: null,
    alias: `${host.alias} 베스천 (${j.host})`,
    protocol: 'ssh',
    host: j.host,
    port: j.port || 22,
    username: j.username,
    authType: j.authType,
    credentialId: j.credentialId ?? null,
    proxy: host.proxy,
    tags: [],
    encoding: 'utf-8',
    termType: host.termType,
    keepaliveSec: host.keepaliveSec,
    forwards: [],
    sort: 0
  }
}

/** Open an authenticated ssh2 Client for the host (recursively via jump host). */
export async function openClient(host: Host, ctx: SshContext, depth = 0): Promise<{ client: Client; chain: Client[] }> {
  if (depth > 4) throw new Error('점프 호스트 체인이 너무 깁니다')
  const chain: Client[] = []
  let sock: NodeJS.ReadableStream | undefined
  const saved = host.jumpHostId ? store.get().hosts.find((h) => h.id === host.jumpHostId) : undefined
  // 프록시는 이 PC 에서 나가는 첫 연결에 쓴다 — 점프 호스트에 프록시가 없으면 이 서버의 것을 물려준다
  const jh = host.jump?.host ? inlineJumpHost(host) : saved && !saved.proxy?.host && host.proxy?.host ? { ...saved, proxy: host.proxy } : saved
  if (host.jumpHostId && !host.jump?.host && !jh) throw new Error('점프 호스트를 찾을 수 없습니다')
  if (!jh && host.proxy?.host) {
    ctx.onInfo?.(`프록시 ${proxyLabel(host.proxy)} 경유 중...`)
    sock = await proxyConnect(host.proxy, host.host, host.port)
  }
  if (jh) {
    ctx.onInfo?.(`점프 호스트 ${jh.alias} 경유 중...`)
    // 베스천에서 입력한 비밀번호를 이 서버 계정에 저장하면 안 된다 — 저장 콜백은 넘기지 않는다
    const j = await openClient(jh, { ...ctx, title: jh.alias, onSavePassword: undefined }, depth + 1)
    chain.push(...j.chain, j.client)
    sock = await new Promise<ClientChannel>((res, rej) =>
      j.client.forwardOut('127.0.0.1', 0, host.host, host.port, (err, ch) => (err ? rej(err) : res(ch)))
    )
  }

  const secret = secretFor(host)
  let username = host.username || secret.username || ''
  if (!username) {
    const u = await ask<string>({ kind: 'username', sessionTitle: ctx.title })
    if (!u) throw new Error('사용자 이름이 입력되지 않았습니다')
    username = u
  }

  // Prepare private key (decrypt check / passphrase)
  let privateKey: string | undefined = secret.privateKey
  let passphrase: string | undefined = secret.passphrase
  if (privateKey) {
    let parsed = utils.parseKey(privateKey, passphrase)
    let tries = 0
    while (parsed instanceof Error && /passphrase|encrypted|decrypt/i.test(parsed.message) && tries < 3) {
      const p = await ask<string>({ kind: 'passphrase', sessionTitle: ctx.title })
      if (p == null) break
      passphrase = p
      parsed = utils.parseKey(privateKey, passphrase)
      tries++
    }
    if (parsed instanceof Error) {
      ctx.onInfo?.(`개인 키를 읽을 수 없습니다: ${parsed.message} (PPK v3 키는 PuTTYgen에서 OpenSSH 형식으로 내보내 주세요)`)
      privateKey = undefined
    }
  }

  let password = secret.password
  let typedPassword: string | null = null
  let saveTyped = false
  const tried = new Set<string>()
  let askCount = 0

  const hostPort = `${host.host}:${host.port}`
  const cfg: ConnectConfig = {
    host: host.host,
    port: host.port,
    username,
    sock: sock as ConnectConfig['sock'],
    readyTimeout: 20000,
    keepaliveInterval: Math.max(0, host.keepaliveSec) * 1000,
    keepaliveCountMax: 4,
    tryKeyboard: true,
    hostVerifier: ((key: Buffer, verify: (ok: boolean) => void) => {
      const fp = fingerprint(key)
      const kt = keyTypeOf(key)
      const known = store.findKnownHost(hostPort)
      if (known && known.fingerprint === fp) return verify(true)
      ask<boolean>({
        kind: 'hostkey',
        sessionTitle: ctx.title,
        hostPort,
        keyType: kt,
        fingerprint: fp,
        changed: !!known,
        oldFingerprint: known?.fingerprint
      }).then((ok) => {
        if (ok) store.setKnownHost({ hostPort, keyType: kt, fingerprint: fp, addedAt: Date.now() })
        verify(!!ok)
      })
    }) as ConnectConfig['hostVerifier'],
    authHandler: (methodsLeft: AuthenticationType[] | null, _partial: boolean, next: (m: AnyAuthMethod | false) => void) => {
      const left = methodsLeft ?? ['publickey', 'password', 'keyboard-interactive']
      const can = (m: AuthenticationType): boolean => left.includes(m)
      ;(async () => {
        if (privateKey && can('publickey') && !tried.has('publickey')) {
          tried.add('publickey')
          return next({ type: 'publickey', username, key: privateKey, passphrase })
        }
        if ((host.authType === 'agent' || host.authType === 'key') && can('publickey') && !tried.has('agent')) {
          tried.add('agent')
          const agent = process.platform === 'win32' ? 'pageant' : process.env.SSH_AUTH_SOCK
          if (agent) return next({ type: 'agent', username, agent })
        }
        if (password && can('password') && !tried.has('password-saved')) {
          tried.add('password-saved')
          return next({ type: 'password', username, password })
        }
        if (can('keyboard-interactive') && !tried.has('kbd')) {
          tried.add('kbd')
          let usedSaved = false
          return next({
            type: 'keyboard-interactive',
            username,
            prompt: (name, instructions, _lang, prompts, finish) => {
              if (prompts.length === 1 && !prompts[0].echo && /pass/i.test(prompts[0].prompt) && password && !usedSaved) {
                usedSaved = true
                return finish([password])
              }
              if (prompts.length === 1 && !prompts[0].echo && /pass/i.test(prompts[0].prompt)) {
                ask<{ password: string; save: boolean }>({
                  kind: 'password', sessionTitle: ctx.title, prompt: prompts[0].prompt, username, allowSave: true, failed: askCount++ > 0 || usedSaved
                }).then((r) => {
                  if (!r) return finish([])
                  typedPassword = r.password
                  saveTyped = r.save
                  finish([r.password])
                })
                return
              }
              ask<string[]>({ kind: 'keyboard', sessionTitle: ctx.title, name, instructions, prompts: prompts.map((p) => ({ prompt: p.prompt, echo: !!p.echo })) })
                .then((ans) => finish(ans ?? []))
            }
          })
        }
        if (can('password') && askCount < 4) {
          const r = await ask<{ password: string; save: boolean }>({
            kind: 'password', sessionTitle: ctx.title, prompt: `${username}@${host.host} 비밀번호`, username, allowSave: true, failed: askCount++ > 0 || tried.has('password-saved')
          })
          if (!r) return next(false)
          typedPassword = r.password
          saveTyped = r.save
          password = r.password
          tried.add('password-saved')
          return next({ type: 'password', username, password: r.password })
        }
        next(false)
      })().catch(() => next(false))
    }
  } as ConnectConfig

  const client = new Client()
  try {
    await connectSshClient(client, cfg)
  } catch (error) {
    for (const jump of chain.reverse()) jump.end()
    throw error
  }
  if (typedPassword && saveTyped) ctx.onSavePassword?.(username, typedPassword)
  return { client, chain }
}

export class SshTransport extends EventEmitter implements Transport {
  client: Client | null = null
  private chain: Client[] = []
  private stream: ClientChannel | null = null
  private sftpP: Promise<SFTPWrapper> | null = null
  private servers: Server[] = []
  private closed = false
  /** 붙은 tmux 세션 이름 (세션 유지 서버) */
  tmuxSession?: string
  /** 세션 유지 서버지만 세션 고르기에서 tmux 없이 일반 접속을 골랐다 */
  plain = false

  constructor(private host: Host, private ctx: SshContext) {
    super()
  }

  /**
   * 세션 유지 서버: 이 서버의 tmux 세션 중 무엇에 붙을지 정한다. 정해 둔 이름이 있으면 그것,
   * 'auto' 면 아무도 안 보는 최근 세션(없으면 새로), 아니면 이전 세션이 있을 때만 물어본다.
   * 서버에 tmux 가 없으면 undefined — 셸에 넣는 한 줄이 안내만 찍는다.
   */
  private async pickTmux(client: Client): Promise<string | undefined> {
    const pick = this.ctx.tmux
    if (typeof pick === 'object') return pick.name
    const base = tmuxName(this.host)
    for (;;) {
      const list = parseTmuxList(await execSh(client, TMUX_LIST_SCRIPT).catch(() => ''), base)
      if (!list) return undefined
      const fresh = nextTmuxName(base, list.map((s) => s.name))
      if (!list.length) return fresh
      if (pick === 'auto') return (list.find((s) => !s.attached) ?? list[0]).name
      const r = await ask<{ action: 'attach' | 'kill'; name: string } | { action: 'new' } | { action: 'plain' }>({ kind: 'tmux', sessionTitle: this.ctx.title, sessions: list as TmuxSessionInfo[] })
      if (!r) throw new Error('세션 선택을 취소했습니다')
      if (r.action === 'plain') {
        this.plain = true
        return undefined
      }
      if (r.action === 'new') return fresh
      if (r.action === 'attach') return r.name
      await execSh(client, tmuxKillScript(r.name)).catch(() => '')
    }
  }

  async start(): Promise<void> {
    const { client, chain } = await openClient(this.host, this.ctx)
    this.client = client
    this.chain = chain
    try {
      if (persistSupported(this.host)) this.tmuxSession = await this.pickTmux(client)
    } catch (e) {
      this.finish()
      throw e
    }
    this.stream = await new Promise<ClientChannel>((res, rej) =>
      client.shell({ term: this.host.termType || 'xterm-256color', cols: this.ctx.cols, rows: this.ctx.rows, modes: { VERASE: eraseChar(hostKeys(this.host)) } }, (err, s) => (err ? rej(err) : res(s)))
    )
    this.stream.on('data', (d: Buffer) => this.emit('data', d))
    this.stream.stderr.on('data', (d: Buffer) => this.emit('data', d))
    this.stream.on('close', () => this.finish())
    client.on('close', () => this.finish('연결이 종료되었습니다'))
    this.setupForwards()
    const line = startupLine(this.plain ? { ...this.host, persist: false } : this.host, this.tmuxSession)
    if (line) setTimeout(() => this.stream?.write(line.replace(/\r?\n/g, '\r') + '\r'), 400)
  }

  private setupForwards(): void {
    const c = this.client!
    for (const f of this.host.forwards ?? []) {
      if (f.type === 'L') {
        const srv = createServer((sock) => {
          c.forwardOut(sock.remoteAddress || '127.0.0.1', sock.remotePort || 0, f.destHost, f.destPort, (err, ch) => {
            if (err) return sock.destroy()
            sock.pipe(ch).pipe(sock)
            sock.on('error', () => ch.close())
            ch.on('error', () => sock.destroy())
          })
        })
        srv.on('error', (e) => this.ctx.onInfo?.(`포트 포워딩 L${f.bindPort} 실패: ${e.message}`))
        srv.listen(f.bindPort, f.bindHost || '127.0.0.1', () => this.ctx.onInfo?.(`포워딩 ${f.bindHost || '127.0.0.1'}:${f.bindPort} → ${f.destHost}:${f.destPort}`))
        this.servers.push(srv)
      } else {
        c.forwardIn(f.bindHost || '127.0.0.1', f.bindPort, (err) => {
          if (err) this.ctx.onInfo?.(`원격 포워딩 R${f.bindPort} 실패: ${err.message}`)
          else this.ctx.onInfo?.(`원격 포워딩 ${f.bindPort} → ${f.destHost}:${f.destPort}`)
        })
      }
    }
    c.on('tcp connection', (info, accept, reject) => {
      const f = this.host.forwards.find((x) => x.type === 'R' && x.bindPort === info.destPort)
      if (!f) return reject()
      const ch = accept()
      const sock = netConnect(f.destPort, f.destHost)
      sock.pipe(ch).pipe(sock)
      sock.on('error', () => ch.close())
    })
  }

  sftp(): Promise<SFTPWrapper> {
    if (!this.client) return Promise.reject(new Error('연결되지 않음'))
    if (!this.sftpP) {
      this.sftpP = new Promise((res, rej) => this.client!.sftp((err, s) => (err ? rej(err) : res(s))))
      this.sftpP.catch(() => (this.sftpP = null))
    }
    return this.sftpP
  }

  /** Run a one-off command on the same connection (used for helpers e.g. cleanup, cwd). */
  exec(cmd: string): Promise<string> {
    return new Promise((res, rej) => {
      if (!this.client) return rej(new Error('연결되지 않음'))
      this.client.exec(cmd, (err, ch) => {
        if (err) return rej(err)
        let out = ''
        ch.on('data', (d: Buffer) => (out += d.toString('utf8')))
        ch.stderr.on('data', () => {})
        ch.on('close', () => res(out))
      })
    })
  }

  /** 붙어 있는 tmux 세션을 서버에서 끝낸다(안의 프로그램까지). 응답이 없어도 5초 뒤에는 돌아온다 */
  async killTmux(): Promise<void> {
    if (!this.client || !this.tmuxSession) return
    await Promise.race([
      execSh(this.client, tmuxKillScript(this.tmuxSession)).catch(() => ''),
      new Promise((r) => setTimeout(r, 5000))
    ])
  }

  write(data: Buffer): void {
    this.stream?.write(data)
  }

  resize(cols: number, rows: number): void {
    this.stream?.setWindow(rows, cols, 0, 0)
  }

  private finish(reason?: string): void {
    if (this.closed) return
    this.closed = true
    for (const s of this.servers) s.close()
    try { this.client?.end() } catch { /* */ }
    for (const c of this.chain.reverse()) try { c.end() } catch { /* */ }
    this.emit('close', reason)
  }

  close(): void {
    this.finish()
  }
}
