// npm run build && node test/e2e-idle-guard.mjs
// 유휴 방지 명령: 가짜 셸(로컬 TCP)에 텔넷으로 붙어, 보내야 할 때와 보내면 안 될 때를 실제 앱으로 확인한다.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright-core'

const data = mkdtempSync(join(tmpdir(), 'bt-idle-'))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let socket = null
let received = ''
const server = createServer((s) => {
  socket = s
  s.on('error', () => {})
  s.on('data', (d) => { received += d.toString('latin1') })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))

const host = {
  id: 'idle-host', groupId: null, alias: 'Idle server', protocol: 'telnet', host: '127.0.0.1',
  port: server.address().port, username: '', authType: 'ask', tags: [], encoding: 'utf-8',
  termType: 'xterm-256color', keepaliveSec: 0, forwards: [], sort: 0, idleCommandSec: 1, idleCommand: 'date'
}

let app, page
const errors = []
const call = (channel, ...args) => page.evaluate(({ channel, args }) => window.bt.call(channel, ...args), { channel, args })

/** 서버가 output 을 보낸 뒤 wait 동안 앱이 보낸 내용 */
async function sentAfter(output, wait = 3000) {
  received = ''
  socket.write(output)
  await sleep(wait)
  return received
}

try {
  app = await electron.launch({ args: ['.', '--password-store=basic'], env: { ...process.env, BRIGHTTERM_DATA: data } })
  page = await app.firstWindow()
  page.on('pageerror', (e) => errors.push(e.message))
  await page.waitForSelector('.lock-card')
  const store = await call('store:get')
  await call('store:patch', { hosts: [host], settings: { ...store.settings, checkUpdates: false } })

  const info = await call('session:open', { hostId: host.id, cols: 80, rows: 24 })
  while (!socket) await sleep(50)
  await sleep(300)

  // 프롬프트면 보낸다
  assert.match(await sentAfter('user@aix72:/home/user $ '), /date\r/, 'prompt')
  assert.match(await sentAfter('\r\nviewer@eaiap01t [/eai/viewer] '), /date\r/, 'AIX PS1')
  // 대체 화면(vi)에서는 안 보낸다 — 화면에 프롬프트처럼 보이는 글자가 있어도
  assert.doesNotMatch(await sentAfter('\r\n\x1b[?1049hprice $ '), /date/, 'alt screen')
  // 빠져나오면 다시 보낸다
  assert.match(await sentAfter('\x1b[?1049l\r\n$ '), /date\r/, 'alt screen left')
  // 대체 화면 없는 vi: 커서를 옮긴 화면이면 안 보낸다
  assert.doesNotMatch(await sentAfter('\r\nprice $\x1b[24;1H'), /date/, 'cursor moved')
  // 다른 프로그램의 프롬프트에서는 안 보낸다
  assert.doesNotMatch(await sentAfter('\r\nSQL> '), /date/, 'not a shell')
  // 입력하던 줄이 있으면 안 보낸다
  await page.evaluate((id) => window.bt.write(id, 'rm -rf /tm'), info.id)
  assert.doesNotMatch(await sentAfter('\r\n$ rm -rf /tm$ '), /date/, 'open line')
  // Enter 를 친 뒤 프롬프트가 나오면 다시 보낸다
  await page.evaluate((id) => window.bt.write(id, '\r'), info.id)
  assert.match(await sentAfter('\r\n$ '), /date\r/, 'after enter')

  // 간격 전이라도 ksh 경고가 보이면 보낸다, 끄면 프롬프트든 경고든 보내지 않는다
  const current = await call('store:get')
  await call('store:patch', { hosts: [{ ...current.hosts[0], idleCommandSec: 3600 }] })
  assert.doesNotMatch(await sentAfter('\r\n$ '), /date/, 'interval not reached')
  assert.match(await sentAfter('\x07ksh: shell will time out in 60 seconds\r\n', 5000), /date\r/, 'ksh warning')
  await call('store:patch', { hosts: [{ ...current.hosts[0], idleCommandSec: undefined }] })
  assert.doesNotMatch(await sentAfter('\r\nksh: shell will time out in 60 seconds\r\n', 5000), /date/, 'turned off')

  await call('session:close', info.id)

  // 편집 창: 켜면 기본값(240초, date), 바꾼 값 저장, 끄면 값 없음
  await page.reload()
  await page.waitForSelector('.lock-card')
  await call('vault:setup', 'IdleGuardTest!2026')
  await call('vault:unlock', 'IdleGuardTest!2026')
  await page.waitForSelector('.welcome')
  await page.keyboard.press('Escape')
  const saved = async () => (await call('store:get')).hosts[0]
  const edit = async () => {
    await page.locator('.sidebar [data-host="idle-host"]').click({ button: 'right' })
    await page.getByText('편집', { exact: false }).first().click()
    await page.locator('.mtabs').getByRole('button', { name: '고급' }).click()
  }
  const box = () => page.locator('.persist-box').filter({ hasText: '유휴 방지 명령' })
  const save = async () => {
    await page.getByRole('button', { name: '저장', exact: true }).click()
    await page.waitForSelector('.modal', { state: 'detached' })
  }
  await edit()
  await box().locator('.switch').click()
  assert.equal(await box().locator('input').nth(0).inputValue(), '240')
  assert.equal(await box().locator('input').nth(1).inputValue(), 'date')
  if (process.env.BT_SCREENSHOT) await page.screenshot({ path: process.env.BT_SCREENSHOT })
  await box().locator('input').nth(0).fill('5')
  await box().locator('input').nth(1).fill('uptime')
  await box().locator('input').nth(1).focus()
  await save()
  assert.equal((await saved()).idleCommandSec, 10, '10초 미만은 10초로')
  assert.equal((await saved()).idleCommand, 'uptime')
  await edit()
  await box().locator('.switch').click()
  await save()
  assert.equal((await saved()).idleCommandSec, undefined)

  assert.deepEqual(errors, [])
  console.log('PASS: prompt, alt screen, moved cursor, other prompts, open line, ksh warning, off, editor')
} finally {
  if (app) await app.close().catch(() => {})
  socket?.destroy()
  server.close()
  rmSync(data, { recursive: true, force: true })
}
