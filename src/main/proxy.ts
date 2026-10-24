import { Socket, connect, isIP, isIPv4, isIPv6 } from 'net'
import { connect as tlsConnect } from 'tls'
import type { ProxyConfig } from '@shared/types'
import { vault } from './vault'

/**
 * 프록시를 거쳐 host:port 로 이어진 TCP 소켓을 연다 — ssh2 의 sock, 텔넷 소켓으로 그대로 쓴다.
 * HTTP·HTTPS CONNECT, SOCKS5(사용자 이름·비밀번호 인증), SOCKS4/4a. 인증은 모두 선택. 주소 이름 풀기는 프록시가 한다(SOCKS4 제외).
 * 비밀번호는 볼트(credentialId)에 있다.
 */
export async function proxyConnect(p: ProxyConfig, host: string, port: number, timeoutMs = 20000): Promise<Socket> {
  const password = proxyPassword(p)
  const sock = await new Promise<Socket>((resolve, reject) => {
    // HTTPS 프록시: 프록시까지 TLS 로 감싸고 그 안에서 CONNECT. insecure 면 인증서를 확인하지 않는다(사내 자체 서명 등)
    const s = p.type === 'https'
      ? tlsConnect({ host: p.host, port: p.port, servername: isIP(p.host) ? undefined : p.host, rejectUnauthorized: !p.insecure, ALPNProtocols: ['http/1.1'] })
      : connect({ host: p.host, port: p.port })
    s.setTimeout(timeoutMs, () => s.destroy(new Error(`프록시 ${p.host}:${p.port} 응답 시간 초과`)))
    s.once(p.type === 'https' ? 'secureConnect' : 'connect', () => resolve(s))
    s.once('error', (e) => reject(new Error(`프록시 ${p.host}:${p.port} 에 연결할 수 없습니다: ${tlsHint(e)}`)))
  })
  try {
    const r = new Reader(sock)
    if (p.type === 'http' || p.type === 'https') await httpConnect(sock, r, host, port, p.username, password)
    else if (p.type === 'socks4') await socks4(sock, r, host, port, p.username)
    else await socks5(sock, r, host, port, p.username, password)
    r.release()
    sock.setTimeout(0)
    return sock
  } catch (e) {
    sock.destroy()
    throw e
  }
}

const TYPE_LABEL: Record<ProxyConfig['type'], string> = { http: 'HTTP', https: 'HTTPS', socks5: 'SOCKS5', socks4: 'SOCKS4' }

/** 인증서 문제면 검증 건너뛰기 옵션을 알려 준다 */
function tlsHint(e: Error & { code?: string }): string {
  const cert = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS_CERT_ALTNAME/i.test(e.code ?? '') || /certificate/i.test(e.message)
  return cert ? `프록시 인증서를 확인할 수 없습니다 (${e.code ?? e.message}). 사내 자체 서명 인증서라면 '인증서 확인 건너뛰기'를 켜세요` : e.message
}

/** 터미널 안내용 — 예: SOCKS5 127.0.0.1:1080 */
export const proxyLabel = (p: ProxyConfig): string => `${TYPE_LABEL[p.type]} ${hostPort(p.host, p.port)}`

function proxyPassword(p: ProxyConfig): string | undefined {
  if (!p.credentialId) return undefined
  try {
    return vault.get(p.credentialId)?.password
  } catch {
    return undefined
  }
}

/** 핸드셰이크 동안만 소켓 데이터를 모아 두고, 끝나면 남은 바이트를 소켓에 되돌린다 */
class Reader {
  private buf = Buffer.alloc(0)
  private wait: (() => void) | null = null
  private err: Error | null = null
  private onData = (d: Buffer): void => { this.buf = Buffer.concat([this.buf, d]); this.wake() }
  private onEnd = (): void => { this.err ??= new Error('프록시가 연결을 끊었습니다'); this.wake() }
  private onError = (e: Error): void => { this.err ??= e; this.wake() }

  constructor(private sock: Socket) {
    sock.on('data', this.onData)
    sock.on('end', this.onEnd)
    sock.on('close', this.onEnd)
    sock.on('error', this.onError)
  }

  private wake(): void {
    const w = this.wait
    this.wait = null
    w?.()
  }

  private async more(): Promise<void> {
    if (this.err) throw this.err
    await new Promise<void>((r) => (this.wait = r))
    if (this.err) throw this.err
  }

  async bytes(n: number): Promise<Buffer> {
    while (this.buf.length < n) await this.more()
    const out = this.buf.subarray(0, n)
    this.buf = this.buf.subarray(n)
    return out
  }

  /** 빈 줄(\r\n\r\n)까지 — HTTP 응답 머리 */
  async head(limit = 16384): Promise<string> {
    for (;;) {
      const i = this.buf.indexOf('\r\n\r\n')
      if (i >= 0) {
        const out = this.buf.subarray(0, i).toString('latin1')
        this.buf = this.buf.subarray(i + 4)
        return out
      }
      if (this.buf.length > limit) throw new Error('프록시 응답이 너무 깁니다')
      await this.more()
    }
  }

  release(): void {
    this.sock.off('data', this.onData)
    this.sock.off('end', this.onEnd)
    this.sock.off('close', this.onEnd)
    this.sock.off('error', this.onError)
    this.sock.pause()
    if (this.buf.length) this.sock.unshift(this.buf)
  }
}

