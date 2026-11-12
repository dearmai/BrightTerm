// node --test test/rdp.test.mjs
// RDP 보조: X.224 협상 PDU, RDCleanPath DER, .rdp 파일, WebSocket 프레임
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { registerHooks } from 'node:module'
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith('@shared/')) return next(new URL(`../src/shared/${spec.slice(8)}.ts`, import.meta.url).href, ctx)
    return next(spec, ctx)
  }
})
const rdp = await import('../src/shared/rdp.ts')
const ws = await import('../src/main/rdp/ws.ts')

test('X.224 Connection Request — TPKT 길이·RDP_NEG_REQ·쿠키', () => {
  const b = rdp.x224ConnectionRequest(rdp.PROTOCOL_SSL | rdp.PROTOCOL_HYBRID | rdp.PROTOCOL_HYBRID_EX)
  assert.deepEqual([...b], [0x03, 0, 0, 19, 14, 0xe0, 0, 0, 0, 0, 0, 0x01, 0, 0x08, 0, 0x0b, 0, 0, 0])
  assert.equal(rdp.tpktLength(b), b.length)
  const c = rdp.x224ConnectionRequest(1, 'administrator')
  // mstshash 는 9자로 자른다 (mstsc 와 같게)
  assert.match(Buffer.from(c).toString('latin1'), /Cookie: mstshash=administr\r\n/)
  assert.equal(rdp.tpktLength(c), c.length)
  assert.equal(c[4], c.length - 5)
})

test('X.224 Connection Confirm — 선택·실패·협상 없음', () => {
  const confirm = (type, v) => Uint8Array.from([3, 0, 0, 19, 14, 0xd0, 0, 0, 0x12, 0x34, 0, type, 0, 8, 0, v, 0, 0, 0])
  assert.deepEqual(rdp.parseX224Confirm(confirm(2, 2)), { kind: 'selected', protocol: 2 })
  assert.deepEqual(rdp.parseX224Confirm(confirm(3, 5)), { kind: 'failure', code: 5 })
  assert.deepEqual(rdp.parseX224Confirm(Uint8Array.from([3, 0, 0, 11, 6, 0xd0, 0, 0, 0, 0, 0])), { kind: 'legacy' })
  assert.throws(() => rdp.parseX224Confirm(Uint8Array.from([3, 0, 0, 11, 6, 0xe0, 0, 0, 0, 0, 0])))
  assert.equal(rdp.tpktLength(Uint8Array.from([0x16, 3, 1, 0])), -1)
  assert.equal(rdp.tpktLength(Uint8Array.from([3, 0])), 0)
  assert.equal(rdp.protocolLabel(2), 'NLA (CredSSP)')
  assert.match(rdp.negotiationFailureLabel(5), /NLA/)
})

test('RDCleanPath — 요청 디코드(IronRDP 가 보내는 형식)와 응답 인코드 왕복', () => {
  const x224 = rdp.x224ConnectionRequest()
  const req = rdp.encodeRDCleanPath({ version: 3390, destination: '10.0.0.5:3389', proxyAuth: 'tok', x224 })
  // SEQUENCE { [0] INTEGER 3390, [2] UTF8String, [3] UTF8String, [6] OCTET STRING }
  assert.deepEqual([...req.slice(0, 9)], [0x30, req.length - 2, 0xa0, 4, 0x02, 2, 0x0d, 0x3e, 0xa2])
  assert.equal(rdp.rdcleanpathLength(req), req.length)
  assert.equal(rdp.rdcleanpathLength(req.slice(0, 5)), 0)
  const d = rdp.decodeRDCleanPath(req)
  assert.equal(d.destination, '10.0.0.5:3389')
  assert.equal(d.proxyAuth, 'tok')
  assert.deepEqual([...d.x224], [...x224])

  const big = new Uint8Array(1500).fill(7)
  const res = rdp.encodeRDCleanPath({ version: 3390, serverAddr: '10.0.0.5:3389', x224: Uint8Array.from([3, 0, 0, 11, 6, 0xd0, 0, 0, 0, 0, 0]), serverCertChain: [big, Uint8Array.from([1, 2])] })
  const r = rdp.decodeRDCleanPath(res)
  assert.equal(r.serverAddr, '10.0.0.5:3389')
  assert.equal(r.serverCertChain.length, 2)
  assert.deepEqual([...r.serverCertChain[0]], [...big])
  assert.equal(rdp.rdcleanpathLength(res), res.length)

  const err = rdp.decodeRDCleanPath(rdp.encodeRDCleanPath({ version: 3390, error: { errorCode: 1, tlsAlertCode: 42, wsaLastError: 10061 } }))
  assert.deepEqual(err.error, { errorCode: 1, tlsAlertCode: 42, wsaLastError: 10061 })
  assert.throws(() => rdp.decodeRDCleanPath(rdp.encodeRDCleanPath({ version: 1 })), /버전/)
})

