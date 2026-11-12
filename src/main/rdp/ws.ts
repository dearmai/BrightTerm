// 127.0.0.1 전용 최소 WebSocket 서버 쪽 연결 (RFC 6455) — 내장 RDP 창(IronRDP)과 메인 프로세스 사이의 바이너리 통로.
// 외부 패키지 없이 필요한 만큼만: 핸드셰이크, 마스킹된 클라이언트 프레임, 조각 모음, ping/pong, close.
import { createHash } from 'crypto'
import { EventEmitter } from 'events'
import type { IncomingMessage } from 'http'
import type { Duplex } from 'stream'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
/** 한 메시지 최대 크기 — RDP 는 작은 조각으로 오지만 잘못된 길이로 메모리를 다 쓰지 않게 */
const MAX_MESSAGE = 16 * 1024 * 1024

export function acceptKey(key: string): string {
  return createHash('sha1').update(key + GUID).digest('base64')
}

/** 업그레이드 요청을 받아 101 응답을 보낸다. 올바른 요청이 아니면 400 으로 닫고 null */
export function acceptUpgrade(req: IncomingMessage, sock: Duplex, head: Buffer): WsConn | null {
  const key = req.headers['sec-websocket-key']
  if (req.headers.upgrade?.toLowerCase() !== 'websocket' || typeof key !== 'string' || req.headers['sec-websocket-version'] !== '13') {
    sock.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
    return null
  }
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`)
  const ws = new WsConn(sock)
  if (head.length) ws.feed(head)
  return ws
}

/** 프레임 하나 — 서버가 보내는 프레임은 마스킹하지 않는다 */
export function encodeFrame(opcode: number, payload: Uint8Array, mask?: Uint8Array): Buffer {
  const n = payload.length
  const head: number[] = [0x80 | opcode]
  const m = mask ? 0x80 : 0
  if (n < 126) head.push(m | n)
  else if (n < 65536) head.push(m | 126, n >> 8, n & 0xff)
  else {
    head.push(m | 127, 0, 0, 0, 0)
    head.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff)
  }
  if (mask) head.push(...mask)
  const out = Buffer.alloc(head.length + n)
  out.set(head, 0)
  out.set(payload, head.length)
  if (mask) for (let i = 0; i < n; i++) out[head.length + i] ^= mask[i & 3]
  return out
}

/**
 * 이벤트: message(Buffer) — 바이너리·텍스트 메시지 하나, close() — 어느 쪽이든 닫힘
 */
export class WsConn extends EventEmitter {
  private buf: Buffer = Buffer.alloc(0)
  private parts: Buffer[] = []
  private partsLen = 0
  closed = false

  private sock: Duplex

  constructor(sock: Duplex) {
    super()
    this.sock = sock
    sock.on('data', (d: Buffer) => this.feed(d))
    sock.on('close', () => this.finish())
    sock.on('error', () => this.finish())
  }

  feed(d: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d
    try {
      while (this.parse()) { /* 다음 프레임 */ }
    } catch {
      this.close(1002)
    }
  }

  /** 프레임 하나를 처리했으면 true */
  private parse(): boolean {
    const b = this.buf
    if (b.length < 2) return false
    const fin = (b[0] & 0x80) !== 0
    const opcode = b[0] & 0x0f
    const masked = (b[1] & 0x80) !== 0
    let len = b[1] & 0x7f
    let off = 2
    if (len === 126) {
      if (b.length < 4) return false
      len = b.readUInt16BE(2)
      off = 4
    } else if (len === 127) {
      if (b.length < 10) return false
      if (b.readUInt32BE(2) !== 0) throw new Error('too big')
      len = b.readUInt32BE(6)
      off = 10
    }
    if (!masked) throw new Error('client frames must be masked')
    if (len > MAX_MESSAGE) throw new Error('too big')
    if (b.length < off + 4 + len) return false
    const mask = b.subarray(off, off + 4)
    const payload = Buffer.from(b.subarray(off + 4, off + 4 + len))
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3]
    this.buf = b.subarray(off + 4 + len)

    if (opcode === 0x8) { this.close(1000); return false }
    if (opcode === 0x9) { this.write(0xa, payload); return true }
    if (opcode === 0xa) return true
    if (opcode !== 0x0 && opcode !== 0x1 && opcode !== 0x2) throw new Error('bad opcode')
    this.parts.push(payload)
    this.partsLen += payload.length
    if (this.partsLen > MAX_MESSAGE) throw new Error('too big')
    if (fin) {
      const msg = this.parts.length === 1 ? this.parts[0] : Buffer.concat(this.parts)
      this.parts = []
      this.partsLen = 0
      this.emit('message', msg)
    }
    return true
  }

  private write(opcode: number, payload: Uint8Array): void {
    if (this.closed) return
    this.sock.write(encodeFrame(opcode, payload))
  }

  send(data: Uint8Array): void {
    this.write(0x2, data)
  }

  close(code = 1000): void {
    if (this.closed) return
    this.write(0x8, Buffer.from([code >> 8, code & 0xff]))
    this.finish()
    this.sock.end()
  }

  private finish(): void {
    if (this.closed) return
    this.closed = true
    this.emit('close')
  }

  destroy(): void {
    this.finish()
    this.sock.destroy()
  }
}
