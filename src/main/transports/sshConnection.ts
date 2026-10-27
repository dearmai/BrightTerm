import type { Client, ConnectConfig } from 'ssh2'

/** Keep an error listener for the entire client lifetime, including failed handshakes. */
export function connectSshClient(client: Client, config: ConnectConfig): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    const cleanup = (): void => {
      client.removeListener('ready', onReady)
      client.removeListener('close', onClose)
    }
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
      // ssh2 can emit another error as the failed socket closes. Keep onError attached.
      client.destroy()
    }
    const onError = (error: Error): void => { fail(error) }
    const onClose = (): void => { fail(new Error('SSH 연결이 준비되기 전에 종료되었습니다')) }
    const onReady = (): void => {
      settled = true
      cleanup()
      resolve()
    }
    client.on('error', onError)
    client.once('ready', onReady)
    client.once('close', onClose)
    try { client.connect(config) } catch (error) { fail(error as Error) }
  })
}
