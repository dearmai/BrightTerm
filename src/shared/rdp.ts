// RDP 보조 — X.224 협상 PDU, RDCleanPath(IronRDP 웹 클라이언트 ↔ 프록시) DER, .rdp 파일.
// 메인·렌더러·테스트가 같이 쓴다. Node Buffer 를 쓰지 않고 Uint8Array 만 다룬다.
import type { RdpColorDepth, RdpExperience, Host, RdpOptions } from './types'

export const DEFAULT_RDP: RdpOptions = {
  mode: 'builtin',
  port: 3389,
  auth: 'host',
  clipboard: true,
  resolution: 'window',
  route: 'direct',
  openIn: 'tab'
}

export function rdpOptions(h: Pick<Host, 'rdp'>): RdpOptions {
  return { ...DEFAULT_RDP, ...h.rdp }
}

/** RDP 를 쓸 수 있는 서버 — OS 가 Windows 이고 주소가 있는 SSH·텔넷 서버 */
export function rdpCapable(h: Pick<Host, 'os' | 'protocol' | 'host'>): boolean {
  return h.os === 'windows' && (h.protocol === 'ssh' || h.protocol === 'telnet') && !!h.host
}

// ---------------------------------------------------------------- X.224 협상 (MS-RDPBCGR 2.2.1.1 / 2.2.1.2)

export const PROTOCOL_RDP = 0
export const PROTOCOL_SSL = 1
export const PROTOCOL_HYBRID = 2
export const PROTOCOL_HYBRID_EX = 8

/** TPKT + X.224 Connection Request + RDP_NEG_REQ. cookie 는 mstshash(로드밸런서용 사용자 이름) */
export function x224ConnectionRequest(requested = PROTOCOL_SSL | PROTOCOL_HYBRID | PROTOCOL_HYBRID_EX, cookie?: string): Uint8Array {
  const ck = cookie ? new TextEncoder().encode(`Cookie: mstshash=${cookie.replace(/[\r\n]/g, '').slice(0, 9)}\r\n`) : new Uint8Array(0)
  const neg = [0x01, 0x00, 0x08, 0x00, requested & 0xff, (requested >> 8) & 0xff, (requested >> 16) & 0xff, (requested >>> 24) & 0xff]
  const x224Len = 6 + ck.length + neg.length // LI 다음 바이트 수
  const total = 4 + 1 + x224Len
  const out = new Uint8Array(total)
  out.set([0x03, 0x00, total >> 8, total & 0xff, x224Len, 0xe0, 0, 0, 0, 0, 0], 0)
  out.set(ck, 11)
  out.set(neg, 11 + ck.length)
  return out
}

/** TPKT 하나의 전체 길이 — 아직 머리글(4바이트)이 다 오지 않았으면 0, TPKT 가 아니면 -1 */
export function tpktLength(b: Uint8Array): number {
  if (b.length < 4) return 0
  if (b[0] !== 0x03) return -1
  return (b[2] << 8) | b[3]
}

export type X224Confirm =
  | { kind: 'selected'; protocol: number }
  | { kind: 'failure'; code: number }
  /** 협상 데이터 없음 — 오래된 서버의 표준 RDP 보안 */
  | { kind: 'legacy' }

export function parseX224Confirm(b: Uint8Array): X224Confirm {
  const len = tpktLength(b)
  if (len < 11 || b.length < len) throw new Error('RDP 응답이 아닙니다 (TPKT)')
  if ((b[5] & 0xf0) !== 0xd0) throw new Error('RDP 응답이 아닙니다 (X.224 Connection Confirm)')
  if (len < 19) return { kind: 'legacy' }
  const t = b[11]
  const v = (b[15] | (b[16] << 8) | (b[17] << 16) | (b[18] << 24)) >>> 0
  if (t === 0x02) return { kind: 'selected', protocol: v }
  if (t === 0x03) return { kind: 'failure', code: v }
  throw new Error(`알 수 없는 RDP 협상 응답 (type ${t})`)
}

export function protocolLabel(p: number): string {
  if (p & PROTOCOL_HYBRID_EX) return 'NLA (CredSSP, Early User Auth)'
  if (p & PROTOCOL_HYBRID) return 'NLA (CredSSP)'
  if (p & PROTOCOL_SSL) return 'TLS'
  return '표준 RDP 보안 (암호화 약함)'
}

