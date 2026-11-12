// RDP 서버까지 가는 TCP 길 — 직접 / 서버의 점프 호스트·프록시 / 이 서버의 SSH 터널.
// SSH 를 거치는 길은 한 번 연 SSH 연결을 확인·접속에 같이 쓰고 다 쓰면 닫는다.
import { connect as netConnect } from 'net'
import { connect as tlsConnect, type TLSSocket } from 'tls'
import { createHash } from 'crypto'
import type { Duplex } from 'stream'
import type { Client, ClientChannel } from 'ssh2'
import type { Host, RdpCheck, RdpOptions } from '@shared/types'
import { PROTOCOL_HYBRID, PROTOCOL_HYBRID_EX, PROTOCOL_SSL, negotiationFailureLabel, parseX224Confirm, protocolLabel, tpktLength, x224ConnectionRequest, type X224Confirm } from '@shared/rdp'
import { openClient, openRoute, type SshContext } from '../transports/ssh'

const CONNECT_TIMEOUT = 10000

export interface RdpRoute {
  /** 예: 직접 10.0.0.5:3389, SSH 터널 (WEB01) → 127.0.0.1:3389 */
  label: string
  /** 표시용 목적지 — 인증서 신뢰 목록의 키에도 쓴다 */
  target: string
  connect(): Promise<Duplex>
  close(): void
}

const hostPort = (h: string, p: number): string => (h.includes(':') ? `[${h}]:${p}` : `${h}:${p}`)

function ctxFor(host: Host): SshContext {
  return { title: host.alias || host.host, cols: 80, rows: 24 }
}

function tcp(host: string, port: number): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const s = netConnect({ host, port })
    s.setNoDelay(true)
    s.setTimeout(CONNECT_TIMEOUT, () => s.destroy(Object.assign(new Error('응답 시간 초과'), { code: 'ETIMEDOUT' })))
    s.once('connect', () => { s.setTimeout(0); resolve(s) })
    s.once('error', reject)
  })
}

function forward(client: Client, host: string, port: number): Promise<Duplex> {
  return new Promise<Duplex>((resolve, reject) => {
    client.forwardOut('127.0.0.1', 0, host, port, (err, ch: ClientChannel) => (err ? reject(err) : resolve(ch)))
  })
}

export async function openRdpRoute(host: Host, o: RdpOptions): Promise<RdpRoute> {
  const port = o.port || 3389
  const target = hostPort(host.host, port)
  if (o.route === 'ssh') {
    if (host.protocol !== 'ssh') throw new Error('SSH 터널은 SSH 서버에서만 쓸 수 있습니다')
    const { client, chain } = await openClient(host, ctxFor(host))
    const all = [client, ...chain.reverse()]
    return {
      label: `SSH 터널 (${host.alias || host.host}) → 127.0.0.1:${port}`,
      target,
      connect: () => forward(client, '127.0.0.1', port),
      close: () => { for (const c of all) try { c.end() } catch { /* */ } }
    }
  }
  // 점프 호스트·프록시가 없으면 바로
  const first = await openRoute(host, port, ctxFor(host))
  if (!first.sock) return { label: `직접 ${target}`, target, connect: () => tcp(host.host, port), close: () => {} }
  let spare: Duplex | undefined = first.sock as unknown as Duplex
  const jump = first.chain[first.chain.length - 1]
  return {
    label: `${first.via} → ${target}`,
    target,
    async connect() {
      if (spare) { const s = spare; spare = undefined; return s }
      if (jump) return forward(jump, host.host, port)
      const again = await openRoute(host, port, ctxFor(host))
      return again.sock as unknown as Duplex
    },
    close() {
      try { spare?.destroy() } catch { /* */ }
      for (const c of first.chain.reverse()) try { c.end() } catch { /* */ }
    }
  }
}