test('.rdp 파일 — CRLF, 도메인 사용자, 클립보드, 고정 해상도', () => {
  const f = rdp.buildRdpFile({ address: 'win01', port: 3390, username: 'admin', domain: 'CORP', clipboard: false, resolution: '1920x1080' })
  assert.ok(f.endsWith('\r\n'))
  const lines = f.trim().split('\r\n')
  assert.ok(lines.includes('full address:s:win01:3390'))
  assert.ok(lines.includes('username:s:CORP\\admin'))
  assert.ok(lines.includes('redirectclipboard:i:0'))
  assert.ok(lines.includes('desktopwidth:i:1920'))
  assert.ok(!/password/i.test(f))
  const g = rdp.buildRdpFile({ address: '::1', port: 3389, clipboard: true, resolution: 'window' })
  assert.ok(g.includes('full address:s:[::1]\r\n'))
  assert.ok(g.includes('redirectclipboard:i:1'))
  assert.ok(!g.includes('username'))
})

test('rdpCapable — Windows 이고 SSH·텔넷이며 주소가 있을 때만', () => {
  assert.equal(rdp.rdpCapable({ os: 'windows', protocol: 'ssh', host: 'a' }), true)
  assert.equal(rdp.rdpCapable({ os: 'windows', protocol: 'serial', host: 'a' }), false)
  assert.equal(rdp.rdpCapable({ os: 'linux', protocol: 'ssh', host: 'a' }), false)
  assert.equal(rdp.rdpCapable({ os: 'windows', protocol: 'telnet', host: '' }), false)
  assert.deepEqual(rdp.rdpOptions({}), rdp.DEFAULT_RDP)
  assert.equal(rdp.rdpOptions({ rdp: { ...rdp.DEFAULT_RDP, port: 4000 } }).port, 4000)
})