/** RDP_NEG_FAILURE failureCode */
export function negotiationFailureLabel(code: number): string {
  switch (code) {
    case 1: return '서버가 TLS 를 요구합니다 (SSL_REQUIRED_BY_SERVER)'
    case 2: return '서버가 TLS 를 허용하지 않습니다 — 표준 RDP 보안만 씁니다 (SSL_NOT_ALLOWED_BY_SERVER)'
    case 3: return '서버에 RDP 인증서가 없습니다 (SSL_CERT_NOT_ON_SERVER)'
    case 4: return '협상 플래그가 맞지 않습니다 (INCONSISTENT_FLAGS)'
    case 5: return '서버가 NLA(CredSSP) 를 요구합니다 (HYBRID_REQUIRED_BY_SERVER)'
    case 6: return '서버가 TLS 사용자 인증서를 요구합니다 (SSL_WITH_USER_AUTH_REQUIRED_BY_SERVER)'
    default: return `협상 실패 (코드 ${code})`
  }
}

// ---------------------------------------------------------------- DER (RDCleanPath 에 필요한 만큼)

interface Tlv { tag: number; value: Uint8Array; end: number }

/** offset 의 TLV 하나. 아직 다 오지 않았으면 null */
function readTlv(b: Uint8Array, off: number): Tlv | null {
  if (b.length < off + 2) return null
  const tag = b[off]
  if ((tag & 0x1f) === 0x1f) throw new Error('DER: 긴 태그는 지원하지 않습니다')
  let len = b[off + 1]
  let p = off + 2
  if (len & 0x80) {
    const n = len & 0x7f
    if (n === 0 || n > 4) throw new Error('DER: 길이 형식 오류')
    if (b.length < p + n) return null
    len = 0
    for (let i = 0; i < n; i++) len = len * 256 + b[p + i]
    p += n
  }
  if (b.length < p + len) return null
  return { tag, value: b.subarray(p, p + len), end: p + len }
}

function children(v: Uint8Array): Tlv[] {
  const out: Tlv[] = []
  let off = 0
  while (off < v.length) {
    const t = readTlv(v, off)
    if (!t) throw new Error('DER: 잘린 값')
    out.push(t)
    off = t.end
  }
  return out
}

function lenBytes(n: number): number[] {
  if (n < 0x80) return [n]
  const out: number[] = []
  while (n > 0) { out.unshift(n & 0xff); n = Math.floor(n / 256) }
  return [0x80 | out.length, ...out]
}

function tlv(tag: number, value: Uint8Array): Uint8Array {
  const head = [tag, ...lenBytes(value.length)]
  const out = new Uint8Array(head.length + value.length)
  out.set(head, 0)
  out.set(value, head.length)
  return out
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0))
  let off = 0
  for (const p of parts) { out.set(p, off); off += p.length }
  return out
}

function derInt(n: number): Uint8Array {
  const bytes: number[] = []
  let v = n
  do { bytes.unshift(v & 0xff); v = Math.floor(v / 256) } while (v > 0)
  if (bytes[0] & 0x80) bytes.unshift(0)
  return tlv(0x02, new Uint8Array(bytes))
}

function readInt(t: Tlv): number {
  if (t.tag !== 0x02) throw new Error('DER: INTEGER 가 아닙니다')
  let n = 0
  for (const x of t.value) n = n * 256 + x
  return n
}

/** [n] EXPLICIT */
const ctx = (n: number, inner: Uint8Array): Uint8Array => tlv(0xa0 | n, inner)
const utf8 = (s: string): Uint8Array => tlv(0x0c, new TextEncoder().encode(s))
const octets = (b: Uint8Array): Uint8Array => tlv(0x04, b)

// ---------------------------------------------------------------- RDCleanPath (IronRDP ironrdp-rdcleanpath)

export const RDCLEANPATH_VERSION = 3390
export const RDCP_GENERAL_ERROR = 1
export const RDCP_NEGOTIATION_ERROR = 2
export const RDCP_TARGET_UNREACHABLE = 103
export const RDCP_DNS_FAILED = 104
export const RDCP_TLS_FAILED = 105

