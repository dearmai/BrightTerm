// npm run build && node test/e2e-connect-log.mjs
// 접속 상세 로그: 실제 ssh2 서버에 접속해 탭 메뉴에서 보고, 비밀번호와 입력 내용이 남지 않는지 확인한다.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright-core'
import ssh2 from 'ssh2'

const { Server, utils } = ssh2
const SECRET = 'never-in-the-log-9f3a'
const TYPED = 'typed-command-77c1'
const data = mkdtempSync(join(tmpdir(), 'bt-connectlog-'))
const hostKey = utils.generateKeyPairSync('ed25519').private
const hostBlob = utils.parseKey(hostKey).getPublicSSH()
let received = ''
const clients = new Set()
const server = new Server({ hostKeys: [hostKey] }, (client) => {
  clients.add(client)
  client.on('error', () => {})
  client.on('close', () => clients.delete(client))
  client.on('authentication', (ctx) => (ctx.method === 'password' && ctx.password === SECRET ? ctx.accept() : ctx.reject(['password'])))
  client.on('ready', () => client.on('session', (accept) => {
    const session = accept()
    session.on('pty', (a) => a?.())
    session.on('shell', (a) => {
      const stream = a()
      stream.write('$ ')
      stream.on('data', (d) => { received += d })
    })
    session.on('sftp', (_a, reject) => reject?.())
    session.on('exec', (_a, reject) => reject?.())
  }))
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

let app
try {
  app = await electron.launch({ args: ['.', '--password-store=basic'], env: { ...process.env, BRIGHTTERM_DATA: data } })
  const page = await app.firstWindow()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  const call = (channel, ...args) => page.evaluate(({ channel, args }) => window.bt.call(channel, ...args), { channel, args })
  await page.waitForSelector('.lock-card')
  await page.evaluate(() => localStorage.setItem('bt.importOffered', '1'))
  await call('vault:setup', 'ConnectLogTest!2026')
  await call('vault:unlock', 'ConnectLogTest!2026')
  const cred = await call('cred:save', { name: 'test', kind: 'password', username: 'tester', password: SECRET })
  const base = { groupId: null, protocol: 'ssh', host: '127.0.0.1', username: 'tester', authType: 'password', credentialId: cred.id, tags: [], encoding: 'utf-8', termType: 'xterm-256color', keepaliveSec: 0, forwards: [], sort: 0 }
  const store = await call('store:get')
  await call('store:patch', {
    hosts: [{ ...base, id: 'ok', alias: 'Good server', port }, { ...base, id: 'bad', alias: 'Refused server', port: 1 }],
    knownHosts: [{ hostPort: `127.0.0.1:${port}`, keyType: 'ssh-ed25519', fingerprint: 'SHA256:' + createHash('sha256').update(hostBlob).digest('base64').replace(/=+$/, ''), addedAt: 1 }],
    settings: { ...store.settings, checkUpdates: false, autoReconnect: false }
  })
  await page.reload()
  await page.waitForSelector('.welcome')
  await page.keyboard.press('Escape')

  const logFromMenu = async (tabTitle) => {
    await page.locator('.tab', { hasText: tabTitle }).click({ button: 'right' })
    await page.getByRole('button', { name: /^접속 상세 로그/ }).click()
    await page.locator('.connect-log').waitFor()
  }
  const logText = () => page.locator('.connect-log').innerText()

  // 정상 접속: 협상·인증 과정이 남고 비밀은 남지 않는다
  await page.locator('.sidebar [data-host="ok"]').dblclick()
  await page.waitForSelector('.pane .dot.connected')
  await page.locator('.pane-body').first().click()
  await page.keyboard.type(`${TYPED}\n`)
  for (let i = 0; i < 50 && !received.includes(TYPED); i++) await new Promise((r) => setTimeout(r, 100))
  assert.ok(received.includes(TYPED), '서버가 입력을 받아야 시험이 된다')
  await logFromMenu('Good server')
  await page.waitForFunction(() => /USERAUTH_SUCCESS/.test(document.querySelector('.connect-log')?.textContent ?? ''))
  const ok = await logText()
  for (const expected of [/Handshake: /, /USERAUTH_REQUEST \(password\)/, /USERAUTH_SUCCESS/, /상태: connected/, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}  /m]) assert.match(ok, expected)
  assert.ok(!ok.includes(SECRET), '비밀번호가 로그에 있다')
  assert.ok(!ok.includes(TYPED), '입력 내용이 로그에 있다')
  assert.doesNotMatch(ok, /CHANNEL_DATA/)

  // 열어 둔 채 끊기면 이어서 보인다
  for (const c of clients) c.end()
  await page.waitForFunction(() => /연결/.test((document.querySelector('.connect-log')?.textContent ?? '').split('상태: connected').pop()))
  await page.locator('.modal-foot .btn.primary', { hasText: '닫기' }).click()

  // 접속 실패: 터미널의 번역된 문구 말고 오류 원문이 남는다
  await page.locator('.sidebar [data-host="bad"]').dblclick()
  await page.locator('.tab', { hasText: 'Refused server' }).waitFor()
  await logFromMenu('Refused server')
  await page.waitForFunction(() => /오류 원문: .*ECONNREFUSED/.test(document.querySelector('.connect-log')?.textContent ?? ''))
  if (process.env.BT_SCREENSHOT) await page.screenshot({ path: process.env.BT_SCREENSHOT })
  await page.locator('.modal-foot .btn.primary', { hasText: '닫기' }).click()

  assert.deepEqual(errors, [])
  console.log('PASS: handshake logged, no secrets or typed input, live update, failure detail')
} finally {
  if (app) await app.close().catch(() => {})
  for (const c of clients) c.end()
  server.close()
  rmSync(data, { recursive: true, force: true })
}
