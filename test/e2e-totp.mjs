// npm run build && node test/e2e-totp.mjs
// TOTP 인증 — 설정에서 등록한 TOTP 로 SSH keyboard-interactive OTP 를 자동 입력한다.
//   1. 비밀번호(부분 성공) → keyboard-interactive 'Verification code:' 에 TOTP 자동 입력
//   2. 한 번에 'Password:' + 'Passcode:' 를 묻고, 다음 단계에서 'Company OTP:' — 서버의 TOTP 2개를 프롬프트 예시로 나눠 쓴다
//   3. 서버가 첫 코드를 거부하면 직접 입력 창을 띄운다
//   3c. 로그인 뒤 터미널에 나오는 OTP 프롬프트 — Enter 없이 / Enter 와 함께 / 끈 서버는 입력 안 함
//   4. 설정 → TOTP 인증 화면에서 코드가 보이고, 서버 편집에서 TOTP 를 고를 수 있다
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ssh2 from 'ssh2'
import { _electron as electron } from 'playwright-core'
import { closeApp } from './close-app.mjs'
import { base32Decode, totpAt } from '../src/main/totpCore.ts'

const PASSWORD = 'Totp-Test-Pw!1'
const MAIN = { secret: 'JBSWY3DPEHPK3PXP', meta: { digits: 6, period: 30, algorithm: 'SHA1' } }
const COMPANY = { secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', meta: { digits: 8, period: 30, algorithm: 'SHA256' } }
const valid = (t, code) => [-1, 0, 1].some((d) => totpAt(base32Decode(t.secret), t.meta, Date.now() + d * t.meta.period * 1000) === code)
const seen = { otp: [], combo: [], reject: [] }
let rejectedOnce = false
// 터미널 OTP — 사용자별로 셸에 들어온 입력
const typed = { term: '', term2: '', termoff: '' }

const hostKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' })
const server = new ssh2.Server({ hostKeys: [hostKey] }, (client) => {
  client.on('error', () => {})
  let passwordOk = false
  let user = ''
  client.on('authentication', (ctx) => {
    user = ctx.username
    if (user in typed) return ctx.method === 'password' && ctx.password === PASSWORD ? ctx.accept() : ctx.reject(['password'])
    if (user === 'otp') {
      // AuthenticationMethods password,keyboard-interactive
      if (ctx.method === 'password') {
        if (ctx.password !== PASSWORD) return ctx.reject(['password'])
        passwordOk = true
        return ctx.reject(['keyboard-interactive'], true)
      }
      if (ctx.method === 'keyboard-interactive' && passwordOk) {
        return ctx.prompt([{ prompt: 'Verification code: ', echo: false }], (ans) => {
          seen.otp.push(ans[0])
          valid(MAIN, ans[0]) ? ctx.accept() : ctx.reject()
        })
      }
      return ctx.reject(passwordOk ? ['keyboard-interactive'] : ['password'])
    }
    if (user === 'combo') {
      if (ctx.method !== 'keyboard-interactive') return ctx.reject(['keyboard-interactive'])
      return ctx.prompt([{ prompt: 'Password: ', echo: false }, { prompt: 'Passcode: ', echo: false }], (a) => {
        seen.combo.push(...a)
        if (a[0] !== PASSWORD || !valid(MAIN, a[1])) return ctx.reject()
        ctx.prompt([{ prompt: 'Company OTP: ', echo: true }], (b) => {
          seen.combo.push(...b)
          valid(COMPANY, b[0]) ? ctx.accept() : ctx.reject()
        })
      })
    }
    if (user === 'reject') {
      if (ctx.method !== 'keyboard-interactive') return ctx.reject(['keyboard-interactive'])
      const ask = () => ctx.prompt([{ prompt: 'OTP: ', echo: false }], (a) => {
        seen.reject.push(a[0])
        if (!rejectedOnce) { rejectedOnce = true; return ask() } // 첫 코드는 거부하고 다시 묻는다
        a[0] === '424242' ? ctx.accept() : ctx.reject()
      })
      return ask()
    }
    ctx.reject()
  })
  client.on('ready', () => client.on('session', (accept) => {
    const session = accept()
    session.on('pty', (ok) => ok())
    session.on('window-change', (ok) => ok?.())
    session.on('env', (ok) => ok?.())
    session.on('exec', (ok) => { const s = ok(); s.exit(0); s.end() })
    session.on('sftp', (_ok, reject) => reject())
    session.on('shell', (ok) => {
      const s = ok()
      if (!(user in typed)) { s.write('Welcome\r\n$ '); s.on('data', (d) => s.write(d)); return }
      // 셸의 2단계 인증 스크립트처럼 — 되울리지 않고 입력만 모은다
      s.on('data', (d) => { typed[user] += d.toString() })
      if (user === 'term2') {
        s.write('Bastion menu\r\n1) web\r\nSelect> ')
        setTimeout(() => s.write('1\r\n\x1b[1mToken code:\x1b[0m '), 800)
      } else {
        s.write('Welcome\r\n')
        setTimeout(() => s.write('OTP: '), 300)
      }
    })
  }))
})
await new Promise((res) => server.listen(0, '127.0.0.1', res))
const port = server.address().port

const data = mkdtempSync(join(tmpdir(), 'bt-totp-'))
let app, page
const errors = []
const call = (channel, ...args) => page.evaluate(({ channel, args }) => window.bt.call(channel, ...args), { channel, args })

const connect = async (id) => {
  await page.locator(`.sidebar [data-host="${id}"]`).dblclick()
}
const waitConnected = (title) => page.waitForFunction((t) => window.__sessions[t]?.state === 'connected', title, { timeout: 20000 })

try {
  app = await electron.launch({ args: ['.', '--password-store=basic'], env: { ...process.env, BRIGHTTERM_DATA: data } })
  page = await app.firstWindow()
  page.on('pageerror', (e) => errors.push(e.message))
  await page.waitForSelector('.lock-card')
  await page.evaluate(() => localStorage.setItem('bt.importOffered', '1'))
  await call('vault:setup', 'Totp!2026xx')
  await call('vault:unlock', 'Totp!2026xx')

  // 검증 실패해야 하는 입력
  await assert.rejects(call('totp:save', { name: 'bad', secret: 'not base32!' }), /Base32/)
  await assert.rejects(call('totp:save', { name: 'bad', secret: 'JBSWY3DPEHPK3PXP', digits: 5 }), /자릿수/)

  const main = await call('totp:save', { name: 'Main OTP', secret: 'jbsw y3dp ehpk 3pxp', purpose: 'server', issuer: 'Ops' })
  const company = await call('totp:save', { name: 'Company', secret: `otpauth://totp/ACME:alice?secret=${COMPANY.secret}&algorithm=SHA256&digits=8&period=30` })
  const app1 = await call('totp:save', { name: 'Web console', secret: MAIN.secret, purpose: 'app' })
  assert.deepEqual([company.totp.digits, company.totp.algorithm, company.totp.issuer, company.totp.account], [8, 'SHA256', 'ACME', 'alice'], 'otpauth URI 설정 반영')
  // TOTP 를 쓰는 볼트에는 버전 표시 — 모르는 앱은 업데이트를 안내한다
  const vaultFile = JSON.parse(readFileSync(join(data, 'vault.json'), 'utf8'))
  assert.deepEqual([vaultFile.version, vaultFile.features, vaultFile.minAppVersion], [1, ['totp'], '1.3.0'])
  const codes = await call('totp:codes')
  assert.equal(codes.length, 3)
  assert.ok(valid(MAIN, codes.find((c) => c.id === main.id).code), '메인에서 계산한 코드가 서버 계산과 같다')
  assert.ok(valid(COMPANY, codes.find((c) => c.id === company.id).code))
  // 비밀키를 비우고 수정하면 기존 키 유지
  await call('totp:save', { id: app1.id, name: 'Web console 2', purpose: 'app' })
  assert.equal((await call('cred:get', app1.id)).totpSecret, MAIN.secret)
  // 이름만 바꾸는 cred:save 도 TOTP 설정을 지우지 않는다
  await call('cred:save', { id: app1.id, name: 'Web console', kind: 'totp' })
  assert.equal((await call('cred:list')).find((c) => c.id === app1.id).totp.purpose, 'app')

  const pwCred = await call('cred:save', { name: 'pw', kind: 'password', username: 'otp', password: PASSWORD })
  const base = { groupId: null, protocol: 'ssh', host: '127.0.0.1', port, tags: [], encoding: 'utf-8', termType: 'xterm-256color', keepaliveSec: 0, forwards: [], persist: false }
  const store = await call('store:get')
  await call('store:patch', {
    settings: { ...store.settings, checkUpdates: false },
    knownHosts: [],
    hosts: [
      { ...base, id: 'otp', alias: 'OTP host', username: 'otp', authType: 'password', credentialId: pwCred.id, sort: 0, totp: { enabled: true, items: [{ id: main.id }] } },
      { ...base, id: 'combo', alias: 'Combo host', username: 'combo', authType: 'password', credentialId: pwCred.id, sort: 1,
        totp: { enabled: true, items: [{ id: company.id, prompt: 'Company OTP' }, { id: main.id }] } },
      { ...base, id: 'reject', alias: 'Reject host', username: 'reject', authType: 'ask', sort: 2, totp: { enabled: true, items: [{ id: main.id }] } },
      { ...base, id: 'plain', alias: 'Plain host', username: 'reject', authType: 'ask', sort: 3, totp: { enabled: false, items: [{ id: main.id }] } },
      { ...base, id: 'term', alias: 'Term host', username: 'term', authType: 'password', credentialId: pwCred.id, sort: 4, totp: { enabled: true, terminal: true, items: [{ id: main.id, enter: false }] } },
      { ...base, id: 'term2', alias: 'Term2 host', username: 'term2', authType: 'password', credentialId: pwCred.id, sort: 5, totp: { enabled: true, terminal: true, items: [{ id: company.id }] } },
      { ...base, id: 'termoff', alias: 'TermOff host', username: 'termoff', authType: 'password', credentialId: pwCred.id, sort: 6, totp: { enabled: true, items: [{ id: main.id }] } }
    ]
  })
  await page.reload()
  await page.waitForSelector('.welcome')
  if (await page.$('.modal')) await page.keyboard.press('Escape')
  await page.evaluate(() => {
    window.__out = ''; window.__sessions = {}
    window.bt.on('session:data', (_id, d) => { window.__out += d })
    window.bt.on('session:state', (info) => { window.__sessions[info.title] = info })
  })

  // 1) 비밀번호 → OTP 자동 입력
  await connect('otp')
  await page.click('button:has-text("신뢰하고 접속")')
  await waitConnected('OTP host')
  assert.equal(seen.otp.length, 1)
  assert.ok(valid(MAIN, seen.otp[0]))
  await page.waitForFunction(() => window.__out.includes('TOTP "Main OTP" 코드를 자동으로 입력했습니다'))
  assert.ok(!(await page.evaluate(() => window.__out)).includes(seen.otp[0]), 'OTP 코드는 터미널에 찍지 않는다')
  console.log('1. password + keyboard-interactive OTP auto-filled')

  // 2) 한 라운드에 비밀번호+OTP, 다음 라운드에 프롬프트 예시로 고른 다른 TOTP — 묻는 창 없이
  await connect('combo')
  await waitConnected('Combo host')
  assert.equal(seen.combo[0], PASSWORD)
  assert.ok(valid(MAIN, seen.combo[1]), 'Passcode 는 비밀번호가 아니라 TOTP')
  assert.equal(seen.combo[2].length, 8)
  assert.ok(valid(COMPANY, seen.combo[2]), 'Company OTP 는 프롬프트 예시를 적은 TOTP')
  console.log('2. password+passcode round, then per-prompt TOTP')

  // 3) 코드 거부 → 직접 입력 창
  await connect('reject')
  await page.waitForSelector('.modal input[type=password]')
  assert.equal(seen.reject.length, 1)
  assert.ok(valid(MAIN, seen.reject[0]), '처음에는 자동 입력')
  await page.fill('.modal input[type=password]', '424242')
  await page.keyboard.press('Enter')
  await waitConnected('Reject host')
  assert.equal(seen.reject[1], '424242')
  console.log('3. rejected code falls back to manual prompt')

  // 3b) TOTP 인증을 끈 서버는 자동 입력하지 않는다
  rejectedOnce = true
  const before = seen.reject.length
  await connect('plain')
  await page.waitForSelector('.modal input[type=password]')
  assert.equal(seen.reject.length, before, '꺼져 있으면 묻기만 한다')
  await page.fill('.modal input[type=password]', '424242')
  await page.keyboard.press('Enter')
  await waitConnected('Plain host')
  console.log('3b. disabled TOTP is not used')

  // 3c) 터미널 OTP 프롬프트
  const waitTyped = async (u, n) => { const end = Date.now() + 10000; while (typed[u].length < n && Date.now() < end) await new Promise((r) => setTimeout(r, 100)) }
  await connect('term')
  await waitConnected('Term host')
  await waitTyped('term', 6)
  await new Promise((r) => setTimeout(r, 800))
  assert.match(typed.term, /^\d{6}$/, `Enter 없이 코드만: ${JSON.stringify(typed.term)}`)
  assert.ok(valid(MAIN, typed.term))
  await connect('term2')
  await waitConnected('Term2 host')
  await waitTyped('term2', 9)
  await new Promise((r) => setTimeout(r, 800))
  assert.match(typed.term2, /^\d{8}\r$/, `'Select>' 에는 넣지 않고 'Token code:' 에 코드+Enter: ${JSON.stringify(typed.term2)}`)
  assert.ok(valid(COMPANY, typed.term2.slice(0, 8)))
  await connect('termoff')
  await waitConnected('TermOff host')
  await new Promise((r) => setTimeout(r, 1500))
  assert.equal(typed.termoff, '', '터미널 프롬프트 입력을 끈 서버')
  console.log('3c. terminal OTP prompt: no-Enter, Enter, off')

  // 4) 설정 화면
  await page.locator('button[title^="설정"]').first().click()
  await page.waitForSelector('.settings')
  await page.locator('.settings nav button', { hasText: 'TOTP 인증' }).click()
  await page.waitForSelector('.totp-code')
  assert.equal(await page.locator('.totp-row').count(), 3)
  const shown = (await page.locator('.totp-row', { hasText: 'Main OTP' }).locator('.totp-code .mono').innerText()).replace(/\s/g, '')
  assert.ok(valid(MAIN, shown), `설정 화면 코드 ${shown}`)
  await page.locator('.settings .seg button', { hasText: '앱·서비스' }).first().click()
  assert.equal(await page.locator('.totp-row').count(), 1, '용도 필터')
  await page.fill('input[placeholder^="프롬프트 확인"]', 'Enter your Verification code: ')
  await page.waitForSelector('.pill.ok:has-text("OTP 로 인식")')
  if (process.env.BT_SCREENSHOT) await page.screenshot({ path: process.env.BT_SCREENSHOT.replace(/\.png$/, '-settings.png') })
  await page.keyboard.press('Escape')
  await page.waitForSelector('.modal', { state: 'detached' })
  console.log('4. settings list, live code, purpose filter, prompt probe')

  // 5) 서버 편집 → 인증: 고른 TOTP 와 프롬프트 예시가 보이고, 저장해도 유지된다
  // 열린 탭이 있는 서버는 클릭하면 터미널로 포커스가 가서 F4 가 터미널로 간다 — 편집 버튼으로 연다
  await page.locator('.sidebar [data-host="combo"]').hover()
  await page.locator('.sidebar [data-host="combo"] button[title^="서버 편집"]').click()
  await page.locator('.mtabs button', { hasText: '인증' }).click()
  await page.waitForSelector('.totp-host-item')
  assert.equal(await page.locator('.totp-host-item').count(), 2)
  assert.equal(await page.locator('.totp-host-item input').first().inputValue(), 'Company OTP')
  // 두 줄 이상 설명은 "?" 팝업 — Esc 는 팝업만 닫고 편집 창은 그대로
  await page.getByRole('button', { name: '사용할 TOTP 도움말' }).click()
  await page.waitForSelector('.help-popup')
  assert.match(await page.locator('.help-popup').innerText(), /위에서부터 차례로/)
  await page.keyboard.press('Escape')
  await page.waitForSelector('.help-popup', { state: 'detached' })
  assert.ok(await page.$('.totp-host-item'), 'Esc 로 편집 창이 닫히지 않는다')
  // 앱용 TOTP 를 하나 더 고르고 순서를 올린다
  await page.locator('.modal select', { has: page.locator('option', { hasText: 'TOTP 선택' }) }).selectOption(app1.id)
  await page.locator('.modal button', { hasText: '추가' }).click()
  await page.locator('.totp-host-item').nth(2).locator('button[title="위로"]').click()
  if (process.env.BT_SCREENSHOT) await page.screenshot({ path: process.env.BT_SCREENSHOT.replace(/\.png$/, '-host.png') })
  await page.locator('.modal').getByRole('button', { name: '저장', exact: true }).first().click()
  await page.waitForSelector('.modal', { state: 'detached' })
  const saved = (await call('store:get')).hosts.find((h) => h.id === 'combo').totp
  assert.deepEqual(saved, { enabled: true, items: [{ id: company.id, prompt: 'Company OTP' }, { id: app1.id }, { id: main.id }] })
  console.log('5. host editor TOTP selection saved')

  // 6) TOTP 삭제하면 서버 목록에서도 빠진다 / 계정 목록에는 TOTP 가 섞이지 않는다
  await page.locator('button[title^="설정"]').first().click()
  await page.waitForSelector('.settings')
  await page.locator('.settings nav button', { hasText: '보안·계정' }).click()
  assert.ok(!(await page.locator('.s-body').innerText()).includes('Web console'), '저장된 계정에 TOTP 가 없다')
  await page.locator('.settings nav button', { hasText: 'TOTP 인증' }).click()
  await page.locator('.totp-row', { hasText: 'Web console' }).locator('button[title="삭제"]').click()
  await page.locator('.modal button', { hasText: '삭제' }).last().click()
  await page.waitForFunction(() => document.querySelectorAll('.totp-row').length === 2)
  const after = (await call('store:get')).hosts.find((h) => h.id === 'combo').totp.items.map((x) => x.id)
  assert.deepEqual(after, [company.id, main.id])
  console.log('6. delete removes host references')

  assert.deepEqual(errors, [])
  console.log('TOTP e2e passed')
} finally {
  await closeApp(app)
  server.close()
  rmSync(data, { recursive: true, force: true })
}