export interface RDCleanPathErr { errorCode: number; httpStatusCode?: number; wsaLastError?: number; tlsAlertCode?: number }

export interface RDCleanPathPdu {
  version: number
  error?: RDCleanPathErr
  destination?: string
  proxyAuth?: string
  serverAuth?: string
  preconnectionBlob?: string
  x224?: Uint8Array
  serverCertChain?: Uint8Array[]
  serverAddr?: string
}

/** 버퍼 앞의 RDCleanPath PDU 전체 길이 — 아직 모자라면 0 */
export function rdcleanpathLength(b: Uint8Array): number {
  const t = readTlv(b, 0)
  if (!t) return 0
  if (t.tag !== 0x30) throw new Error('RDCleanPath 가 아닙니다')
  return t.end
}

export function decodeRDCleanPath(b: Uint8Array): RDCleanPathPdu {
  const top = readTlv(b, 0)
  if (!top || top.tag !== 0x30) throw new Error('RDCleanPath 가 아닙니다')
  const pdu: RDCleanPathPdu = { version: 0 }
  const str = (t: Tlv): string => {
    const [s] = children(t.value)
    if (s?.tag !== 0x0c) throw new Error('DER: UTF8String 가 아닙니다')
    return new TextDecoder().decode(s.value)
  }
  for (const f of children(top.value)) {
    if ((f.tag & 0xe0) !== 0xa0) throw new Error('RDCleanPath: 태그 형식 오류')
    const n = f.tag & 0x1f
    if (n === 0) pdu.version = readInt(children(f.value)[0])
    else if (n === 1) {
      const [seq] = children(f.value)
      const e: RDCleanPathErr = { errorCode: 0 }
      for (const x of children(seq.value)) {
        const v = readInt(children(x.value)[0])
        const k = x.tag & 0x1f
        if (k === 0) e.errorCode = v
        else if (k === 1) e.httpStatusCode = v
        else if (k === 2) e.wsaLastError = v
        else if (k === 3) e.tlsAlertCode = v
      }
      pdu.error = e
    } else if (n === 2) pdu.destination = str(f)
    else if (n === 3) pdu.proxyAuth = str(f)
    else if (n === 4) pdu.serverAuth = str(f)
    else if (n === 5) pdu.preconnectionBlob = str(f)
    else if (n === 6) pdu.x224 = children(f.value)[0].value.slice()
    else if (n === 7) pdu.serverCertChain = children(children(f.value)[0].value).map((c) => c.value.slice())
    else if (n === 9) pdu.serverAddr = str(f)
  }
  if (pdu.version !== RDCLEANPATH_VERSION) throw new Error(`RDCleanPath 버전이 다릅니다 (${pdu.version})`)
  return pdu
}

export function encodeRDCleanPath(p: RDCleanPathPdu): Uint8Array {
  const f: Uint8Array[] = [ctx(0, derInt(p.version))]
  if (p.error) {
    const e = p.error
    const inner = [ctx(0, derInt(e.errorCode))]
    if (e.httpStatusCode !== undefined) inner.push(ctx(1, derInt(e.httpStatusCode)))
    if (e.wsaLastError !== undefined) inner.push(ctx(2, derInt(e.wsaLastError)))
    if (e.tlsAlertCode !== undefined) inner.push(ctx(3, derInt(e.tlsAlertCode)))
    f.push(ctx(1, tlv(0x30, concat(inner))))
  }
  if (p.destination !== undefined) f.push(ctx(2, utf8(p.destination)))
  if (p.proxyAuth !== undefined) f.push(ctx(3, utf8(p.proxyAuth)))
  if (p.serverAuth !== undefined) f.push(ctx(4, utf8(p.serverAuth)))
  if (p.preconnectionBlob !== undefined) f.push(ctx(5, utf8(p.preconnectionBlob)))
  if (p.x224) f.push(ctx(6, octets(p.x224)))
  if (p.serverCertChain) f.push(ctx(7, tlv(0x30, concat(p.serverCertChain.map(octets)))))
  if (p.serverAddr !== undefined) f.push(ctx(9, utf8(p.serverAddr)))
  return tlv(0x30, concat(f))
}

// ---------------------------------------------------------------- 화질·소리 (접속할 때 정하는 값)

