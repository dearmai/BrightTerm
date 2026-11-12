// npm run build && node test/e2e-rdp-ui.mjs
// 서버 편집의 OS·원격 데스크톱 설정과 서버 목록의 RDP 연결 메뉴.
//   - OS 를 Windows 로 고르면 원격 데스크톱 탭이 생기고, 열면 RDP 허용 상태를 확인한다(podman xrdp)
//   - 클립보드·연결 방식·RDP 전용 비밀번호(볼트)·기본 연결을 RDP 로 — 저장 후 값 확인
//   - 우클릭 메뉴: 원격 데스크톱(RDP) 연결 / RDP 허용 상태 확인 / 터미널로 연결, 확인 결과 배지
//   - 기본 연결이 RDP 면 더블클릭이 RDP 창을 연다
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright-core'
import { closeApp } from './close-app.mjs'

const NAME = 'bt-rdp-ui'
const PORT = 13392
const data = mkdtempSync(join(tmpdir(), 'bt-rdp-ui-'))
const shotDir = process.env.BT_SHOTS || data
const podman = (...a) => execFileSync('podman', a, { encoding: 'utf8' }).trim()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let app, page
const errors = []
/** 앱 프로세스의 macOS 시스템 단축키 모드(0 켬 / 1 끔)와 창 포커스 */
const hotkeyMode = ({ app, BrowserWindow }) => {
  const koffi = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/')('koffi')
  const lib = koffi.load('/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices')
  const conn = lib.func('int _CGSDefaultConnection()')
  const get = lib.func('int CGSGetGlobalHotKeyOperatingMode(int, _Out_ int *)')
  const m = [0]
  get(conn(), m)
  return { mode: m[0], focused: BrowserWindow.getAllWindows().some((w) => w.isFocused()) }
}
const call = (channel, ...args) => page.evaluate(({ channel, args }) => window.bt.call(channel, ...args), { channel, args })