test('WebSocket — 핸드셰이크, 마스킹·조각난 프레임, 큰 메시지, ping, close', async () => {
  assert.equal(ws.acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=')
  const server = createServer()
  const got = []
  let conn
  server.on('upgrade', (req, sock, head) => {
    conn = ws.acceptUpgrade(req, sock, head)
    conn.on('message', (m) => { got.push(m); conn.send(m) })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const client = new WebSocket(`ws://127.0.0.1:${server.address().port}/x`)
  client.binaryType = 'arraybuffer'
  const echoes = []
  await new Promise((r, j) => { client.onopen = r; client.onerror = j })
  const done = new Promise((r) => { client.onmessage = (e) => { echoes.push(new Uint8Array(e.data)); if (echoes.length === 3) r() } })
  client.send(Uint8Array.from([1, 2, 3]))
  client.send(new Uint8Array(70000).fill(9))
  client.send(new Uint8Array(300).fill(4))
  await done
  assert.deepEqual([...echoes[0]], [1, 2, 3])
  assert.equal(echoes[1].length, 70000)
  assert.equal(echoes[2].length, 300)
  // 조각난 프레임(FIN 없음 + continuation) 은 한 메시지로 모은다
  const parts = []
  const fake = { on: () => {}, write: (b) => parts.push(b), end: () => {}, destroy: () => {} }
  const c2 = new ws.WsConn(fake)
  const msgs = []
  c2.on('message', (m) => msgs.push(m))
  const mask = Uint8Array.from([1, 2, 3, 4])
  const f1 = ws.encodeFrame(0x2, Uint8Array.from([10, 11]), mask); f1[0] &= 0x7f
  const f2 = ws.encodeFrame(0x0, Uint8Array.from([12]), mask)
  const ping = ws.encodeFrame(0x9, Uint8Array.from([5]), mask)
  const all = Buffer.concat([f1, ping, f2])
  for (const b of all) c2.feed(Buffer.from([b])) // 한 바이트씩
  assert.deepEqual(msgs.map((m) => [...m]), [[10, 11, 12]])
  assert.deepEqual([...parts[0]], [0x8a, 1, 5]) // pong
  // 마스킹하지 않은 클라이언트 프레임은 프로토콜 오류로 닫는다
  const c3 = new ws.WsConn(fake)
  let closed = false
  c3.on('close', () => (closed = true))
  c3.feed(ws.encodeFrame(0x2, Uint8Array.from([1])))
  assert.equal(closed, true)
  client.close()
  server.close()
})

// ---- 화질·소리: Connect-Initial(TS_UD_CS_CORE) · Client Info 고치기
function tpkt(body) {
  const b = new Uint8Array(4 + 3 + body.length)
  b.set([3, 0, (b.length >> 8) & 0xff, b.length & 0xff, 2, 0xf0, 0x80])
  b.set(body, 7)
  return b
}
function connectInitial() {
  const core = new Uint8Array(216)
  const dv = new DataView(core.buffer)
  dv.setUint16(0, 0xc001, true); dv.setUint16(2, 216, true); dv.setUint32(4, 0x00080004, true)
  dv.setUint16(140, 24, true); dv.setUint16(142, 0x0f, true); dv.setUint16(144, 0x0003, true)
  const pre = Uint8Array.from([0x7f, 0x65, 0x82, 0x01, 0x00, 0x04, 0x01, 0x01, 0x04, 0x01, 0x01, 0x01, 0x01, 0xff])
  const body = new Uint8Array(pre.length + core.length)
  body.set(pre); body.set(core, pre.length)
  return { pdu: tpkt(body), at: 7 + pre.length }
}
function clientInfo() {
  const u = (s) => { const b = new Uint8Array(s.length * 2 + 2); for (let i = 0; i < s.length; i++) b[i * 2] = s.charCodeAt(i); return b }
  const parts = []
  const n16 = (v) => Uint8Array.from([v & 0xff, v >> 8])
  const n32 = (v) => Uint8Array.from([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff])
  const user = u('admin'); const pw = u('pw1')
  parts.push(n32(0), n32(0x10 | 0x1 | 0x8), n16(0), n16(user.length - 2), n16(pw.length - 2), n16(0), n16(0))
  parts.push(u(''), user, pw, u(''), u(''))
  const addr = u('1.2'); const dir = u('C:')
  parts.push(n16(2), n16(addr.length), addr, n16(dir.length), dir, new Uint8Array(172), n32(0), n32(0))
  const info = Buffer.concat(parts)
  const body = Buffer.concat([Buffer.from([0x64, 0, 6, 3, 0xeb, 0x70, 0x80 | ((info.length + 4) >> 8), (info.length + 4) & 0xff, 0x40, 0, 0, 0]), info])
  return { pdu: tpkt(body), flagsAt: 7 + 12 + 4, perfAt: 7 + 12 + info.length - 4 }
}
const le32 = (b, i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0
const le16 = (b, i) => b[i] | (b[i + 1] << 8)

test('화질 — 색 깊이(TS_UD_CS_CORE)', () => {
  const { pdu, at } = connectInitial()
  assert.ok(rdp.patchClientCore(pdu, 16))
  assert.equal(le16(pdu, at + 140), 16)
  assert.equal(le16(pdu, at + 142), 0x02)
  assert.equal(le16(pdu, at + 144) & 2, 0)
  assert.ok(rdp.patchClientCore(pdu, 32))
  assert.equal(le16(pdu, at + 140), 24)
  assert.equal(le16(pdu, at + 144) & 2, 2)
  assert.equal(rdp.patchClientCore(clientInfo().pdu, 16), false)
})

test('화질·소리 — Client Info 의 performanceFlags·소리 비트', () => {
  const { pdu, flagsAt, perfAt } = clientInfo()
  const len = pdu.length
  assert.ok(rdp.patchClientInfo(pdu, { perf: rdp.perfFlags(rdp.RDP_PRESETS.fast.experience), audio: 'off' }))
  assert.equal(pdu.length, len)
  assert.equal(le32(pdu, perfAt), 0x2f)
  assert.equal(le32(pdu, flagsAt) & rdp.INFO_NOAUDIOPLAYBACK, rdp.INFO_NOAUDIOPLAYBACK)
  assert.equal(le32(pdu, flagsAt) & 0x19, 0x19, '다른 flags 는 그대로')
  assert.ok(rdp.patchClientInfo(pdu, { perf: rdp.perfFlags(rdp.ALL_EXPERIENCE), audio: 'remote' }))
  assert.equal(le32(pdu, perfAt), 0x180)
  assert.equal(le32(pdu, flagsAt) & (rdp.INFO_NOAUDIOPLAYBACK | rdp.INFO_REMOTECONSOLEAUDIO), rdp.INFO_REMOTECONSOLEAUDIO)
  assert.equal(rdp.patchClientInfo(connectInitial().pdu, { perf: 0, audio: 'off' }), false)
})

test('화질 — 프리셋 판별, .rdp 파일 항목', () => {
  assert.equal(rdp.rdpPreset({}), 'best')
  assert.equal(rdp.rdpPreset({ colorDepth: 16, experience: rdp.RDP_PRESETS.fast.experience }), 'fast')
  assert.equal(rdp.rdpPreset({ experience: { wallpaper: false } }), 'custom')
  const f = rdp.buildRdpFile({ address: 'h', port: 3389, clipboard: true, resolution: 'window', colorDepth: 16, audio: 'remote', experience: { wallpaper: false }, dpi: 150 })
  for (const l of ['session bpp:i:16', 'audiomode:i:1', 'disable wallpaper:i:1', 'disable themes:i:0', 'desktopscalefactor:i:150']) assert.ok(f.includes(l + '\r\n'), l)
  assert.ok(rdp.buildRdpFile({ address: 'h', port: 3389, clipboard: true, resolution: 'window' }).includes('audiomode:i:0\r\n'))
})

test('ClientStreamPatcher — 조각난 흐름(CredSSP·TPKT·빠른 경로)에서 둘 다 고치고 그 뒤는 그대로', () => {
  const credssp = Uint8Array.from([0x30, 0x82, 0x00, 0x03, 1, 2, 3])
  const ci = connectInitial(); const info = clientInfo()
  const fast = Uint8Array.from([0x04, 0x05, 9, 9, 9])
  const all = Buffer.concat([credssp, ci.pdu, tpkt(Uint8Array.from([0x04, 1, 2])), info.pdu, fast, Uint8Array.from([0xff, 0xee])])
  const logs = []
  const p = new rdp.ClientStreamPatcher(rdp.clientPatchOf({ ...rdp.DEFAULT_RDP, colorDepth: 16, audio: 'off' }), (m) => logs.push(m))
  const out = []
  for (let i = 0; i < all.length; i += 7) out.push(p.push(all.subarray(i, i + 7)))
  const got = Buffer.concat(out)
  assert.equal(got.length, all.length)
  assert.ok(p.done)
  assert.equal(le16(got, credssp.length + ci.at + 140), 16)
  const infoAt = credssp.length + ci.pdu.length + 10
  assert.equal(le32(got, infoAt + info.flagsAt) & rdp.INFO_NOAUDIOPLAYBACK, rdp.INFO_NOAUDIOPLAYBACK)
  assert.deepEqual([...got.subarray(got.length - 7)], [...fast, 0xff, 0xee])
  assert.ok(logs.some((l) => l.includes('색 깊이 16비트')) && logs.some((l) => l.includes('로그온 정보')), logs.join(' | '))
  // 알 수 없는 바이트면 손대지 않고 흘린다
  const q = new rdp.ClientStreamPatcher(rdp.clientPatchOf(rdp.DEFAULT_RDP))
  assert.deepEqual([...q.push(Uint8Array.from([0xff, 1, 2]))], [0xff, 1, 2])
  assert.ok(q.done)
})
