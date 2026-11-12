// 내장 RDP 창의 IronRDP(WASM) 는 TCP 를 직접 열 수 없어 WebSocket 으로 RDCleanPath 프록시에 붙는다.
// 이 프록시가 서버 쪽 TCP·X.224·TLS 를 맡고 서버 인증서 체인을 돌려준 뒤, 평문 RDP(TLS 안쪽)를 그대로 잇는다.
// 127.0.0.1 에만 열고, 창마다 무작위 토큰(경로 + proxy_auth)으로 구분한다.
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import type { Duplex } from 'stream'
import { acceptUpgrade, type WsConn } from './ws'
import { certChain, certFingerprint, describeError, negotiate, type RdpRoute } from './route'
import { RDCLEANPATH_VERSION, RDCP_GENERAL_ERROR, RDCP_NEGOTIATION_ERROR, RDCP_TARGET_UNREACHABLE, RDCP_TLS_FAILED, ClientStreamPatcher, protocolLabel, decodeRDCleanPath, encodeRDCleanPath, rdcleanpathLength, type ClientPatch } from '@shared/rdp'

export interface GatewayTarget {
  route: RdpRoute
  /** 신뢰한 인증서 지문 — 다르면 접속하지 않는다 */
  fingerprint?: string
  servername: string
  onLog?: (msg: string) => void
  /** 접속마다 다시 읽는 화질·소리 값 — 클라이언트가 보내는 Connect-Initial·Client Info 를 이 값으로 고친다 */
  patch?: () => ClientPatch
}

const targets = new Map<string, GatewayTarget>()
const live = new Map<string, Set<WsConn>>()
let server: Server | null = null
let port = 0

export async function gatewayPort(): Promise<number> {
  if (server) return port
  const s = createServer((_req, res) => { res.writeHead(404); res.end() })
  s.on('upgrade', (req, sock: Duplex, head: Buffer) => {
    const m = /^\/rdp\/([A-Za-z0-9_-]{16,})$/.exec(req.url ?? '')
    const t = m && targets.get(m[1])
    if (!m || !t) { sock.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); return }
    const ws = acceptUpgrade(req, sock, head)
    if (ws) handle(m[1], t, ws)
  })
  await new Promise<void>((resolve, reject) => {
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => resolve())
  })
  server = s
  port = (s.address() as AddressInfo).port
  return port
}

export function registerTarget(token: string, t: GatewayTarget): void {
  targets.set(token, t)
}

export function unregisterTarget(token: string): void {
  targets.delete(token)
  for (const ws of live.get(token) ?? []) ws.destroy()
  live.delete(token)
}

export function closeGateway(): void {
  for (const t of [...targets.keys()]) unregisterTarget(t)
  server?.close()
  server = null
}

function sendError(ws: WsConn, errorCode: number, extra: { tlsAlertCode?: number; wsaLastError?: number; x224?: Uint8Array } = {}): void {
  const { x224, ...rest } = extra
  ws.send(encodeRDCleanPath({ version: RDCLEANPATH_VERSION, error: { errorCode, ...rest }, x224 }))
  ws.close()
}

/** Windows 소켓 오류 번호 — IronRDP 가 이 값으로 원인을 보여 준다 */
const WSA: Record<string, number> = { ECONNREFUSED: 10061, ETIMEDOUT: 10060, EHOSTUNREACH: 10065, ENETUNREACH: 10051, ECONNRESET: 10054, ENOTFOUND: 11001 }