/** TPKT 하나를 읽는다. 다 읽으면 data 받기를 멈춘다(뒤이어 TLS 가 같은 스트림을 쓴다) */
export function readTpkt(sock: Duplex, timeoutMs = CONNECT_TIMEOUT): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0)
    const done = (err: Error | null, v?: Uint8Array): void => {
      clearTimeout(timer)
      sock.off('data', onData)
      sock.off('error', onErr)
      sock.off('close', onClose)
      sock.pause()
      if (err) reject(err)
      else resolve(v!)
    }
    const onData = (d: Buffer): void => {
      buf = Buffer.concat([buf, d])
      const len = tpktLength(buf)
      if (len < 0) return done(new Error('RDP 서버가 아닙니다 (TPKT 아님)'))
      if (len > 0 && buf.length >= len) {
        if (buf.length > len) sock.unshift(buf.subarray(len))
        done(null, buf.subarray(0, len))
      }
    }
    const onErr = (e: Error): void => done(e)
    const onClose = (): void => done(Object.assign(new Error('서버가 연결을 끊었습니다'), { code: 'ECONNRESET' }))
    const timer = setTimeout(() => done(Object.assign(new Error('RDP 응답이 없습니다'), { code: 'ETIMEDOUT' })), timeoutMs)
    sock.on('data', onData)
    sock.once('error', onErr)
    sock.once('close', onClose)
    sock.resume()
  })
}

export const needsTls = (c: X224Confirm): boolean => c.kind === 'selected' && (c.protocol & (PROTOCOL_SSL | PROTOCOL_HYBRID | PROTOCOL_HYBRID_EX)) !== 0

export interface TlsOptions { legacy?: boolean }

/**
 * Windows RDP 자체 서명 인증서는 keyUsage 가 keyEncipherment·dataEncipherment 뿐(digitalSignature 없음)인 경우가 많다.
 * Electron 의 BoringSSL 은 ECDHE·TLS 1.3 에서 이 비트를 엄격히 따져 KEY_USAGE_BIT_INCORRECT 로 끊는다 —
 * mstsc 처럼 TLS 1.2 RSA 키 교환으로 다시 시도한다(서명이 필요 없는 방식)
 */
export const LEGACY_CIPHERS = 'AES256-GCM-SHA384:AES128-GCM-SHA256:AES256-SHA256:AES128-SHA256:AES256-SHA:AES128-SHA'
export const isKeyUsageError = (e: unknown): boolean => {
  const x = e as { code?: string; message?: string }
  return /KEY_USAGE_BIT_INCORRECT/i.test(`${x?.code ?? ''} ${x?.message ?? ''}`)
}

/** RDP 서버 인증서는 대부분 자체 서명 — 체인 검증 대신 지문을 신뢰 목록과 맞춘다 */
export function startTls(sock: Duplex, servername?: string, opt: TlsOptions = {}): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const t = tlsConnect({
      socket: sock,
      rejectUnauthorized: false,
      servername: servername && !/^[\d.:[\]]+$/.test(servername) ? servername : undefined,
      ...(opt.legacy ? { maxVersion: 'TLSv1.2' as const, ciphers: LEGACY_CIPHERS } : {})
    })
    const timer = setTimeout(() => t.destroy(Object.assign(new Error('TLS 응답 시간 초과'), { code: 'ETIMEDOUT' })), CONNECT_TIMEOUT)
    t.once('secureConnect', () => { clearTimeout(timer); resolve(t) })
    t.once('error', (e) => { clearTimeout(timer); reject(e) })
  })
}

export interface Negotiated {
  /** TLS 를 쓰면 TLS 소켓, 아니면 원래 TCP */
  sock: Duplex
  /** 서버가 보낸 X.224 Connection Confirm 원본 */
  x224: Uint8Array
  confirm: X224Confirm
  tls?: TLSSocket
  legacy?: boolean
}

/**
 * TCP 연결 → X.224 요청·응답 → (필요하면) TLS. keyUsage 오류면 새 연결로 X.224 부터 다시 해 RSA 키 교환으로 맺는다.
 * 협상 실패(failure) 는 그대로 돌려준다 — sock 은 호출한 쪽이 닫는다
 */
export async function negotiate(route: RdpRoute, request: Uint8Array, servername?: string, onRetry?: (why: string) => void): Promise<Negotiated> {
  const once = async (legacy: boolean): Promise<Negotiated> => {
    const sock = await route.connect()
    try {
      sock.write(request)
      const x224 = await readTpkt(sock)
      const confirm = parseX224Confirm(x224)
      if (!needsTls(confirm)) return { sock, x224, confirm }
      const tls = await startTls(sock, servername, { legacy })
      return { sock: tls, x224, confirm, tls, legacy }
    } catch (e) {
      sock.destroy()
      throw e
    }
  }
  try {
    return await once(false)
  } catch (e) {
    if (!isKeyUsageError(e)) throw e
    onRetry?.((e as Error).message)
    try {
      return await once(true)
    } catch (e2) {
      throw Object.assign(new Error(`서버 인증서의 키 용도(keyUsage)가 TLS 와 맞지 않습니다 — RSA 키 교환으로도 실패: ${(e2 as Error).message}`), { code: (e2 as { code?: string }).code })
    }
  }
}