export const ALL_EXPERIENCE: RdpExperience = { wallpaper: true, themes: true, fontSmoothing: true, composition: true, windowDrag: true, animations: true, cursorShadow: true }

/** 화질 프리셋 — best: 모두 켬 / balanced: 배경·애니메이션·창 끌기 내용 끔 / fast: 16비트 + 효과 모두 끔 */
export const RDP_PRESETS: Record<'best' | 'balanced' | 'fast', { colorDepth: RdpColorDepth; experience: RdpExperience }> = {
  best: { colorDepth: 32, experience: ALL_EXPERIENCE },
  balanced: { colorDepth: 32, experience: { ...ALL_EXPERIENCE, wallpaper: false, animations: false, windowDrag: false, cursorShadow: false } },
  fast: { colorDepth: 16, experience: { wallpaper: false, themes: false, fontSmoothing: false, composition: false, windowDrag: false, animations: false, cursorShadow: false } }
}

export function rdpExperience(o: Pick<RdpOptions, 'experience'>): RdpExperience {
  return { ...ALL_EXPERIENCE, ...o.experience }
}

/** 지금 값이 어느 프리셋과 같은지 — 다르면 'custom' */
export function rdpPreset(o: Pick<RdpOptions, 'colorDepth' | 'experience'>): keyof typeof RDP_PRESETS | 'custom' {
  const e = rdpExperience(o)
  const depth = o.colorDepth ?? 32
  for (const [k, p] of Object.entries(RDP_PRESETS) as [keyof typeof RDP_PRESETS, (typeof RDP_PRESETS)['best']][]) {
    if (p.colorDepth === depth && (Object.keys(p.experience) as (keyof RdpExperience)[]).every((x) => p.experience[x] === e[x])) return k
  }
  return 'custom'
}

/** TS_EXTENDED_INFO_PACKET.performanceFlags ([MS-RDPBCGR] 2.2.1.11.1.1.1) */
export const PERF_DISABLE_WALLPAPER = 0x01
export const PERF_DISABLE_FULLWINDOWDRAG = 0x02
export const PERF_DISABLE_MENUANIMATIONS = 0x04
export const PERF_DISABLE_THEMING = 0x08
export const PERF_DISABLE_CURSOR_SHADOW = 0x20
export const PERF_ENABLE_FONT_SMOOTHING = 0x80
export const PERF_ENABLE_DESKTOP_COMPOSITION = 0x100

export function perfFlags(e: RdpExperience): number {
  return (e.wallpaper ? 0 : PERF_DISABLE_WALLPAPER) |
    (e.windowDrag ? 0 : PERF_DISABLE_FULLWINDOWDRAG) |
    (e.animations ? 0 : PERF_DISABLE_MENUANIMATIONS) |
    (e.themes ? 0 : PERF_DISABLE_THEMING) |
    (e.cursorShadow ? 0 : PERF_DISABLE_CURSOR_SHADOW) |
    (e.fontSmoothing ? PERF_ENABLE_FONT_SMOOTHING : 0) |
    (e.composition ? PERF_ENABLE_DESKTOP_COMPOSITION : 0)
}

/** TS_INFO_PACKET.flags 의 소리 비트 */
export const INFO_UNICODE = 0x10
export const INFO_REMOTECONSOLEAUDIO = 0x2000
export const INFO_NOAUDIOPLAYBACK = 0x00080000

/** 내장 연결이 서버에 보낼 소리 설정 — 이 PC 재생은 내장에서 지원하지 않아 끈다 */
export const builtinAudio = (o: Pick<RdpOptions, 'audio'>): 'remote' | 'off' => (o.audio === 'remote' ? 'remote' : 'off')

export interface ClientPatch {
  colorDepth: RdpColorDepth
  perf: number
  audio: 'local' | 'remote' | 'off'
}

export function clientPatchOf(o: RdpOptions): ClientPatch {
  return { colorDepth: o.colorDepth ?? 32, perf: perfFlags(rdpExperience(o)), audio: builtinAudio(o) }
}