function handle(token: string, t: GatewayTarget, ws: WsConn): void {
  const set = live.get(token) ?? new Set<WsConn>()
  set.add(ws)
  live.set(token, set)
  let pending = Buffer.alloc(0)
  let upstream: Duplex | null = null
  let started = false
  const queued: Buffer[] = []
  const log = t.onLog ?? (() => {})
  const patcher = t.patch ? new ClientStreamPatcher(t.patch(), log) : null
  // 접속이 어디서 멈추는지 보이게 — 주고받은 양
  let sent = 0
  let recv = 0
  // 테스트용: 15비트 Connect-Initial 뒤로 멈추는 Windows 를 흉내 낸다
  const stall15 = process.env.BT_TEST_RDP_STALL_DEPTH === '15' && t.patch?.().colorDepth === 15
  let stalled = false
  const toServer = (up: Duplex, msg: Buffer): void => {
    if (stalled) return
    if (!sent) log('인증(NLA·CredSSP) 시작')
    sent += msg.length
    if (!patcher || patcher.done) { up.write(msg); return }
    const out = patcher.push(msg)
    if (out.length) up.write(out)
    if (stall15 && patcher.coreSeen) stalled = true
  }

  ws.on('close', () => {
    set.delete(ws)
    if (upstream && !upstream.destroyed) log(`클라이언트가 연결을 닫았습니다 (보냄 ${sent} · 받음 ${recv} 바이트)`)
    upstream?.destroy()
  })
  ws.on('message', (msg: Buffer) => {
    if (upstream) { toServer(upstream, msg); return }
    if (started) { queued.push(msg); return }
    pending = Buffer.concat([pending, msg])
    let len: number
    try { len = rdcleanpathLength(pending) } catch { return ws.close(1002) }
    if (!len || pending.length < len) return
    started = true
    const rest = pending.subarray(len)
    if (rest.length) queued.push(Buffer.from(rest))
    void begin(pending.subarray(0, len))
  })

  const begin = async (raw: Uint8Array): Promise<void> => {
    let sock: Duplex | undefined
    try {
      const req = decodeRDCleanPath(raw)
      if (req.proxyAuth !== token || !req.x224) return sendError(ws, RDCP_GENERAL_ERROR, {})
      log(`서버에 연결 중 — ${t.route.label}`)
      let n
      try {
        n = await negotiate(t.route, req.x224, t.servername, (why) => log(`TLS 다시 시도 (TLS 1.2 RSA 키 교환): ${why}`))
      } catch (e) {
        const code = (e as { code?: string }).code ?? ''
        if (/SSL|TLS|ERR_SSL|키 용도/i.test(`${code} ${(e as Error).message}`)) {
          log(`TLS 실패: ${(e as Error).message}`)
          return sendError(ws, RDCP_TLS_FAILED, { tlsAlertCode: 40 })
        }
        log(`연결 실패: ${describeError(e as Error).message}`)
        return sendError(ws, RDCP_TARGET_UNREACHABLE, WSA[code] ? { wsaLastError: WSA[code] } : {})
      }
      sock = n.sock
      const { x224, confirm } = n
      if (ws.closed) { sock.destroy(); return }
      if (confirm.kind === 'failure') {
        sock.destroy()
        return sendError(ws, RDCP_NEGOTIATION_ERROR, { x224 })
      }
      const up: Duplex = sock
      let chain: Buffer[] = []
      if (n.tls) {
        chain = certChain(n.tls)
        const fp = chain[0] ? certFingerprint(chain[0]) : ''
        if (t.fingerprint && fp !== t.fingerprint) {
          log(`서버 인증서가 확인한 것과 다릅니다 (${fp})`)
          n.tls.destroy()
          return sendError(ws, RDCP_TLS_FAILED, { tlsAlertCode: 42 })
        }
      }
      if (ws.closed) { up.destroy(); return }
      log(`협상 완료 — ${confirm.kind === 'selected' ? protocolLabel(confirm.protocol) : '표준 RDP'}${n.tls ? ` · ${n.tls.getProtocol() ?? 'TLS'} ${n.tls.getCipher()?.name ?? ''}` : ''}`)
      ws.send(encodeRDCleanPath({ version: RDCLEANPATH_VERSION, serverAddr: t.route.target, x224, serverCertChain: chain }))
      upstream = up
      let firstData = true
      up.on('data', (d: Buffer) => {
        recv += d.length
        if (firstData && sent) { firstData = false; log('서버 응답 받는 중') }
        ws.send(d)
      })
      up.on('close', () => { if (!ws.closed) log(`서버가 연결을 닫았습니다 (보냄 ${sent} · 받음 ${recv} 바이트)`); ws.close() })
      up.on('error', (e) => { log(`서버 연결 오류: ${e.message}`); ws.close() })
      up.resume()
      for (const q of queued.splice(0)) toServer(up, q)
    } catch (e) {
      log(`프록시 오류: ${(e as Error).message}`)
      sock?.destroy()
      if (!ws.closed) sendError(ws, RDCP_GENERAL_ERROR, {})
    }
  }
}
