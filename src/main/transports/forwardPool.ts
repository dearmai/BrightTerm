import { createServer, connect, type Server } from 'net'
import type { Duplex } from 'stream'
import { probeForwardDestination } from './forwardHealth'
import type { Client } from 'ssh2'
import type { Host, PortForward, SessionForward } from '@shared/types'

const pools = new Map<string, ForwardPool>()
type Entry = { config: PortForward; info: SessionForward; server?: Server; streams: Set<Duplex>; retired: boolean; settled?: Promise<void>; checking?: boolean; nextCheckAt?: number; cancelProbe?: () => void }
const signature = (f: PortForward): string => JSON.stringify([f.type, f.bindHost || '127.0.0.1', f.bindPort, f.destHost, f.destPort])

/** 같은 SSH 대상의 포워딩을 공유한다. 마지막 이용 세션이 닫힐 때 해제한다. */
export class ForwardPool {
  private entries: Entry[] = []
  private listeners = new Set<(items: SessionForward[]) => void>()
  private timer: NodeJS.Timeout
  private dirty = false
  private stopped = false
  private queue = Promise.resolve()

  static acquire(host: Host, client: Client, listener: (items: SessionForward[]) => void, onUnused: () => void): { pool: ForwardPool; release: () => void } {
    const key = JSON.stringify([host.host.toLowerCase(), host.port, host.username, host.jumpHostId, host.jump, host.proxy])
    let pool = pools.get(key)
    if (!pool) {
      pool = new ForwardPool(key, client, onUnused)
      pools.set(key, pool)
    }
    pool.listeners.add(listener)
    const rules = host.forwards.map((f) => ({ ...f }))
    pool.queue = pool.queue.then(() => pool!.reconcile(rules)).catch(() => undefined)
    listener(pool.snapshot())
    let released = false
    return { pool, release: () => {
      if (released) return
      released = true
      pool!.listeners.delete(listener)
      if (!pool!.listeners.size) pool!.stop()
    } }
  }

  private constructor(private key: string, readonly client: Client, private onUnused: () => void) {
    this.timer = setInterval(() => {
      for (const entry of this.entries) this.checkHealth(entry)
      if (this.dirty) this.publish()
    }, 500)
    this.timer.unref()
    client.on('tcp connection', (info, accept, reject) => {
      const entry = this.entries.find((e) => !e.retired && e.info.state === 'active' && e.info.type === 'R' && e.info.bindPort === info.destPort && (e.info.bindHost === info.destIP || ['0.0.0.0', '::', 'localhost', ''].includes(e.info.bindHost)))
      if (!entry) return reject()
      const channel = accept()
      const socket = connect(entry.info.destPort, entry.info.destHost)
      entry.streams.add(channel)
      entry.streams.add(socket)
      channel.once('close', () => entry.streams.delete(channel))
      socket.once('close', () => entry.streams.delete(socket))
      socket.once('connect', () => {
        if (entry.retired || channel.destroyed) return socket.destroy()
        this.bridge(entry, channel, socket)
      })
      socket.on('error', () => channel.destroy())
      channel.once('close', () => socket.destroy())
      channel.on('error', () => socket.destroy())
    })
    client.once('close', () => this.stop('포워딩 SSH 연결이 종료되었습니다'))
  }

  private checkHealth(entry: Entry): void {
    if (this.stopped || entry.retired || entry.info.state !== 'active' || entry.checking || Date.now() < (entry.nextCheckAt ?? 0)) return
    if (entry.server && !entry.server.listening) {
      entry.info = { ...entry.info, health: 'unhealthy', healthError: '로컬 리스너가 열려 있지 않습니다', checkedAt: Date.now() }
      entry.nextCheckAt = Date.now() + 15000
      this.dirty = true
      return
    }
    entry.checking = true
    if (!entry.info.health) entry.info = { ...entry.info, health: 'checking' }
    entry.cancelProbe = probeForwardDestination(this.client, entry.info, (error) => {
      entry.checking = false
      entry.cancelProbe = undefined
      if (entry.retired || this.stopped) return
      entry.info = { ...entry.info, health: error ? 'unhealthy' : 'healthy', healthError: error?.message, checkedAt: Date.now() }
      entry.nextCheckAt = Date.now() + 15000
      this.publish()
    })
  }

  retains(client: Client): boolean { return this.client === client && !this.stopped }
  private snapshot(): SessionForward[] { return this.entries.map((e) => ({ ...e.info })) }
  private publish(): void {
    this.dirty = false
    const items = this.snapshot()
    for (const listener of this.listeners) listener(items)
  }