const u16 = (b: Uint8Array, i: number): number => b[i] | (b[i + 1] << 8)
const u32 = (b: Uint8Array, i: number): number => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0
const put16 = (b: Uint8Array, i: number, v: number): void => { b[i] = v & 0xff; b[i + 1] = (v >> 8) & 0xff }
const put32 = (b: Uint8Array, i: number, v: number): void => { b[i] = v & 0xff; b[i + 1] = (v >>> 8) & 0xff; b[i + 2] = (v >>> 16) & 0xff; b[i + 3] = (v >>> 24) & 0xff }

/** X.224 Data TPKT 의 MCS 바이트가 시작하는 자리 — 03 00 len len | 02 f0 80 | MCS… */
function mcsStart(pdu: Uint8Array): number {
  if (pdu.length < 8 || pdu[0] !== 3 || pdu[4] !== 2 || pdu[5] !== 0xf0) return -1
  return 7
}

/**
 * MCS Connect-Initial 의 TS_UD_CS_CORE 에서 색 깊이를 바꾼다(길이는 그대로). 바꿨으면 true.
 * highColorDepth(+140) · supportedColorDepths(+142) · earlyCapabilityFlags(+144) 의 WANT_32BPP
 */
export function patchClientCore(pdu: Uint8Array, depth: RdpColorDepth): boolean {
  const m = mcsStart(pdu)
  if (m < 0 || pdu[m] !== 0x7f || pdu[m + 1] !== 0x65) return false
  for (let h = m + 2; h + 146 <= pdu.length; h++) {
    if (pdu[h] !== 0x01 || pdu[h + 1] !== 0xc0) continue
    const len = u16(pdu, h + 2)
    const version = u32(pdu, h + 4)
    if (len < 146 || h + len > pdu.length || (version >>> 16) !== 0x0008) continue
    const SUPPORT = { 24: 0x01, 16: 0x02, 15: 0x04, 32: 0x08 } as const
    if (depth === 32) {
      put16(pdu, h + 140, 24)
      put16(pdu, h + 142, u16(pdu, h + 142) | 0x0f)
      if (len >= 146) put16(pdu, h + 144, u16(pdu, h + 144) | 0x0002)
    } else {
      put16(pdu, h + 140, depth)
      put16(pdu, h + 142, SUPPORT[depth])
      if (len >= 146) put16(pdu, h + 144, u16(pdu, h + 144) & ~0x0002)
    }
    return true
  }
  return false
}

/**
 * Client Info PDU 의 소리 비트와 performanceFlags 를 바꾼다(길이는 그대로). 바꿨으면 true.
 * MCS Send Data Request → 보안 헤더(SEC_INFO_PKT) → TS_INFO_PACKET → TS_EXTENDED_INFO_PACKET
 */
export function patchClientInfo(pdu: Uint8Array, p: Pick<ClientPatch, 'perf' | 'audio'>): boolean {
  const m = mcsStart(pdu)
  // Send Data Request: 0x64 | initiator(2) | channelId(2) | priority(1) | PER 길이(1~2)
  if (m < 0 || (pdu[m] >> 2) !== 25) return false
  let i = m + 6
  if (i >= pdu.length) return false
  i += pdu[i] & 0x80 ? 2 : 1
  if (i + 4 > pdu.length || !(u16(pdu, i) & 0x0040)) return false
  const info = i + 4
  if (info + 18 > pdu.length) return false
  const flags = u32(pdu, info + 4)
  const nul = flags & INFO_UNICODE ? 2 : 1
  let j = info + 18
  for (let k = 0; k < 5; k++) j += u16(pdu, info + 8 + k * 2) + nul
  // 확장 정보: 주소족(2) | cbClientAddress(2) | 주소 | cbClientDir(2) | 경로 | 시간대(172) | 세션 id(4) | performanceFlags(4)
  if (j + 4 > pdu.length) return false
  j += 4 + u16(pdu, j + 2)
  if (j + 2 > pdu.length) return false
  j += 2 + u16(pdu, j)
  const perfAt = j + 172 + 4
  if (perfAt + 4 > pdu.length) return false
  let f = flags & ~(INFO_REMOTECONSOLEAUDIO | INFO_NOAUDIOPLAYBACK)
  if (p.audio === 'remote') f |= INFO_REMOTECONSOLEAUDIO
  else if (p.audio === 'off') f |= INFO_NOAUDIOPLAYBACK
  put32(pdu, info + 4, f)
  put32(pdu, perfAt, p.perf)
  return true
}

