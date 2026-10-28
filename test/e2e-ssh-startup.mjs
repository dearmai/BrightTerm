// npm run build && node test/e2e-ssh-startup.mjs
// 데스크톱: 여러 줄 자동 실행 명령(한 줄씩·비밀번호 프롬프트에서 멈춤), SFTP 확인,
// SFTP 없는 서버는 SSH 명령(cat·ls)으로 파일 목록·업로드·다운로드, 명령 채널도 막히면 파일 버튼 흐리게
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ssh2 from 'ssh2'
import { _electron as electron } from 'playwright-core'

const PASSWORD = 'startup-test-secret'
const received = { tester: '', nosftp: '', blocked: '' }
const sentAt = { tester: [], nosftp: [], blocked: [] }
// nosftp 사용자의 '서버' 파일 — 명령은 이 폴더에서 진짜 sh 로 돈다
const remoteRoot = realpathSync(mkdtempSync(join(tmpdir(), 'bt-remote-')))
writeFileSync(join(remoteRoot, 'hello.txt'), 'hello from server\n')
const hostKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' })
const server = new ssh2.Server({ hostKeys: [hostKey] }, (client) => {
  let user = ''
  client.on('error', () => {})
  client.on('authentication', (ctx) => {
    user = ctx.username
    if (ctx.method === 'password' && ctx.password === PASSWORD && user in received) ctx.accept()
    else ctx.reject(['password'])
  })
  client.on('ready', () => client.on('session', (accept) => {
    const session = accept()
    session.on('pty', (ok) => ok())
    session.on('window-change', (ok) => ok?.())
    session.on('env', (ok) => ok?.())
    // 상태 표시줄 지표 등 보조 명령
    session.on('exec', (ok, reject, info) => {
      if (user === 'blocked') return reject()
      const s = ok()
      if (user !== 'nosftp') { s.exit(0); s.end(); return }
      const child = spawn('sh', ['-c', info.command], { cwd: remoteRoot })
      child.stdout.on('data', (d) => s.write(d))
      child.stderr.on('data', (d) => s.stderr.write(d))
      s.on('data', (d) => child.stdin.write(d))
      s.on('end', () => child.stdin.end())
      child.on('close', (code) => { s.exit(code ?? 1); s.end() })
    })
    session.on('sftp', (ok, reject) => (user === 'tester' ? ok() : reject()))
    session.on('shell', (ok) => {
      const stream = ok()
      stream.write('Welcome\r\n$ ')
      stream.on('data', (d) => {
        const text = d.toString()
        received[user] += text
        if (text.endsWith('\r')) sentAt[user].push(Date.now())
        stream.write(text.replace(/\r/g, '\r\n'))
        stream.write(text.includes('sudo -i') ? '[sudo] password for tester: ' : '$ ')
      })
    })
  }))
})
await new Promise((res) => server.listen(0, '127.0.0.1', res))
const port = server.address().port