  private async reconcile(rules: PortForward[]): Promise<void> {
    if (this.stopped) return
    // 변경되지 않은 활성·준비 중 규칙은 유지한다. 실패한 규칙은 다시 시도한다.
    const keep = this.entries.filter((e) => e.info.state !== 'error' && rules.some((f) => signature(f) === signature(e.config)))
    for (const entry of this.entries.filter((e) => !keep.includes(e))) await this.retire(entry)
    if (this.stopped) return
    this.entries = keep
    for (const rule of rules) {
      if (this.entries.some((e) => signature(e.config) === signature(rule))) continue
      const entry: Entry = { config: rule, info: { ...rule, state: 'pending', connections: 0, totalConnections: 0, sentBytes: 0, receivedBytes: 0 }, streams: new Set(), retired: false }
      this.entries.push(entry)
      this.start(entry)
    }
    this.publish()
  }

  private start(entry: Entry): void {
    const f = entry.info
    let settle!: () => void
    entry.settled = new Promise<void>((resolve) => { settle = resolve })
    const disconnected = (): void => ready(new Error('SSH 연결이 종료되었습니다'))
    const ready = (error?: Error | null, port?: number): void => {
      this.client.removeListener('close', disconnected)
      settle()
      entry.info = { ...entry.info, state: error ? 'error' : 'active', error: error?.message, bindPort: port || f.bindPort }
      if (!entry.retired && !this.stopped) {
        this.publish()
        if (!error) this.checkHealth(entry)
      }
    }
    this.client.once('close', disconnected)
    try {
      if (f.type === 'L') {
        const server = createServer((socket) => {
          entry.streams.add(socket)
          socket.once('close', () => entry.streams.delete(socket))
          socket.on('error', () => socket.destroy())
          this.client.forwardOut(socket.remoteAddress || '127.0.0.1', socket.remotePort || 0, f.destHost, f.destPort, (error, channel) => {
            if (error) return socket.destroy()
            if (entry.retired || socket.destroyed) { channel.destroy(); socket.destroy(); return }
            this.bridge(entry, socket, channel)
          })
        })
        entry.server = server
        server.on('error', ready)
        server.listen(f.bindPort, f.bindHost || '127.0.0.1', () => {
          const address = server.address()
          ready(null, address && typeof address !== 'string' ? address.port : f.bindPort)
        })
      } else this.client.forwardIn(f.bindHost || '127.0.0.1', f.bindPort, ready)
    } catch (error) { ready(error as Error) }
  }

  private bridge(entry: Entry, incoming: Duplex, destination: Duplex): void {
    entry.info.connections = (entry.info.connections ?? 0) + 1
    entry.info.totalConnections = (entry.info.totalConnections ?? 0) + 1
    this.dirty = true
    entry.streams.add(incoming)
    entry.streams.add(destination)
    let ended = false
    const close = (): void => {
      if (ended) return
      ended = true
      entry.info.connections = Math.max(0, (entry.info.connections ?? 0) - 1)
      this.dirty = true
      entry.streams.delete(incoming)
      entry.streams.delete(destination)
      incoming.destroy()
      destination.destroy()
    }
    incoming.on('data', (data: Buffer) => { entry.info.sentBytes = (entry.info.sentBytes ?? 0) + data.length; this.dirty = true })
    destination.on('data', (data: Buffer) => { entry.info.receivedBytes = (entry.info.receivedBytes ?? 0) + data.length; this.dirty = true })
    incoming.once('close', close)
    destination.once('close', close)
    incoming.once('error', close)
    destination.once('error', close)
    incoming.pipe(destination).pipe(incoming)
  }

  private async retire(entry: Entry): Promise<void> {
    entry.retired = true
    entry.cancelProbe?.()
    await entry.settled
    for (const stream of entry.streams) stream.destroy()
    if (entry.server) {
      await new Promise<void>((resolve) => { entry.server!.close(() => resolve()) })
    } else if (entry.info.type === 'R' && entry.info.state === 'active') {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2000)
        try { this.client.unforwardIn(entry.info.bindHost || '127.0.0.1', entry.info.bindPort, () => { clearTimeout(timer); resolve() }) }
        catch { clearTimeout(timer); resolve() }
      })
    }
  }

  private stop(error?: string): void {
    if (this.stopped) return
    this.stopped = true
    if (pools.get(this.key) === this) pools.delete(this.key)
    clearInterval(this.timer)
    for (const entry of this.entries) {
      void this.retire(entry)
      entry.info = { ...entry.info, state: 'error', error: error || '포워딩이 종료되었습니다', connections: 0 }
    }
    if (error) this.publish()
    this.onUnused()
  }
}
