// npm run build && node test/e2e-manual.mjs
// 우측 매뉴얼 탭: SSH 서버의 OS·쉘을 명령 채널로 확인해 맞는 문서를 먼저 보여 준다. 터미널에는 아무것도 입력하지 않는다.
// 실제 AIX 가 아니라 uname 결과를 흉내 내는 서버로 확인한다.
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ssh2 from 'ssh2'
import { _electron as electron } from 'playwright-core'

const PASSWORD = 'manual-test-secret'
const ENVS = {
  aix: 'BT_OS AIX\nBT_REL 3\nBT_VER 7\nBT_SHELL /usr/bin/ksh\n',
  linux: 'BT_OS Linux\nBT_REL 6.8.0\nBT_VER #1 SMP\nBT_SHELL /usr/bin/fish\n',
  rhel: 'BT_OS Linux\nBT_REL 6.12.0\nBT_VER #1 SMP\nBT_SHELL /usr/bin/zsh\nBT_DIST_NAME "Red Hat Enterprise Linux 10.2 (Coughlan)"\nBT_DIST_ID "rhel"\nBT_DIST_LIKE "centos fedora"\nBT_DIST_VER "10.2"\n',
  mute: ''
}
const typed = { aix: '', linux: '', rhel: '', mute: '' }
const hostKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' })
const server = new ssh2.Server({ hostKeys: [hostKey] }, (client) => {
  let user = ''
  client.on('error', () => {})
  client.on('authentication', (ctx) => {
    user = ctx.username
    if (ctx.method === 'password' && ctx.password === PASSWORD && user in ENVS) ctx.accept()
    else ctx.reject(['password'])
  })
  client.on('ready', () => client.on('session', (accept) => {
    const session = accept()
    session.on('pty', (ok) => ok())
    session.on('window-change', (ok) => ok?.())
    session.on('env', (ok) => ok?.())
    session.on('sftp', (_ok, reject) => reject())
    session.on('exec', (ok) => {
      const s = ok()
      let script = ''
      s.on('data', (d) => { script += d })
      s.on('end', () => {
        if (script.includes('BT_OS')) s.write(ENVS[user])
        s.exit(0)
        s.end()
      })
    })
    session.on('shell', (ok) => {
      const stream = ok()
      stream.write('$ ')
      stream.on('data', (d) => { typed[user] += d.toString() })
    })
  }))
})
await new Promise((res) => server.listen(0, '127.0.0.1', res))
const port = server.address().port

