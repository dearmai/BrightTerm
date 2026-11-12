// npm run build && node test/e2e-rdp-podman.mjs
// 내장 RDP(IronRDP + RDCleanPath 프록시)를 podman xrdp 컨테이너로 확인한다.
//   - RDP 허용 상태 확인(포트 닫힘 / 열림·TLS·인증서 지문)
//   - 처음 보는 서버 인증서 신뢰 묻기 → 내장 창에서 로그인 → 원격 화면이 그려진다
//   - 클립보드 동기화: 이 PC → 원격(xrdp 세션 안의 xclip), 원격 → 이 PC
//   - 서버별 클립보드 끔이면 동기화하지 않는다
// 필요: podman, 이미지 docker.io/scottyhardy/docker-remote-desktop (사용자 ubuntu / ubuntu, TLS — NLA 없음)
// Windows(NLA·CredSSP) 서버는 이 테스트로 확인하지 않는다.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright-core'
import { closeApp } from './close-app.mjs'

const NAME = 'bt-rdp-e2e'
const PORT = 13390
const IMAGE = 'docker.io/scottyhardy/docker-remote-desktop:latest'
const data = mkdtempSync(join(tmpdir(), 'bt-rdp-'))
const shotDir = process.env.BT_SHOTS || data
const podman = (...a) => execFileSync('podman', a, { encoding: 'utf8' }).trim()
let app, page
const errors = []
const call = (channel, ...args) => page.evaluate(({ channel, args }) => window.bt.call(channel, ...args), { channel, args })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitRdp(port, ms = 60000) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    const r = await call('rdp:check', { ...base, id: 'probe', host: '127.0.0.1', rdp: { ...rdp, port } })
    if (r.state === 'ok') return r
    await sleep(1000)
  }
  throw new Error('xrdp 가 뜨지 않았습니다')
}

const rdp = { mode: 'builtin', port: PORT, auth: 'own', clipboard: true, resolution: '1280x720', route: 'direct', openIn: 'window' }
const base = { groupId: null, protocol: 'ssh', host: '127.0.0.1', port: 22, username: 'ubuntu', authType: 'password', tags: [], encoding: 'utf-8', termType: 'xterm-256color', keepaliveSec: 0, forwards: [], sort: 0, os: 'windows' }

/** 원격 화면 캔버스가 검은 화면이 아닌지 — 그려진 픽셀 색 수 */
async function paintedColors(w) {
  return w.evaluate(() => {
    const el = document.querySelector('iron-remote-desktop')
    const c = el?.shadowRoot?.querySelector('canvas')
    if (!c || !c.width) return 0
    const t = document.createElement('canvas')
    t.width = 64; t.height = 36
    t.getContext('2d').drawImage(c, 0, 0, 64, 36)
    const d = t.getContext('2d').getImageData(0, 0, 64, 36).data
    const set = new Set()
    for (let i = 0; i < d.length; i += 4) set.add((d[i] >> 4) << 8 | (d[i + 1] >> 4) << 4 | (d[i + 2] >> 4))
    return set.size
  })
}

async function openAndLogin(hostId) {
  const winP = app.waitForEvent('window', { predicate: (w) => w.url().includes('rdp.html'), timeout: 30000 })
  const opened = page.evaluate((id) => window.bt.call('rdp:open', id), hostId)
  return { winP, opened }
}