const hostPort = (host: string, port: number): string => (isIPv6(host) ? `[${host}]:${port}` : `${host}:${port}`)

async function httpConnect(sock: Socket, r: Reader, host: string, port: number, user?: string, pass?: string): Promise<void> {
  const target = hostPort(host, port)
  const auth = user ? `Proxy-Authorization: Basic ${Buffer.from(`${user}:${pass ?? ''}`).toString('base64')}\r\n` : ''
  sock.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth}\r\n`)
  const head = await r.head()
  const m = head.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})\s*(.*)/)
  if (!m) throw new Error('HTTP 프록시가 아닌 것 같습니다 (응답을 이해할 수 없음)')
  const code = +m[1]
  if (code === 407) throw new Error(user ? 'HTTP 프록시 인증 실패 (사용자 이름·비밀번호 확인)' : 'HTTP 프록시가 인증을 요구합니다 (사용자 이름·비밀번호 입력)')
  if (code < 200 || code > 299) throw new Error(`HTTP 프록시가 ${target} 연결을 거부했습니다 (${code} ${m[2].trim()})`)
}

const SOCKS5_ERR: Record<number, string> = {
  1: '프록시 서버 오류',
  2: '프록시 규칙상 허용되지 않는 연결',
  3: '네트워크에 도달할 수 없음',
  4: '호스트에 도달할 수 없음',
  5: '서버가 접속을 거부함',
  6: 'TTL 만료',
  7: '지원하지 않는 명령',
  8: '지원하지 않는 주소 형식'
}

async function socks5(sock: Socket, r: Reader, host: string, port: number, user?: string, pass?: string): Promise<void> {
  sock.write(Buffer.from(user ? [5, 2, 0, 2] : [5, 1, 0]))
  const [ver, method] = await r.bytes(2)
  if (ver !== 5) throw new Error('SOCKS5 프록시가 아닌 것 같습니다')
  if (method === 0xff) throw new Error(user ? 'SOCKS5 프록시가 이 인증 방식을 받지 않습니다' : 'SOCKS5 프록시가 인증을 요구합니다 (사용자 이름·비밀번호 입력)')
  if (method === 2) {
    if (!user) throw new Error('SOCKS5 프록시가 인증을 요구합니다 (사용자 이름·비밀번호 입력)')
    const u = Buffer.from(user)
    const p = Buffer.from(pass ?? '')
    sock.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([p.length]), p]))
    const [, status] = await r.bytes(2)
    if (status !== 0) throw new Error('SOCKS5 프록시 인증 실패 (사용자 이름·비밀번호 확인)')
  }
  let addr: Buffer
  if (isIPv4(host)) addr = Buffer.from([1, ...host.split('.').map(Number)])
  else if (isIPv6(host)) addr = Buffer.concat([Buffer.from([4]), ipv6Bytes(host)])
  else {
    const h = Buffer.from(host)
    addr = Buffer.concat([Buffer.from([3, h.length]), h])
  }
  sock.write(Buffer.concat([Buffer.from([5, 1, 0]), addr, Buffer.from([port >> 8, port & 255])]))
  const [, rep, , atyp] = await r.bytes(4)
  if (rep !== 0) throw new Error(`SOCKS5 프록시: ${hostPort(host, port)} 연결 실패 (${SOCKS5_ERR[rep] ?? `코드 ${rep}`})`)
  const len = atyp === 1 ? 4 : atyp === 4 ? 16 : (await r.bytes(1))[0]
  await r.bytes(len + 2)
}

async function socks4(sock: Socket, r: Reader, host: string, port: number, user?: string): Promise<void> {
  // SOCKS4a: IP 가 아니면 0.0.0.1 을 보내고 뒤에 주소 이름을 붙인다 — 이름 풀기는 프록시가
  const ip = isIPv4(host) ? host.split('.').map(Number) : [0, 0, 0, 1]
  const id = Buffer.concat([Buffer.from(user ?? ''), Buffer.from([0])])
  const name = isIPv4(host) ? Buffer.alloc(0) : Buffer.concat([Buffer.from(host), Buffer.from([0])])
  if (isIPv6(host)) throw new Error('SOCKS4 프록시는 IPv6 주소를 쓸 수 없습니다')
  sock.write(Buffer.concat([Buffer.from([4, 1, port >> 8, port & 255, ...ip]), id, name]))
  const [, status] = await r.bytes(8)
  if (status !== 0x5a) throw new Error(`SOCKS4 프록시가 ${hostPort(host, port)} 연결을 거부했습니다 (코드 ${status})`)
}

function ipv6Bytes(ip: string): Buffer {
  const [head, tail] = ip.split('::')
  const parse = (s: string): number[] => (s ? s.split(':').flatMap((g) => (g.includes('.') ? [] : [parseInt(g, 16)])) : [])
  const h = parse(head)
  const t = tail !== undefined ? parse(tail) : []
  const groups = tail !== undefined ? [...h, ...Array(8 - h.length - t.length).fill(0), ...t] : h
  const b = Buffer.alloc(16)
  groups.forEach((g, i) => b.writeUInt16BE(g & 0xffff, i * 2))
  return b
}
