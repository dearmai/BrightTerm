// npm run build && node test/e2e-session-log.mjs
// 세션 로그: 앱 기본은 끄고 서버 하나만 켜서(고급 설정으로 다른 폴더·시각 기록) 실제 ssh2 서버에 접속한다.
// 켠 서버만 지정한 폴더에 제어 코드 없이 기록되는지, 앱 설정을 따르는 서버는 기록되지 않는지, 설정 화면이 열리는지 확인한다.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright-core'
import ssh2 from 'ssh2'

const { Server, utils } = ssh2
const SECRET = 'session-log-pw-4b1e'
const data = mkdtempSync(join(tmpdir(), 'bt-sessionlog-e2e-'))
const custom = join(data, 'custom-logs')
const hostKey = utils.generateKeyPairSync('ed25519').private
const hostBlob = utils.parseKey(hostKey).getPublicSSH()
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
      stream.write('\x1b[32mwelcome-marker\x1b[0m\r\n$ ')
      stream.on('data', (d) => stream.write(d))
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
  await call('vault:setup', 'SessionLogTest!2026')
  await call('vault:unlock', 'SessionLogTest!2026')
  const cred = await call('cred:save', { name: 'test', kind: 'password', username: 'tester', password: SECRET })
  const base = { groupId: null, protocol: 'ssh', host: '127.0.0.1', port, username: 'tester', authType: 'password', credentialId: cred.id, tags: [], encoding: 'utf-8', termType: 'xterm-256color', keepaliveSec: 0, forwards: [], sort: 0 }
  const store = await call('store:get')
  assert.equal(store.settings.sessionLog, false)
  assert.equal(store.settings.sessionLogOptions.maxSizeMB, 10, '기본 로그 규칙이 채워져 있다')
  await call('store:patch', {
    hosts: [
      { ...base, id: 'logged', alias: 'Logged server', sessionLog: true, sessionLogOptions: { ...store.settings.sessionLogOptions, dir: custom, timestamp: true } },
      { ...base, id: 'plain', alias: 'Plain server' }
    ],
    knownHosts: [{ hostPort: `127.0.0.1:${port}`, keyType: 'ssh-ed25519', fingerprint: 'SHA256:' + createHash('sha256').update(hostBlob).digest('base64').replace(/=+$/, ''), addedAt: 1 }],
    settings: { ...store.settings, checkUpdates: false, autoReconnect: false }
  })
  await page.reload()
  await page.waitForSelector('.welcome')
  await page.keyboard.press('Escape')

  for (const id of ['logged', 'plain']) {
    await page.locator(`.sidebar [data-host="${id}"]`).dblclick()
    await page.waitForFunction((n) => document.querySelectorAll('.pane .dot.connected').length >= n, id === 'logged' ? 1 : 2)
  }
  await page.locator('.pane-body').last().click()
  await page.keyboard.type('echo-typed-line\n')
  await new Promise((r) => setTimeout(r, 500))
  for (const c of clients) c.end()
  await page.waitForFunction(() => document.querySelectorAll('.pane .dot.connected').length === 0)

  const files = existsSync(custom) ? readdirSync(custom) : []
  assert.equal(files.length, 1, `서버별 폴더에 로그 1개: ${files}`)
  assert.match(files[0], /^Logged server_\d{8}-\d{6}\.log$/)
  const text = readFileSync(join(custom, files[0]), 'utf8')
  assert.match(text, /^=== BrightTerm 세션 로그 · Logged server \(tester@127\.0\.0\.1:\d+\) · /)
  assert.match(text, /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] welcome-marker$/m)
  assert.ok(!text.includes('\x1b'), '제어 코드가 빠져 있다')
  assert.ok(!text.includes(SECRET))
  const defaults = join(data, 'logs')
  assert.deepEqual(existsSync(defaults) ? readdirSync(defaults) : [], [], '앱 설정(꺼짐)을 따르는 서버는 기록하지 않는다')

  // 설정 화면: 세션 로그 섹션과 서버 편집 고급 탭
  await page.locator('.titlebar button[title^="설정"]').click()
  await page.getByRole('button', { name: '세션 로그' }).click()
  await page.getByText('기본 로그 규칙').waitFor()
  await page.getByText('파일 최대 크기 (MB)').waitFor()
  if (process.env.BT_SCREENSHOT) await page.screenshot({ path: process.env.BT_SCREENSHOT.replace(/\.png$/, '-settings.png') })
  await page.keyboard.press('Escape')
  await page.locator('.sidebar [data-host="logged"]').click()
  await page.keyboard.press('F2')
  await page.locator('.mtabs button', { hasText: '고급' }).click()
  await page.getByText('로그 고급 설정').scrollIntoViewIfNeeded()
  assert.equal(await page.getByLabel('저장 폴더').inputValue(), custom)
  if (process.env.BT_SCREENSHOT) await page.screenshot({ path: process.env.BT_SCREENSHOT.replace(/\.png$/, '-host.png') })

  assert.deepEqual(errors, [])
  console.log('PASS: per-server log on with custom folder/timestamps, app-default server not logged, settings UI renders')
} finally {
  if (app) await app.close().catch(() => {})
  for (const c of clients) c.end()
  server.close()
  rmSync(data, { recursive: true, force: true })
}
