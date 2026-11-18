import { createHmac } from 'crypto'
import type { TotpMeta } from '@shared/types'

/** RFC 4648 Base32 — 공백·하이픈·= 패딩은 무시 */
export function base32Decode(s: string): Buffer {
  const n = s.replace(/[\s=-]/g, '').toUpperCase()
  if (!/^[A-Z2-7]+$/.test(n)) throw new Error('TOTP 비밀키는 Base32(A-Z, 2-7) 형식이어야 합니다')
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of n) {
    value = ((value << 5) | alphabet.indexOf(ch)) & 0xffff
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

/** RFC 6238 TOTP — key 는 디코딩한 비밀키 */
export function totpAt(key: Buffer, meta: Pick<TotpMeta, 'digits' | 'period' | 'algorithm'>, timeMs: number): string {
  const counter = Math.floor(timeMs / 1000 / meta.period)
  const msg = Buffer.alloc(8)
  msg.writeBigUInt64BE(BigInt(counter))
  const h = createHmac(meta.algorithm.toLowerCase(), key).update(msg).digest()
  const off = h[h.length - 1] & 0x0f
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3]
  return String(bin % 10 ** meta.digits).padStart(meta.digits, '0')
}

export function remainingSec(period: number, timeMs: number): number {
  return period - (Math.floor(timeMs / 1000) % period)
}
