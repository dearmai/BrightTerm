import { connect } from 'net'
import type { CredentialSecret, Host } from '@shared/types'
import { openClient, openRoute } from './transports/ssh'

export interface ConnTestResult {
  /** 접속(SSH 는 인증까지)에 걸린 시간 */
  ms: number
  detail: string
}

/** 이 PC 에서 바로 TCP 연결만 해 본다 */
function tcpProbe(host: string, port: number, timeoutMs = 10000): Promise<void> {
  return new Promise((res, rej) => {
    const s = connect({ host, port })
    const done = (err?: Error): void => {
      s.removeAllListeners()
      s.destroy()
      if (err) rej(err)
      else res()
    }
    s.setTimeout(timeoutMs, () => done(new Error(`${timeoutMs / 1000}초 안에 응답이 없습니다`)))
    s.once('connect', () => done())
    s.once('error', (e) => done(e))
  })
}

/**
 * 서버 편집 창의 연결 테스트 — 저장 전일 수 있는 설정 그대로 접속해 본다.
 * SSH 는 점프 호스트·프록시를 거쳐 인증까지 마친 뒤 바로 끊고, 텔넷은 TCP 연결만 확인한다.
 * secret: 편집 창에 입력했지만 아직 저장하지 않은 비밀번호·키
 */
export async function testConnection(host: Host, secret?: CredentialSecret): Promise<ConnTestResult> {
  if (!host.host) throw new Error('서버 주소를 먼저 입력하세요')
  const started = Date.now()
  if (host.protocol === 'ssh') {
    const { client, chain } = await openClient(host, { title: host.alias || host.host, cols: 80, rows: 24, secret })
    const ms = Date.now() - started
    client.end()
    for (const c of chain.reverse()) try { c.end() } catch { /* */ }
    const via = host.jump?.host || host.jumpHostId ? ' (점프 호스트 경유)' : host.proxy?.host ? ' (프록시 경유)' : ''
    return { ms, detail: `SSH 로그인 성공${via}` }
  }
  if (host.protocol === 'telnet') {
    const { sock, chain } = await openRoute(host, host.port, { title: host.alias || host.host, cols: 80, rows: 24 })
    try {
      if (sock) (sock as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.()
      else await tcpProbe(host.host, host.port)
    } finally {
      for (const c of chain.reverse()) try { c.end() } catch { /* */ }
    }
    return { ms: Date.now() - started, detail: `포트 ${host.port} 연결 성공` }
  }
  throw new Error('SSH·텔넷 서버만 연결 테스트를 할 수 있습니다')
}