/** 서버 인증서 체인(DER) — 첫 번째가 서버 인증서 */
export function certChain(t: TLSSocket): Buffer[] {
  const out: Buffer[] = []
  let c = t.getPeerCertificate(true) as (ReturnType<TLSSocket['getPeerCertificate']> & { issuerCertificate?: ReturnType<TLSSocket['getPeerCertificate']> }) | null
  const seen = new Set<string>()
  while (c && c.raw && !seen.has(c.fingerprint256)) {
    seen.add(c.fingerprint256)
    out.push(c.raw)
    c = c.issuerCertificate as typeof c
  }
  return out
}

export const certFingerprint = (der: Uint8Array): string => 'SHA256:' + createHash('sha256').update(der).digest('base64').replace(/=+$/, '')

/** 오류 → 사용자 문구와 상태 */
export function describeError(e: Error & { code?: string }): { state: RdpCheck['state']; message: string } {
  const code = e.code ?? ''
  const msg = e.message || String(e)
  if (code === 'ECONNREFUSED' || /connection refused|ECONNREFUSED/i.test(msg)) return { state: 'closed', message: 'RDP 포트가 닫혀 있습니다 — 원격 데스크톱이 꺼져 있거나 방화벽이 막고 있습니다' }
  if (code === 'ETIMEDOUT' || /timed? ?out/i.test(msg)) return { state: 'timeout', message: `응답이 없습니다 — 방화벽이 막고 있거나 서버가 꺼져 있습니다 (${msg})` }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return { state: 'error', message: '서버 주소를 찾을 수 없습니다 (DNS)' }
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return { state: 'error', message: '서버로 가는 네트워크 경로가 없습니다' }
  if (code === 'ECONNRESET') return { state: 'error', message: `서버가 연결을 끊었습니다 — RDP 가 아닌 포트이거나 접속을 제한하고 있습니다` }
  return { state: 'error', message: msg }
}

/**
 * RDP 허용 상태 확인 — TCP 연결, X.224 협상(TLS·NLA 요청), TLS 인증서 지문까지.
 * 로그인은 하지 않는다. 이미 열린 route 를 넘기면 그 길을 쓴다(닫지 않음)
 */
export async function checkRdp(host: Host, o: RdpOptions, given?: RdpRoute): Promise<RdpCheck> {
  const started = Date.now()
  let route = given
  let sock: Duplex | undefined
  let label = o.route === 'ssh' ? `SSH 터널 → 127.0.0.1:${o.port}` : `직접 ${hostPort(host.host, o.port)}`
  try {
    route ??= await openRdpRoute(host, o)
    label = route.label
    const n = await negotiate(route, x224ConnectionRequest(PROTOCOL_SSL | PROTOCOL_HYBRID | PROTOCOL_HYBRID_EX, host.rdp?.username || host.username || undefined), host.host)
    sock = n.sock
    const { confirm } = n
    const latencyMs = Date.now() - started
    if (confirm.kind === 'failure') return { state: 'refused', message: negotiationFailureLabel(confirm.code), route: label, latencyMs, checkedAt: Date.now() }
    if (!n.tls) return { state: 'ok', message: 'RDP 허용됨 — 표준 RDP 보안만 지원하는 서버라 내장 연결은 쓸 수 없습니다. 외부 앱으로 여세요', security: protocolLabel(0), route: label, latencyMs, checkedAt: Date.now() }
    const protocol = confirm.kind === 'selected' ? confirm.protocol : 0
    const [cert] = certChain(n.tls)
    return { state: 'ok', message: 'RDP 허용됨', security: protocolLabel(protocol) + (n.legacy ? ' (TLS 1.2 RSA)' : ''), route: label, latencyMs, fingerprint: cert ? certFingerprint(cert) : undefined, checkedAt: Date.now() }
  } catch (e) {
    return { ...describeError(e as Error), route: label, checkedAt: Date.now() }
  } finally {
    try { sock?.destroy() } catch { /* */ }
    if (!given) route?.close()
  }
}