const data = mkdtempSync(join(tmpdir(), 'bt-manual-'))
let app
try {
  app = await electron.launch({ args: ['.', '--password-store=basic'], env: { ...process.env, BRIGHTTERM_DATA: data } })
  const page = await app.firstWindow()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.waitForSelector('.lock-card')
  await page.evaluate(async ({ port }) => {
    localStorage.setItem('bt.importOffered', '1')
    const store = await window.bt.call('store:get')
    const base = { groupId: null, protocol: 'ssh', host: '127.0.0.1', port, authType: 'ask', tags: [], encoding: 'utf-8', termType: 'xterm-256color', keepaliveSec: 0, forwards: [], persist: false }
    const hosts = [
      { ...base, id: 'aix', alias: 'AIX box', username: 'aix', sort: 0 },
      { ...base, id: 'linux', alias: 'Linux box', username: 'linux', sort: 1 },
      { ...base, id: 'mute', alias: 'Mute box', username: 'mute', sort: 2 },
      { ...base, id: 'rhel', alias: 'RHEL box', username: 'rhel', sort: 3 }
    ]
    await window.bt.call('store:patch', { hosts, settings: { ...store.settings, checkUpdates: false } })
  }, { port })
  await page.reload()
  await page.waitForSelector('.lock-card')
  await page.evaluate(() => window.bt.call('vault:setup', 'ManualTest!2026'))
  await page.evaluate(() => window.bt.call('vault:unlock', 'ManualTest!2026'))
  await page.waitForSelector('.welcome')
  await page.keyboard.press('Escape')

  const connect = async (id) => {
    await page.locator(`.sidebar [data-host="${id}"]`).dblclick()
    // 같은 서버 키는 처음 한 번만 묻는다
    const first = await Promise.race([
      page.waitForSelector('button:has-text("신뢰하고 접속")').then(() => 'hostkey'),
      page.waitForSelector('.modal input[type=password]').then(() => 'password')
    ])
    if (first === 'hostkey') await page.click('button:has-text("신뢰하고 접속")')
    await page.fill('.modal input[type=password]', PASSWORD)
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => [...document.querySelectorAll('.pane.focused .dot.connected')].some((e) => e.offsetParent))
  }
  const select = page.getByRole('combobox', { name: '매뉴얼 문서' })
  const status = page.locator('.mn-status')

  // 세션 없이도 문서를 볼 수 있다
  await page.evaluate(() => { document.querySelector('.titlebar button[title^="SFTP 패널"]').click() })
  await page.click('.rp-tab:has-text("매뉴얼")')
  await status.getByText('세션을 선택하면').waitFor()
  assert.deepEqual(await select.locator('option').allTextContents(), ['AIX 7.2 – 7.3', 'RHEL 9', 'RHEL 10', 'ksh (Korn shell)', 'bash', 'zsh'])

  // AIX + ksh: 감지 결과와 맞는 문서
  await connect('aix')
  await status.getByText('이 서버: AIX 7.3 · /usr/bin/ksh').waitFor()
  assert.deepEqual(await select.locator('option').allTextContents(), ['AIX 7.2 – 7.3 (이 서버)', 'ksh (Korn shell) (이 서버)', 'RHEL 9', 'RHEL 10', 'bash', 'zsh'])
  assert.equal(await select.inputValue(), 'aix')
  assert.equal(await page.locator('.mn-body details').first().getAttribute('open'), '')

  // 검색하면 찾은 절만 펼쳐서 보여 준다
  await page.fill('.mn-head input', 'errpt')
  await page.waitForFunction(() => document.querySelectorAll('.mn-body details').length === 2)
  assert.equal(await page.locator('.mn-body details:not([open])').count(), 0)
  await page.getByText('errpt -aj').first().waitFor()
  await page.fill('.mn-head input', '없는단어xyz')
  await page.locator('.mn-body .empty').waitFor()
  await page.fill('.mn-head input', '')

  // 문서를 고르면 이 세션에서는 유지된다
  await select.selectOption('ksh')
  await page.getByText('어떤 ksh인지 확인').waitFor()
  if (process.argv[2]) await page.screenshot({ path: process.argv[2] })

  // 코드 블록 복사
  await page.locator('.mn-code').first().hover()
  await page.locator('.mn-code button').first().click()
  await page.locator('.toast', { hasText: '복사했습니다' }).first().waitFor()
  assert.match(await app.evaluate(({ clipboard }) => clipboard.readText()), /echo \$SHELL/)

  // 매뉴얼이 없는 서버: 안내하고 다른 문서는 그대로 볼 수 있다
  await connect('linux')
  await status.getByText('이 서버: Linux 6.8.0 · /usr/bin/fish — 이 서버용 매뉴얼은 아직 없습니다').waitFor()
  assert.equal(await select.inputValue(), 'aix')

  // RHEL 10 + zsh: 배포판 이름을 보여 주고, 버전별 차이 뒤에 공통 절이 이어진다
  await connect('rhel')
  await status.getByText('이 서버: Red Hat Enterprise Linux 10.2 (Coughlan) · /usr/bin/zsh').waitFor()
  assert.deepEqual((await select.locator('option').allTextContents()).slice(0, 2), ['RHEL 10 (이 서버)', 'zsh (이 서버)'])
  assert.equal(await select.inputValue(), 'rhel10')
  const titles = await page.locator('.mn-body summary').allTextContents()
  assert.equal(titles[0], '먼저 알아둘 것')
  assert.ok(titles.includes('RHEL 10에서 달라진 점') && titles.includes('SELinux'), titles.join())
  assert.equal(titles.at(-1), '공식 문서')
  await select.selectOption('zsh')
  await page.getByText('bash와 다른 점').waitFor()
  await page.locator('.tab').nth(1).click()
  await select.selectOption('rhel9')
  await page.getByText('RHEL 9에서 달라진 점').waitFor()
  await select.selectOption('bash')
  await page.getByText('시작 파일·프롬프트').waitFor()
  await page.locator('.tab').last().click()

  // 감지 실패: 직접 고르도록 안내
  await connect('mute')
  await status.getByText('확인하지 못했습니다').waitFor()

  // 앞 세션으로 돌아오면 고른 문서가 남아 있다
  await page.locator('.tab').first().click()
  await status.getByText('이 서버: AIX 7.3').waitFor()
  assert.equal(await select.inputValue(), 'ksh')

  // 터미널에는 아무것도 입력하지 않았다
  assert.deepEqual(typed, { aix: '', linux: '', rhel: '', mute: '' })
  assert.deepEqual(errors, [])
  console.log('PASS: manual tab, OS/shell detection, doc selection, search, copy, no terminal input')
} finally {
  if (app) await app.close().catch(() => {})
  server.close()
  rmSync(data, { recursive: true, force: true })
}
