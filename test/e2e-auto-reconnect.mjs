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
  const { autoReconnect: _, reconnectPolicy: _policy, ...rest } = hosts[0]
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
    window.__infos = {}
    window.bt.on('session:state', (info) => { window.__states[info.id] = info.state; window.__infos[info.id] = info })
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

  // 서버별 선형 증가 규칙이 앱 고정 규칙보다 우선하고 횟수 제한에 도달하면 멈춘다.
  const appPolicy = { initialDelaySec: 4, mode: 'fixed', incrementSec: 1, multiplier: 2, maxDelaySec: 4, maxAttempts: 1 }
  const hostPolicy = { ...appPolicy, initialDelaySec: 1, mode: 'linear', incrementSec: 1, maxDelaySec: 3, maxAttempts: 2 }
  await patch({ reconnectPolicy: hostPolicy }, true)
  const before = await call('store:get')
  await call('store:patch', { settings: { ...before.settings, reconnectPolicy: appPolicy } })
  const retryInfo = await call('session:open', { hostId: host.id, cols: 80, rows: 24 })
  await waitState(retryInfo.id, ['connected'])
  const closing = new Promise((resolve) => server.close(resolve))
  for (const socket of sockets) socket.destroy()
  await closing
  await page.waitForFunction((id) => /^1초.*1\/2/.test(window.__infos[id]?.message), retryInfo.id)
  await page.waitForFunction((id) => /^2초.*2\/2/.test(window.__infos[id]?.message), retryInfo.id)
  await waitState(retryInfo.id, ['error'])
  assert.match(await call('session:connectLog', retryInfo.id), /최대 2회에 도달/)
  await new Promise((resolve) => server.listen(host.port, '127.0.0.1', resolve))
  await call('session:reconnect', retryInfo.id)
  await waitState(retryInfo.id, ['connected'])
  for (const socket of sockets) socket.destroy()
  await page.waitForFunction((id) => /^1초.*1\/2/.test(window.__infos[id]?.message), retryInfo.id)
  await call('session:close', retryInfo.id)

  // 서버 규칙이 없으면 앱의 4초 고정 규칙을 상속한다.
  await patch({}, true)
  const inherited = await call('session:open', { hostId: host.id, cols: 80, rows: 24 })
  await waitState(inherited.id, ['connected'])
  for (const socket of sockets) socket.destroy()
  await page.waitForFunction((id) => /^4초.*1\/1/.test(window.__infos[id]?.message), inherited.id)
  await call('session:close', inherited.id)

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

  await page.locator('.sidebar [data-host="reconnect-host"]').click({ button: 'right' })
  await page.getByText('편집', { exact: false }).first().click()
  await page.locator('.mtabs').getByRole('button', { name: '고급' }).click()
  await page.getByRole('button', { name: '서버별 규칙', exact: true }).click()
  await page.getByRole('spinbutton', { name: '첫 재시도 대기 (초)', exact: true }).fill('5')
  await page.getByRole('button', { name: '일정 시간 증가', exact: true }).click()
  await page.getByRole('spinbutton', { name: '매회 추가 대기 (초)', exact: true }).fill('3')
  await page.getByRole('spinbutton', { name: '최대 대기 (초)', exact: true }).fill('20')
  await page.getByRole('spinbutton', { name: '최대 재시도 횟수', exact: true }).fill('4')
  await page.getByRole('button', { name: '저장', exact: true }).click()
  await page.waitForSelector('.modal', { state: 'detached' })
  const savedPolicy = (await call('store:get')).hosts[0].reconnectPolicy
  assert.equal(savedPolicy.initialDelaySec, 5)
  assert.equal(savedPolicy.mode, 'linear')
  assert.equal(savedPolicy.incrementSec, 3)
  assert.equal(savedPolicy.maxDelaySec, 20)
  assert.equal(savedPolicy.maxAttempts, 4)
  await page.locator('.sidebar [data-host="reconnect-host"]').click({ button: 'right' })
  await page.getByText('편집', { exact: false }).first().click()
  await page.locator('.mtabs').getByRole('button', { name: '고급' }).click()
  assert.equal(await page.getByRole('spinbutton', { name: '첫 재시도 대기 (초)', exact: true }).inputValue(), '5')
  await page.getByRole('button', { name: '앱 기본 규칙', exact: true }).click()
  assert.equal(await page.getByRole('spinbutton', { name: '첫 재시도 대기 (초)', exact: true }).isDisabled(), true)
  await page.getByRole('button', { name: '저장', exact: true }).click()
  await page.waitForSelector('.modal', { state: 'detached' })
  assert.equal((await call('store:get')).hosts[0].reconnectPolicy, undefined)

  // 앱 기본 규칙도 설정 화면에서 변경하고 다시 열었을 때 유지된다.
  await page.getByTitle(/^설정/).click()
  await page.locator('.settings nav').getByRole('button', { name: '연결', exact: true }).click()
  await page.getByRole('spinbutton', { name: '첫 재시도 대기 (초)', exact: true }).fill('6')
  await page.getByRole('button', { name: '배수 증가', exact: true }).click()
  await page.getByRole('spinbutton', { name: '매회 증가 배수', exact: true }).fill('3')
  await page.getByRole('spinbutton', { name: '최대 대기 (초)', exact: true }).fill('60')
  await page.getByRole('spinbutton', { name: '최대 재시도 횟수', exact: true }).fill('0')
  await page.keyboard.press('Escape')
  await page.waitForSelector('.modal', { state: 'detached' })
  const appSaved = (await call('store:get')).settings.reconnectPolicy
  assert.deepEqual([appSaved.initialDelaySec, appSaved.multiplier, appSaved.maxDelaySec, appSaved.maxAttempts], [6, 3, 60, 0])
  await page.getByTitle(/^설정/).click()
  await page.locator('.settings nav').getByRole('button', { name: '연결', exact: true }).click()
  assert.equal(await page.getByRole('spinbutton', { name: '첫 재시도 대기 (초)', exact: true }).inputValue(), '6')
  assert.equal(await page.getByRole('spinbutton', { name: '최대 재시도 횟수', exact: true }).inputValue(), '0')
  await page.keyboard.press('Escape')

  assert.deepEqual(errors, [])
  console.log('PASS: app/host combinations, custom delays, linear increase, retry exhaustion, success reset, inheritance, editor saves on/off/inherit')
} finally {
  if (app) await app.close().catch(() => {})
  for (const socket of sockets) socket.destroy()
  server.close()
  rmSync(data, { recursive: true, force: true })
}