const data = mkdtempSync(join(tmpdir(), 'bt-startup-'))
let app
try {
  app = await electron.launch({ args: ['.'], env: { ...process.env, BRIGHTTERM_DATA: data } })
  const page = await app.firstWindow()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.waitForSelector('.lock-card')
  await page.evaluate(async ({ port }) => {
    localStorage.setItem('bt.importOffered', '1')
    const store = await window.bt.call('store:get')
    const base = { groupId: null, protocol: 'ssh', host: '127.0.0.1', port, authType: 'ask', tags: [], encoding: 'utf-8', termType: 'xterm-256color', keepaliveSec: 0, forwards: [], persist: false }
    const hosts = [
      { ...base, id: 'startup', alias: 'Startup', username: 'tester', sort: 0, startupCommand: 'export LANG=ko_KR.UTF-8\n# 주석\n\ncd /tmp\nsudo -i\nwhoami' },
      { ...base, id: 'nosftp', alias: 'No SFTP', username: 'nosftp', sort: 1 },
      { ...base, id: 'blocked', alias: 'Blocked', username: 'blocked', sort: 2 }
    ]
    await window.bt.call('store:patch', { hosts, settings: { ...store.settings, checkUpdates: false } })
  }, { port })
  await page.reload()
  await page.waitForSelector('.lock-card')
  await page.fill('input[placeholder^="마스터 비밀번호"]', 'StartupTest!2026')
  await page.fill('input[placeholder="비밀번호 확인"]', 'StartupTest!2026')
  await page.click('button:has-text("볼트 만들기")')
  await page.waitForSelector('.recovery')
  await page.check('input[type=checkbox]')
  await page.click('button:has-text("시작하기")')
  await page.waitForSelector('.welcome')
  if (await page.$('.modal')) await page.keyboard.press('Escape')
  // WebGL 로 그려 DOM 에 글자가 없다 — 터미널로 가는 출력을 따로 모은다
  await page.evaluate(() => {
    window.__out = ''; window.__sessions = {}
    window.bt.on('session:data', (_id, d) => { window.__out += d })
    window.bt.on('session:state', (info) => { window.__sessions[info.title] = info })
  })

  // 탭마다 포커스된 패널이 있어 .pane.focused 는 보이는 것만 본다
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

  await connect('startup')
  const deadline = Date.now() + 15000
  while (!received.tester.includes('sudo -i\r') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
  await new Promise((r) => setTimeout(r, 1500))
  assert.equal(received.tester, 'export LANG=ko_KR.UTF-8\rcd /tmp\rsudo -i\r', 'lines sent one by one, comments skipped, stopped at the password prompt')
  for (let i = 1; i < sentAt.tester.length; i++) assert(sentAt.tester[i] - sentAt.tester[i - 1] >= 250, 'waits for the prompt between lines')
  await page.waitForFunction(() => window.__out.includes('1줄은 보내지 않았습니다'))
  await page.waitForFunction(() => { const b = [...document.querySelectorAll('.pane.focused button[title^="SFTP"]')].find((e) => e.offsetParent); return b && !b.disabled })

  // SFTP 없음 → SSH 명령으로: 버튼은 켜져 있고 패널에 안내, 목록·업로드·다운로드가 된다
  await connect('nosftp')
  await page.waitForFunction(() => window.__sessions['No SFTP']?.sftp === 'shell')
  const fileButton = page.locator('.pane.focused button[title^="파일 — SFTP 없이"]').filter({ visible: true })
  assert.equal(await fileButton.isDisabled(), false)
  await fileButton.click()
  await page.waitForSelector('.rpanel .notice.warn')
  await page.waitForFunction(() => document.querySelector('.rpanel')?.textContent.includes('hello.txt'))
  const sid = await page.evaluate(() => window.__sessions['No SFTP'].id)
  const localDir = mkdtempSync(join(tmpdir(), 'bt-local-'))
  const upload = join(localDir, 'upload 한글.bin')
  const bytes = Buffer.from(Array.from({ length: 300000 }, (_, i) => (i * 7) & 0xff))
  writeFileSync(upload, bytes)
  await page.evaluate(([sid, f, dir]) => window.bt.call('sftp:upload', sid, [f], dir), [sid, upload, remoteRoot])
  { const got = readFileSync(join(remoteRoot, 'upload 한글.bin')); assert(got.equals(bytes), `upload over exec channel: ${got.length}/${bytes.length}`) }
  const downDir = mkdtempSync(join(tmpdir(), 'bt-down-'))
  await page.evaluate(([sid, f, dir]) => window.bt.call('sftp:download', sid, [f], dir), [sid, join(remoteRoot, 'hello.txt'), downDir])
  assert.equal(readFileSync(join(downDir, 'hello.txt'), 'utf8'), 'hello from server\n', 'download over exec channel')
  const listed = await page.evaluate(([sid, dir]) => window.bt.call('sftp:list', sid, dir), [sid, remoteRoot])
  assert.equal(listed.entries.find((e) => e.name === 'upload 한글.bin')?.size, bytes.length)
  rmSync(localDir, { recursive: true, force: true }); rmSync(downDir, { recursive: true, force: true })
  assert.equal(received.nosftp, '', 'no startup command, nothing typed')

  // SFTP·명령 채널 모두 막힘 → 파일 버튼 흐리게
  await connect('blocked')
  await page.waitForFunction(() => [...document.querySelectorAll('.pane.focused button[title^="이 서버는 파일을"]')].find((e) => e.offsetParent)?.disabled === true)
  assert.deepEqual(errors, [])
  console.log('PASS: multi-line startup paced per prompt and stopped at password prompt, SFTP check, file list/upload/download over SSH commands without SFTP, file button dimmed when blocked')
} finally {
  if (app) {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {})
    await app.close().catch(() => {})
  }
  server.close()
  rmSync(remoteRoot, { recursive: true, force: true })
  rmSync(data, { recursive: true, force: true })
}
process.exit()
