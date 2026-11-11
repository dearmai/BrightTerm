import { connect } from 'net'
import type { Duplex } from 'stream'
import type { Client } from 'ssh2'
import type { PortForward } from '@shared/types'

/** TCP 연결만 열었다 닫는다. 서비스 인증이나 쿼리, 모니터링 통계에는 포함하지 않는다. */
export function probeForwardDestination(client: Client, forward: PortForward, done: (error?: Error) => void, timeoutMs = 5000): () => void {
  let finished = false
  let stream: Duplex | undefined
  const finish = (error?: Error, cancelled = false): void => {
    if (finished) return
    finished = true
    clearTimeout(timer)
    stream?.destroy()
    if (!cancelled) done(error)
  }
  const timer = setTimeout(() => finish(new Error('목적지 TCP 연결 시간 초과 (5초)')), timeoutMs)
  timer.unref()
  try {
    if (forward.type === 'L') {
      client.forwardOut('127.0.0.1', 0, forward.destHost, forward.destPort, (error, channel) => {
        if (finished) { channel?.destroy(); return }
        stream = channel
        channel?.on('error', () => {})
        finish(error || undefined)
      })
    } else {
      const socket = connect(forward.destPort, forward.destHost)
      stream = socket
      socket.once('connect', () => finish())
      socket.once('error', (error) => finish(error))
    }
  } catch (error) { finish(error as Error) }
  return () => finish(undefined, true)
}
