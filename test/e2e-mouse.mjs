// npm run build && node test/e2e-mouse.mjs
// A real local Telnet transport exercises xterm mouse reports and reconnects without touching user servers.
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright-core'

const data = mkdtempSync(join(tmpdir(), 'bt-mouse-'))
const sockets = new Set()
let received = ''
let connections = 0
const server = createServer((socket) => {
  connections++
  sockets.add(socket)
  socket.on('error', () => {})
  socket.on('close', () => sockets.delete(socket))
  socket.on('data', (chunk) => { received += chunk.toString('latin1') })
  socket.write('mouse test shell\r\n$ ')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const host = {
  id: 'mouse-host', groupId: null, alias: 'Mouse test server', protocol: 'telnet', host: '127.0.0.1',
  port: server.address().port, username: '', authType: 'ask', tags: [], encoding: 'utf-8',
  termType: 'xterm-256color', keepaliveSec: 0, forwards: [], sort: 0, autoReconnect: true,
  reconnectPolicy: { initialDelaySec: 1, mode: 'fixed', incrementSec: 1, multiplier: 2, maxDelaySec: 1, maxAttempts: 2 }
}
let app, page
const call = (channel, ...args) => page.evaluate(({ channel, args }) => window.bt.call(channel, ...args), { channel, args })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const send = (text) => { for (const socket of sockets) socket.write(text) }
const waitFor = async (predicate, label) => {
  const deadline = Date.now() + 8000
  while (!predicate()) { if (Date.now() > deadline) throw Error(`timeout: ${label}`); await sleep(30) }
}
const move = async () => {
  const box = await page.locator('.pane .xterm-screen').boundingBox()
  assert.ok(box)
  await page.mouse.move(box.x + 50, box.y + 50)
  await page.mouse.move(box.x + 150, box.y + 90, { steps: 8 })
  await sleep(150)
}
const errors = []
try {
  app = await electron.launch({ args: ['.'], env: { ...process.env, BRIGHTTERM_DATA: data } })
  page = await app.firstWindow()
  page.on('pageerror', (e) => errors.push(e.message))
  await page.waitForSelector('.lock-card')
  await page.evaluate(() => localStorage.setItem('bt.importOffered', '1'))
  const store = await call('store:get')
  await call('store:patch', { hosts: [host], settings: { ...store.settings, checkUpdates: false } })
  await call('vault:setup', 'Mouse-test-password-2026')
  await page.reload()
  await page.waitForSelector('.lock-card', { state: 'detached' })
  await page.evaluate(() => {
    window.__mouseState = null
    window.bt.on('session:state', (info) => { window.__mouseState = info })
  })
  await page.locator('button.tab-new').click()
  await page.locator('.p-input input').fill(host.alias)
  await page.locator('.p-input input').press('Enter')
  await page.waitForSelector('.pane .dot.connected')
  const id = await page.evaluate(() => window.__mouseState.id)

  // Reproduce the original symptom: all-motion + SGR decimal coordinates.
  send('\x1b[?1003;1006h')
  await sleep(150)
  received = ''
  await move()
  assert.match(received, /\x1b\[<\d+;\d+;\d+M/, 'allowed server receives mouse motion')

  for (const socket of sockets) socket.destroy()
  await waitFor(() => connections === 2, 'automatic reconnect')
  await page.waitForFunction(() => window.__mouseState?.state === 'connected')
  await sleep(150)
  received = ''
  await move()
  assert.equal(received, '', 'new shell must not inherit old mouse modes')

  // Enable again, then turn the per-server setting off while still connected.
  send('\x1b[?1003;1006h')
  await sleep(150)
  received = ''
  await move()
  assert.match(received, /\x1b\[</)
  await page.locator(`[data-host="${host.id}"]`).click({ button: 'right' })
  await page.locator('.ctx').getByText('편집', { exact: true }).click()
  await page.locator('.mtabs button').getByText('터미널', { exact: true }).click()
  const mouseSetting = page.locator('.field').filter({ has: page.locator('label', { hasText: '서버 프로그램에 마우스 입력 전달' }) }).locator('button.switch')
  await mouseSetting.click()
  await page.getByRole('button', { name: '저장', exact: true }).click()
  assert.equal((await call('store:get')).hosts[0].mouseReporting, false)
  await sleep(200)
  // Deliberately split the server request across packets and mix a harmless cursor mode.
  send('\x1b[?100')
  await sleep(30)
  send('3;1006;25h')
  await sleep(150)
  received = ''
  await move()
  await page.mouse.click(150, 150)
  await page.mouse.wheel(0, 100)
  await sleep(150)
  assert.equal(received, '', 'disabled server ignores motion/click/wheel and renewed requests')

  send('\x1b[?1049h\x1b[?1003;1006h')
  await sleep(150)
  await move()
  await page.mouse.wheel(0, 100)
  await sleep(150)
  assert.equal(received, '', 'disabled alternate-screen wheel must not send arrow keys')
  send('\x1b[?1049l')

  // Back-end defense also rejects directly injected reports while allowing ordinary keys.
  await page.evaluate((id) => {
    window.bt.write(id, '\x1b[<35;10;10M')
    window.bt.write(id, '\x1b[35;10;10M')
    window.bt.write(id, '\x1b[M !!')
    window.bt.write(id, 'typed\r')
  }, id)
  await waitFor(() => received.includes('typed'), 'ordinary keyboard input')
  assert.equal(received, 'typed\r')
  assert.deepEqual(errors, [])
  console.log('PASS: mouse reporting, reconnect reset, live per-server disable, split mode requests and keyboard input')
} finally {
  if (app) { await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {}) }
  for (const socket of sockets) socket.destroy()
  await new Promise((resolve) => server.close(resolve))
  rmSync(data, { recursive: true, force: true })
}