try {
  try { podman('rm', '-f', NAME) } catch { /* */ }
  podman('run', '-d', '--name', NAME, '-p', `${PORT}:3389`, '--shm-size=1g', 'docker.io/scottyhardy/docker-remote-desktop:latest')
  app = await electron.launch({ args: ['.', '--password-store=basic'], env: { ...process.env, BRIGHTTERM_DATA: data } })
  page = await app.firstWindow()
  page.on('pageerror', (e) => errors.push(e.message))
  await page.waitForSelector('.lock-card')
  await page.evaluate(() => localStorage.setItem('bt.importOffered', '1'))
  await call('vault:setup', 'RdpUi!2026')
  await call('vault:unlock', 'RdpUi!2026')
  const store = await call('store:get')
  await call('store:patch', { settings: { ...store.settings, checkUpdates: false } })
  // xrdp 가 뜰 때까지
  for (let i = 0; i < 60; i++) {
    const r = await call('rdp:check', { id: 'p', host: '127.0.0.1', protocol: 'ssh', port: 22, rdp: { port: PORT } })
    if (r.state === 'ok') break
    await sleep(1000)
  }
  await page.reload()
  await page.waitForSelector('.welcome')

  // 1) 새 서버 — OS 를 고르기 전에는 원격 데스크톱 탭이 없다
  await page.getByRole('button', { name: '새 서버 등록' }).click()
  await page.waitForSelector('.modal')
  assert.equal(await page.locator('.mtabs button', { hasText: '원격 데스크톱' }).count(), 0)
  await page.getByPlaceholder('예: 운영-WEB01').fill('윈도우 서버')
  await page.getByPlaceholder('10.0.0.11  또는  user@host:22').fill('127.0.0.1')
  await page.locator('.field', { hasText: '사용자 이름' }).first().locator('input').fill('ubuntu')
  await page.locator('.field', { hasText: '서버 OS' }).getByRole('button', { name: 'Windows' }).click()
  await page.screenshot({ path: join(shotDir, 'rdp-ui-basic.png') })

  // 2) 원격 데스크톱 탭 — 포트를 바꾸고 확인
  await page.locator('.mtabs button', { hasText: '원격 데스크톱' }).click()
  await page.locator('.field', { hasText: 'RDP 포트' }).locator('input').fill(String(PORT))
  await page.getByRole('button', { name: 'RDP 허용 상태 확인' }).click()
  await page.waitForSelector('.rdp-check >> text=RDP 허용됨', { timeout: 20000 })
  assert.match(await page.locator('.rdp-check').innerText(), /TLS/)
  // 클립보드 끄기, RDP 전용 비밀번호, 기본 연결을 RDP 로
  await page.locator('.toggle', { hasText: '클립보드 동기화' }).locator('.switch').click()
  await page.locator('.field', { hasText: 'RDP 비밀번호' }).getByRole('button', { name: 'RDP 전용' }).click()
  await page.getByLabel('RDP 비밀번호', { exact: true }).fill('ubuntu')
  await page.locator('.toggle', { hasText: '기본 연결을 RDP 로' }).locator('.switch').click()
  await page.screenshot({ path: join(shotDir, 'rdp-ui-tab.png') })
  await page.locator('.modal').getByRole('button', { name: '저장', exact: true }).click()
  await page.waitForSelector('.modal', { state: 'detached' })

  const saved = (await call('store:get')).hosts.find((h) => h.alias === '윈도우 서버')
  assert.equal(saved.os, 'windows')
  assert.equal(saved.rdp.port, PORT)
  assert.equal(saved.rdp.clipboard, false)
  assert.equal(saved.rdp.auth, 'own')
  assert.equal(saved.rdp.primary, true)
  assert.equal(saved.rdp.mode, 'builtin')
  const secret = await call('cred:get', saved.rdp.credentialId)
  assert.equal(secret.password, 'ubuntu')
  assert.notEqual(saved.rdp.credentialId, saved.credentialId)

  // 3) 우클릭 메뉴 — RDP 항목, 허용 상태 확인 → 배지 색
  const row = page.locator(`.sidebar [data-host="${saved.id}"]`)
  await row.click({ button: 'right' })
  for (const label of ['원격 데스크톱(RDP) 연결', 'RDP 허용 상태 확인', '터미널로 연결']) assert.equal(await page.locator('.ctx', { hasText: label }).count() > 0, true, label)
  await page.screenshot({ path: join(shotDir, 'rdp-ui-menu.png') })
  await page.locator('.ctx').getByText('RDP 허용 상태 확인').click()
  await page.waitForSelector(`.sidebar [data-host="${saved.id}"] .n-rdp.rdp-ok`, { timeout: 20000 })

  // 4) 더블클릭 → 인증서 신뢰 → 이 창의 탭(기본), 클립보드 꺼짐 표시
  assert.equal((saved.rdp.openIn ?? 'tab'), 'tab')
  await row.dblclick()
  await page.getByRole('button', { name: '신뢰하고 접속' }).click()
  const view = page.locator('.tab-view:not(.hidden) .rdp-app.in-tab')
  await view.locator('.rdp-bar .dot.connected').waitFor({ timeout: 60000 })
  assert.equal(await view.locator('.rdp-clip').getAttribute('title'), '클립보드 동기화 꺼짐 — 누르면 켭니다')
  assert.ok(!app.windows().some((x) => x.url().includes('rdp.html')), '탭으로 열어야 하는데 별도 창이 열렸습니다')
  await page.waitForSelector('.tabs .tab.active .dot.connected', { timeout: 5000 })
  assert.equal(await page.locator('.tabs .tab.active .tab-title').innerText(), '윈도우 서버')
  // 원격 화면이 그려졌는지 — 캔버스에 검지 않은 픽셀
  let painted = 0
  for (let i = 0; i < 20 && painted < 50; i++) {
    await sleep(500)
    painted = await view.evaluate((el) => {
      const c = el.querySelector('iron-remote-desktop')?.shadowRoot?.querySelector('canvas') ?? el.querySelector('canvas')
      if (!c || !c.width) return 0
      const x = document.createElement('canvas'); x.width = 64; x.height = 64
      const g = x.getContext('2d'); g.drawImage(c, 0, 0, 64, 64)
      const d = g.getImageData(0, 0, 64, 64).data
      let n = 0
      for (let j = 0; j < d.length; j += 4) if (d[j] + d[j + 1] + d[j + 2] > 30) n++
      return n
    })
  }
  assert.ok(painted >= 50, `원격 화면이 그려지지 않았습니다 (${painted})`)
  // 탭 영역을 꽉 채운다
  const [vw, tw] = await page.evaluate(() => [document.querySelector('.rdp-app.in-tab').getBoundingClientRect().width, document.querySelector('.tab-view:not(.hidden)').getBoundingClientRect().width])
  assert.ok(vw > tw - 20, `원격 데스크톱 탭 너비 ${vw} / ${tw}`)
  await page.screenshot({ path: join(shotDir, 'rdp-ui-in-tab.png') })

  // 원격 화면에 포커스 → 모든 키를 원격으로: 앱 단축키(⌘K 새 연결)가 동작하지 않고, 막대를 누르면 돌아온다
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  await view.locator('iron-remote-desktop').click({ position: { x: 300, y: 300 } })
  await view.locator('.rdp-capture').waitFor({ timeout: 5000 })
  if (process.platform === 'darwin') {
    const hot = await app.evaluate(hotkeyMode)
    console.log('macOS 시스템 단축키:', hot)
    // 창이 앞에 있으면 시스템 단축키(⌘Tab·⌘Space …)를 끈다(mode 1)
    if (hot.focused) assert.equal(hot.mode, 1, '창이 앞에 있는데 시스템 단축키를 끄지 않았습니다')
  }
  await page.keyboard.press(`${mod}+KeyK`)
  await sleep(600)
  assert.equal(await page.locator('.modal').count(), 0, '원격 입력 중인데 앱 단축키가 동작했습니다')
  await view.locator('.rdp-title').click()
  await view.locator('.rdp-capture').waitFor({ state: 'detached', timeout: 5000 })
  if (process.platform === 'darwin') assert.equal((await app.evaluate(hotkeyMode)).mode, 0, '포커스가 빠졌는데 시스템 단축키가 꺼져 있습니다')
  await page.keyboard.press(`${mod}+KeyK`)
  await page.waitForSelector('.modal', { timeout: 5000 })
  await page.keyboard.press('Escape')
  await page.waitForSelector('.modal', { state: 'detached', timeout: 5000 })

  // 패널 분할·옮기기 메뉴는 원격 데스크톱 탭에 쓰이지 않는다 — 터미널 탭 하나를 열고 돌아와도 연결 유지
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', code: 'KeyD', metaKey: navigator.platform.startsWith('Mac'), ctrlKey: !navigator.platform.startsWith('Mac'), shiftKey: true })))
  await sleep(500)
  assert.equal(await page.locator('.tabs .tab').count(), 1)
  assert.equal(await page.locator('.pane').count(), 0, '원격 데스크톱 탭이 분할됐습니다')

  // 탭 우클릭 메뉴
  await page.locator('.tabs .tab.active').click({ button: 'right' })
  for (const label of ['같은 서버를 별도 창으로 열기', '터미널로 연결', '탭 닫기']) assert.ok(await page.locator('.ctx', { hasText: label }).count() > 0, label)
  assert.equal(await page.locator('.ctx', { hasText: '패널을 각각 탭으로 분리' }).count(), 0)
  await page.keyboard.press('Escape')

  // 탭 닫기 → 확인 → 닫기, 탭이 없어지고 연결 정리
  await page.locator('.tabs .tab.active .tab-close').click()
  await page.waitForSelector('text=원격 데스크톱 연결을 끊고 닫을까요?', { timeout: 5000 })
  await page.getByRole('button', { name: '닫기', exact: true }).click()
  await page.waitForSelector('.rdp-app', { state: 'detached', timeout: 5000 })
  assert.equal(await page.locator('.tabs .tab').count(), 0)

  // 5) 별도 창으로 — 두 번째 연결은 인증서를 다시 묻지 않는다
  const winP2 = app.waitForEvent('window', { predicate: (x) => x.url().includes('rdp.html'), timeout: 30000 })
  await row.click({ button: 'right' })
  await page.locator('.ctx').getByText('원격 데스크톱을 별도 창으로 열기').click()
  const w2 = await winP2
  w2.on('pageerror', (e) => errors.push(`rdp: ${e.message}`))
  await w2.waitForSelector('.rdp-bar .dot.connected', { timeout: 60000 })
  assert.equal(await page.getByRole('button', { name: '신뢰하고 접속' }).count(), 0)
  assert.equal(await page.locator('.tabs .tab').count(), 0)
  // 닫기 확인 → 닫기
  await w2.evaluate(() => window.close())
  await w2.waitForSelector('.rdp-overlay >> text=창을 닫을까요', { timeout: 5000 })
  const closed = new Promise((r) => w2.once('close', r))
  await w2.getByRole('button', { name: '닫기', exact: true }).click()
  await Promise.race([closed, sleep(8000)])
  assert.ok(!app.windows().some((x) => x.url().includes('rdp.html')), 'RDP 창이 닫히지 않았습니다')

  // 6) 탭으로 다시 열고 메인 창을 새로 고치면 탭 연결이 정리된다(다시 열어도 정상)
  await call('rdp:open', saved.id, 'tab')
  await page.reload()
  await page.waitForSelector('.welcome')
  await row.dblclick()
  await page.locator('.tab-view:not(.hidden) .rdp-app.in-tab .rdp-bar .dot.connected').waitFor({ timeout: 60000 })
  await page.locator('.tabs .tab.active').click({ button: 'middle' })
  await page.getByRole('button', { name: '닫기', exact: true }).click()
  await page.waitForSelector('.rdp-app', { state: 'detached', timeout: 5000 })

  assert.deepEqual(errors, [])
  console.log('e2e-rdp-ui OK')
} catch (e) {
  console.error(e)
  console.error('page errors:', errors)
  await page?.screenshot({ path: join(shotDir, 'rdp-ui-fail.png') }).catch(() => {})
  process.exitCode = 1
} finally {
  await closeApp(app)
  try { podman('rm', '-f', NAME) } catch { /* */ }
  if (!process.env.BT_SHOTS) rmSync(data, { recursive: true, force: true })
}