/**
 * 클라이언트 → 서버 바이트 흐름에서 Connect-Initial 과 Client Info 를 찾아 고친다.
 * 흐름은 CredSSP(DER 0x30…) · TPKT(0x03) · 빠른 경로 입력이 섞여 오고 WebSocket 메시지 경계와 PDU 경계가 같다는 보장이 없어
 * 단위를 직접 끊는다. 둘 다 고쳤거나 알 수 없는 바이트가 나오면 그 뒤로는 그대로 흘린다.
 */
export class ClientStreamPatcher {
  private buf = new Uint8Array(0)
  private core = false
  private info = false
  private passthrough = false
  private readonly patch: ClientPatch
  private readonly log?: (m: string) => void
  // 매개변수 속성(private x) 은 Node 의 타입 지우기가 못 읽는다 — 테스트가 이 파일을 바로 불러온다
  constructor(patch: ClientPatch, log?: (m: string) => void) {
    this.patch = patch
    this.log = log
  }

  get done(): boolean { return this.passthrough }
  /** Connect-Initial 을 지나갔는지 */
  get coreSeen(): boolean { return this.core }

  /** 남은 바이트를 그대로 흘릴 단위(CredSSP·빠른 경로) — 붙잡지 않는다 */
  private skip = 0

  /**
   * 들어온 조각 → 지금 보낼 바이트. 고칠 수도 있는 TPKT 만 다 받을 때까지 모으고,
   * CredSSP·빠른 경로 입력은 길이만 세며 바로 흘린다(붙잡아 접속이 멈추지 않게)
   */
  push(chunk: Uint8Array): Uint8Array {
    if (this.passthrough) return chunk
    const all = this.buf.length ? concatAll([this.buf, chunk]) : chunk
    const out: Uint8Array[] = []
    let i = 0
    while (i < all.length) {
      if (this.skip > 0) {
        const n = Math.min(this.skip, all.length - i)
        out.push(all.subarray(i, i + n))
        this.skip -= n
        i += n
        continue
      }
      const n = unitLength(all, i)
      if (n < 0) { this.stop(`알 수 없는 PDU 0x${all[i].toString(16)}`); out.push(all.subarray(i)); i = all.length; break }
      if (n === 0) break
      if (all[i] !== 3) { this.skip = n; continue }
      if (n < 7) { this.stop('짧은 TPKT'); out.push(all.subarray(i)); i = all.length; break }
      if (i + n > all.length) break
      const unit = all.slice(i, i + n)
      this.inspect(unit)
      out.push(unit)
      i += n
      if ((this.core && this.info && this.confirmed) || this.units > 200) { this.passthrough = true; out.push(all.subarray(i)); i = all.length; break }
    }
    this.buf = all.slice(i)
    return concatAll(out)
  }

  private units = 0
  private joins = 0
  private confirmed = false

  /** 고칠 PDU 는 고치고, 접속 단계를 기록한다(어디서 멈췄는지 보이게) */
  private inspect(unit: Uint8Array): void {
    this.units++
    const m = mcsStart(unit)
    if (m < 0) return
    const t = unit[m]
    if (!this.core && t === 0x7f && unit[m + 1] === 0x65) {
      this.core = true
      // 32비트는 IronRDP 가 보낸 값 그대로 둔다
      if (this.patch.colorDepth === 32) this.log?.('MCS 연결 요청 (색 깊이 그대로)')
      else this.log?.(patchClientCore(unit, this.patch.colorDepth) ? `MCS 연결 요청 — 색 깊이 ${this.patch.colorDepth}비트` : 'MCS 연결 요청 (색 깊이를 바꾸지 못함)')
      return
    }
    const kind = t >> 2
    if (kind === 1) this.log?.('MCS 도메인 설정')
    else if (kind === 10) this.log?.('MCS 사용자 연결')
    else if (kind === 14) { if (this.joins++ === 0) this.log?.('채널 연결') }
    else if (kind === 25) {
      if (!this.info && patchClientInfo(unit, this.patch)) { this.info = true; this.log?.(`로그온 정보 — 화면 효과 0x${this.patch.perf.toString(16)} · 소리 ${this.patch.audio}`); return }
      // Share Control 헤더: totalLength(2) | pduType(2) — 0x?3 이 Confirm Active
      let i = m + 6
      i += unit[i] & 0x80 ? 2 : 1
      if (this.info && i + 4 <= unit.length && (u16(unit, i + 2) & 0x0f) === 0x03) { this.confirmed = true; this.log?.('화면 기능 교환 (Confirm Active) — 첫 화면을 기다리는 중') }
    }
  }

