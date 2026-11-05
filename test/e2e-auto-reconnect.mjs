// npm run build && node test/e2e-auto-reconnect.mjs
// 서버별 자동 재접속: 로컬 TCP 서버에 텔넷으로 붙은 뒤 연결을 실제로 끊어 앱 설정과의 조합을 확인한다.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright-core'

const data = mkdtempSync(join(tmpdir(), 'bt-reconnect-'))
const sockets = new Set()
const server = createServer((socket) => {
  sockets.add(socket)
  socket.on('error', () => {})
  socket.on('close', () => sockets.delete(socket))
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))

const host = {
  id: 'reconnect-host', groupId: null, alias: 'Reconnect server', protocol: 'telnet', host: '127.0.0.1',
  port: server.address().port, username: '', authType: 'ask', tags: [], encoding: 'utf-8',
  termType: 'xterm-256color', keepaliveSec: 0, forwards: [], sort: 0
}

let app, page
const errors = []
const call = (channel, ...args) => page.evaluate(({ channel, args }) => window.bt.call(channel, ...args), { channel, args })

async function patch(hostPatch, appValue) {
  const { hosts, settings } = await call('store:get')
  const { autoReconnect: _, ...rest } = hosts[0]
  await call('store:patch', { hosts: [{ ...rest, ...hostPatch }], settings: { ...settings, autoReconnect: appValue } })
}

const waitState = (id, states) => page.evaluate(({ id, states }) => new Promise((resolve, reject) => {
  const check = () => {
    const state = window.__states[id]
    if (states.includes(state)) resolve(state)
    else if (Date.now() > deadline) reject(Error(`session state stayed ${state}, wanted ${states}`))
    else setTimeout(check, 50)
  }
  const deadline = Date.now() + 10000
  check()
}), { id, states })

/** 접속했다 끊고, 재접속을 예약했는지(reconnecting) 그대로 닫혔는지(closed) 돌려준다. change: 접속 중에 바꿀 설정 */
async function dropResult(change) {
  const info = await call('session:open', { hostId: host.id, cols: 80, rows: 24 })
  await waitState(info.id, ['connected'])
  if (change) await change()
  for (const socket of sockets) socket.destroy()
  const state = await waitState(info.id, ['reconnecting', 'closed', 'error'])
  await call('session:close', info.id)
  return state
}

try {
  app = await electron.launch({ args: ['.', '--password-store=basic'], env: { ...process.env, BRIGHTTERM_DATA: data } })
  page = await app.firstWindow()
  page.on('pageerror', (e) => errors.push(e.message))
  await page.waitForSelector('.lock-card')
  await page.evaluate(() => {
    localStorage.setItem('bt.importOffered', '1')
    window.__states = {}
    window.bt.on('session:state', (info) => { window.__states[info.id] = info.state })
  })
  const store = await call('store:get')
  await call('store:patch', { hosts: [host], settings: { ...store.settings, checkUpdates: false } })

  // [앱 설정, 서버 설정, 결과] — 서버 값이 없으면 앱 설정을 따르고, 있으면 서버 값이 이긴다
  for (const [appValue, hostValue, expected] of [
    [true, undefined, 'reconnecting'],
    [false, undefined, 'closed'],
    [false, true, 'reconnecting'],
    [true, false, 'closed']
  ]) {
    await patch(hostValue === undefined ? {} : { autoReconnect: hostValue }, appValue)
    assert.equal(await dropResult(), expected, `app=${appValue} host=${hostValue}`)
  }

  // 접속 중에 바꾼 서버 값은 다음 끊김부터 적용된다
  await patch({}, true)
  assert.equal(await dropResult(() => patch({ autoReconnect: false }, true)), 'closed', 'host changed while connected')

  // 편집 창: 세 값을 고르고 저장하면 그대로 남고, 앱 설정 따르기는 값을 비운다
  await patch({}, false)
  await page.reload()
  await page.waitForSelector('.lock-card')
  await call('vault:setup', 'ReconnectTest!2026')
  await call('vault:unlock', 'ReconnectTest!2026')
  await page.waitForSelector('.welcome')
  await page.keyboard.press('Escape')
  const saved = async () => (await call('store:get')).hosts[0].autoReconnect
  const choose = async (label) => {
    await page.locator('.sidebar [data-host="reconnect-host"]').click({ button: 'right' })
    await page.getByText('편집', { exact: false }).first().click()
    await page.locator('.mtabs').getByRole('button', { name: '고급' }).click()
    await page.getByRole('button', { name: '앱 설정 따르기 (꺼짐)' }).waitFor()
    await page.locator('.seg').getByRole('button', { name: label }).click()
    await page.getByRole('button', { name: '저장', exact: true }).click()
    await page.waitForSelector('.modal', { state: 'detached' })
  }
  assert.equal(await saved(), undefined)
  await choose('켜기')
  assert.equal(await saved(), true)
  await choose('끄기')
  assert.equal(await saved(), false)
  await choose('앱 설정 따르기 (꺼짐)')
  assert.equal(await saved(), undefined)

  assert.deepEqual(errors, [])
  console.log('PASS: app/host combinations, change while connected, editor saves on/off/inherit')
} finally {
  if (app) await app.close().catch(() => {})
  for (const socket of sockets) socket.destroy()
  server.close()
  rmSync(data, { recursive: true, force: true })
}