try {
  try { podman('rm', '-f', NAME) } catch { /* */ }
  podman('run', '-d', '--name', NAME, '-p', `${PORT}:3389`, '--shm-size=1g', IMAGE)
  // 원격 세션의 클립보드를 읽고 쓰는 데 xclip 을 쓴다
  try { podman('exec', NAME, 'sh', '-c', 'apt-get update -qq >/dev/null 2>&1; DEBIAN_FRONTEND=noninteractive apt-get install -y -qq xclip >/dev/null 2>&1; command -v xclip') } catch (e) { console.log('xclip 설치 실패', e.message) }

  app = await electron.launch({ args: ['.', '--password-store=basic'], env: { ...process.env, BRIGHTTERM_DATA: data } })
  page = await app.firstWindow()
  page.on('pageerror', (e) => errors.push(e.message))
  await page.waitForSelector('.lock-card')
  await page.evaluate((d) => { localStorage.setItem('bt.importOffered', '1'); if (d) localStorage.setItem('bt.rdpLog', 'DEBUG') }, !!process.env.BT_DIAG)
  await call('vault:setup', 'Rdp!2026')
  await call('vault:unlock', 'Rdp!2026')

  // 1) 닫힌 포트
  const closed = await call('rdp:check', { ...base, id: 'x', rdp: { ...rdp, port: 1 } })
  assert.equal(closed.state, 'closed', JSON.stringify(closed))

  // 2) 열린 포트 — TLS 와 인증서 지문
  const ok = await waitRdp(PORT)
  assert.equal(ok.security, 'TLS')
  assert.match(ok.fingerprint, /^SHA256:/)
  console.log('check:', ok.message, ok.security, ok.fingerprint, `${ok.latencyMs}ms`)

  const cred = await call('cred:save', { name: 'xrdp', kind: 'password', username: 'ubuntu', password: 'ubuntu' })
  const store = await call('store:get')
  await call('store:patch', {
    settings: { ...store.settings, checkUpdates: false },
    hosts: [
      { ...base, id: 'w1', alias: 'xrdp', rdp: { ...rdp, credentialId: cred.id } },
      { ...base, id: 'w2', alias: 'xrdp 클립보드 끔', rdp: { ...rdp, credentialId: cred.id, clipboard: false } }
    ]
  })
  await page.reload()
  await page.waitForSelector('.welcome')

  // 3) 처음 보는 인증서 → 묻기 → 신뢰 → 내장 창
  const { winP, opened } = await openAndLogin('w1')
  await page.getByRole('button', { name: '신뢰하고 접속' }).click()
  const r = await opened
  assert.equal(r.mode, 'builtin')
  const w = await winP
  w.on('pageerror', (e) => errors.push(`rdp: ${e.message}`))
  w.on('console', (m) => { if (m.type() === 'error' || (process.env.BT_DIAG && /clip|channel|cliprdr|format/i.test(m.text()))) console.log('[rdp console]', m.text().slice(0, 300)) })
  await w.waitForSelector('.rdp-bar .dot.connected', { timeout: 60000 })
  let colors = 0
  for (let i = 0; i < 30 && colors < 8; i++) { await sleep(1000); colors = await paintedColors(w) }
  await w.screenshot({ path: join(shotDir, 'rdp-connected.png') })
  assert.ok(colors >= 8, `원격 화면이 그려지지 않았습니다 (색 ${colors}개)`)
  console.log('connected, colors:', colors)

  // xrdp 는 로그인 창을 띄운다(IronRDP 가 자동 로그온을 요청하지 않음) — 비밀번호 칸에 입력해 세션을 연다
  await w.locator('iron-remote-desktop').click({ position: { x: 640, y: 420 } })
  await sleep(500)
  await w.keyboard.type('ubuntu')
  await w.keyboard.press('Enter')
  let display = ''
  for (let i = 0; i < 40 && !display; i++) {
    await sleep(1000)
    try { display = podman('exec', NAME, 'sh', '-c', "ls /tmp/.X11-unix | grep -v X0 | sed 's/X/:/' | head -1") } catch { /* */ }
  }
  await sleep(4000)
  await w.screenshot({ path: join(shotDir, 'rdp-session.png') })
  console.log('xrdp display:', display || '(없음)')

  // 4) 클립보드: 이 PC → 원격. xrdp 세션의 X 디스플레이에서 xclip 으로 읽는다
  const LOCAL = `bt-local-${Date.now()}`
  await app.evaluate(({ clipboard }, t) => clipboard.writeText(t), LOCAL)
  await w.bringToFront()
  await w.locator('iron-remote-desktop').click({ position: { x: 600, y: 300 } })
  const xclip = (args) => { try { return podman('exec', '-u', 'ubuntu', '-e', `DISPLAY=${display}`, NAME, 'sh', '-c', `timeout 3 xclip ${args} -t UTF8_STRING`) } catch (e) { return `ERR ${String(e.stderr || e.message).slice(0, 120)}` } }
  console.log('diag:', await w.evaluate(async () => ({ secure: window.isSecureContext, focus: document.hasFocus(), warn: document.querySelector('.rdp-warn')?.textContent ?? '', perm: await navigator.permissions.query({ name: 'clipboard-read' }).then((p) => p.state, (e) => String(e)), read: await navigator.clipboard.readText().then((t) => t, (e) => 'ERR ' + e) })))
  let remote = ''
  for (let i = 0; i < 20 && remote !== LOCAL; i++) { await sleep(1000); remote = xclip('-o -selection clipboard') }
  console.log('remote clipboard:', remote.slice(0, 80))

  // 5) 원격 → 이 PC
  const REMOTE = `bt-remote-${Date.now()}`
  try { execFileSync('podman', ['exec', '-d', '-u', 'ubuntu', '-e', `DISPLAY=${display}`, NAME, 'sh', '-c', `printf %s ${REMOTE} | xclip -i -selection clipboard -loops 5`]) } catch (e) { console.log('xclip set failed', e.message) }
  let local = ''
  for (let i = 0; i < 20 && local !== REMOTE; i++) { await sleep(1000); local = await app.evaluate(({ clipboard }) => clipboard.readText()) }
  console.log('local clipboard:', local)
  if (process.env.BT_DIAG) console.log(podman('exec', NAME, 'sh', '-c', `ps aux | grep -i chansrv | grep -v grep; grep -i -E 'chan|clip|static|mcs' /var/log/xrdp.log | tail -n 30; f=$(find / -name '*chansrv*.log' 2>/dev/null | head -1); echo LOG $f; tail -n 40 $f`))
  const clipResult = { toRemote: remote === LOCAL, toLocal: local === REMOTE }
  writeFileSync(join(shotDir, 'rdp-clipboard.json'), JSON.stringify(clipResult))
  console.log('clipboard sync:', clipResult)
  assert.deepEqual(clipResult, { toRemote: true, toLocal: true })

  // 6) 연결 끊기 → 창 닫기
  await w.getByRole('button', { name: '연결 끊기' }).click()
  await w.waitForSelector('.rdp-overlay >> text=연결을 끊었습니다')
  const closedP = new Promise((res) => w.once('close', res))
  await w.getByRole('button', { name: '창 닫기' }).click()
  await Promise.race([closedP, sleep(10000)])
  console.log('windows after close:', app.windows().map((x) => x.url().split('/').pop()))
  assert.ok(!app.windows().some((x) => x.url().includes('rdp.html')), 'RDP 창이 닫히지 않았습니다')

  // 7) 클립보드 끔 서버 — 같은 xrdp 세션에 다시 붙어도 이 PC 클립보드가 넘어가지 않는다
  const before = xclip('-o -selection clipboard')
  const { winP: winP2, opened: opened2 } = await openAndLogin('w2')
  await opened2
  const w2 = await winP2
  await w2.waitForSelector('.rdp-bar .dot.connected', { timeout: 60000 })
  assert.equal(await w2.locator('.rdp-clip').getAttribute('title'), '클립보드 동기화 꺼짐 — 누르면 켭니다')
  await app.evaluate(({ clipboard }, t) => clipboard.writeText(t), `bt-off-${Date.now()}`)
  await w2.bringToFront()
  await w2.locator('iron-remote-desktop').click({ position: { x: 600, y: 300 } })
  await sleep(6000)
  const after = xclip('-o -selection clipboard')
  console.log('clipboard off — remote before/after:', before, '/', after)
  assert.ok(!after.startsWith('bt-off-'), '클립보드를 끈 서버인데 동기화되었습니다')
  await w2.getByRole('button', { name: '연결 끊기' }).click()
  await w2.getByRole('button', { name: '창 닫기' }).click()

  assert.deepEqual(errors, [])
  console.log('e2e-rdp-podman OK')
} catch (e) {
  console.error(e)
  console.error('page errors:', errors)
  process.exitCode = 1
} finally {
  await closeApp(app)
  try { podman('rm', '-f', NAME) } catch { /* */ }
  if (!process.env.BT_SHOTS) rmSync(data, { recursive: true, force: true })
}