  private stop(why: string): void {
    this.passthrough = true
    this.log?.(`화질·소리 설정을 적용하지 못했습니다 (${why})`)
  }
}

/** 한 단위의 길이 — 0: 더 받아야 함, -1: 알 수 없음 */
function unitLength(b: Uint8Array, i: number): number {
  const left = b.length - i
  if (left < 2) return 0
  const t = b[i]
  if (t === 0x03) return left < 4 ? 0 : (b[i + 2] << 8) | b[i + 3]
  if (t === 0x30) {
    // DER SEQUENCE (CredSSP TSRequest)
    const l = b[i + 1]
    if (l < 0x80) return 2 + l
    const k = l & 0x7f
    if (k < 1 || k > 3) return -1
    if (left < 2 + k) return 0
    let n = 0
    for (let x = 0; x < k; x++) n = (n << 8) | b[i + 2 + x]
    return 2 + k + n
  }
  if ((t & 0x03) === 0) {
    // 빠른 경로 입력: 길이 1~2 바이트
    const l = b[i + 1]
    if (!(l & 0x80)) return l
    return left < 3 ? 0 : ((l & 0x7f) << 8) | b[i + 2]
  }
  return -1
}

function concatAll(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0]
  const n = parts.reduce((a, p) => a + p.length, 0)
  const out = new Uint8Array(n)
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}

// ---------------------------------------------------------------- .rdp 파일 (외부 앱)

/** Windows mstsc · macOS Windows App · Remmina 가 읽는 .rdp. 비밀번호는 넣지 않는다 */
export function buildRdpFile(o: { address: string; port: number; username?: string; domain?: string; clipboard: boolean; resolution: string; colorDepth?: RdpColorDepth; experience?: Partial<RdpExperience>; audio?: RdpOptions['audio']; dpi?: number }): string {
  const e = rdpExperience(o)
  const user = o.username ? (o.domain && !o.username.includes('\\') && !o.username.includes('@') ? `${o.domain}\\${o.username}` : o.username) : ''
  const m = /^(\d{3,5})x(\d{3,5})$/.exec(o.resolution)
  const addr = o.address.includes(':') && !o.address.startsWith('[') ? `[${o.address}]` : o.address
  const lines = [
    `full address:s:${addr}${o.port && o.port !== 3389 ? `:${o.port}` : ''}`,
    ...(user ? [`username:s:${user}`] : []),
    `redirectclipboard:i:${o.clipboard ? 1 : 0}`,
    m ? 'screen mode id:i:1' : 'screen mode id:i:2',
    ...(m ? [`desktopwidth:i:${m[1]}`, `desktopheight:i:${m[2]}`] : []),
    'smart sizing:i:1',
    'dynamic resolution:i:1',
    'prompt for credentials:i:0',
    'authentication level:i:2',
    'enablecredsspsupport:i:1',
    `session bpp:i:${o.colorDepth ?? 32}`,
    // audiomode 0: 이 PC / 1: 원격 PC / 2: 재생 안 함
    `audiomode:i:${o.audio === 'remote' ? 1 : o.audio === 'off' ? 2 : 0}`,
    `disable wallpaper:i:${e.wallpaper ? 0 : 1}`,
    `disable themes:i:${e.themes ? 0 : 1}`,
    `allow font smoothing:i:${e.fontSmoothing ? 1 : 0}`,
    `allow desktop composition:i:${e.composition ? 1 : 0}`,
    `disable full window drag:i:${e.windowDrag ? 0 : 1}`,
    `disable menu anims:i:${e.animations ? 0 : 1}`,
    `disable cursor setting:i:${e.cursorShadow ? 0 : 1}`,
    ...(o.dpi && o.dpi !== 100 ? [`desktopscalefactor:i:${o.dpi}`] : [])
  ]
  // mstsc 는 줄바꿈이 CRLF 인 파일을 기대한다
  return lines.join('\r\n') + '\r\n'
}
