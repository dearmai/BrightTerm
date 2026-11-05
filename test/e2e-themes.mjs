// npm run build && node test/e2e-themes.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright-core'
const data = mkdtempSync(join(tmpdir(), 'bt-themes-'))
let app, page
const errors = []
const call = (channel, ...args) => page.evaluate(({ channel, args }) => window.bt.call(channel, ...args), { channel, args })
async function start() {
  app = await electron.launch({ args: ['.', '--password-store=basic'], env: { ...process.env, BRIGHTTERM_DATA: data } })
  page = await app.firstWindow()
  page.on('pageerror', e => errors.push(e.message))
  await page.waitForSelector('.lock-card')
}
async function stop() { await app.close(); app = null }
async function workspace(test) {
  const deadline = Date.now() + 15000
  while (!test((await call('store:get')).workspace)) {
    if (Date.now() > deadline) throw Error('Workspace was not saved')
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return (await call('store:get')).workspace
}
const openTabMenu = () => page.locator('.tab').first().click({ button: 'right' })
const openPaneMenu = (i) => page.locator('.pane-head').nth(i).click({ button: 'right' })
const closeMenu = () => page.keyboard.press('Escape')
/** 터미널 테마 2차 메뉴를 연다 */
async function openThemes() {
  await page.locator('.ctx button').filter({ hasText: '터미널 테마' }).hover()
  await page.locator('.ctx-sub').waitFor()
}
/** 메뉴에서 테마를 고른다. 기본값 항목은 '기본값 · 테마' 라 앞부분까지 맞춰 구분한다 */
async function pick(name) {
  await openThemes()
  await page.locator('.ctx-sub button').filter({ hasText: new RegExp(`^${name}`) }).click()
}
/** 2차 메뉴에서 체크 표시된 항목들 */
async function checked() {
  await openThemes()
  return page.locator('.ctx-sub button').filter({ has: page.locator('.sc', { hasText: '✓' }) }).allTextContents()
}
const termBg = (i) => page.locator('.pane').nth(i).evaluate(el => el.style.getPropertyValue('--term-bg'))
async function assertPaneChecked(i, pattern) {
  await openPaneMenu(i)
  const items = await checked()
  await closeMenu()
  assert.equal(items.length, 1, `pane ${i} checked: ${items}`)
  assert.match(items[0], pattern)
}
try {
  await start()
  await page.evaluate(() => localStorage.setItem('bt.importOffered', '1'))
  const store = await call('store:get')
  const host = { id: 'theme-host', groupId: null, alias: 'Theme server', protocol: 'local', host: '', port: 0,
    username: '', authType: 'ask', tags: [], encoding: 'utf-8', termType: 'xterm-256color',
    keepaliveSec: 0, forwards: [], local: { cwd: tmpdir() }, sort: 0, terminalTheme: 'BrightTerm Light' }
  await call('store:patch', { hosts: [host], settings: { ...store.settings, checkUpdates: false } })
  await page.reload()
  await page.waitForSelector('.lock-card')
  await call('vault:setup', 'ThemesTest!2026')
  await call('vault:unlock', 'ThemesTest!2026')
  await page.waitForSelector('.welcome')
  await page.keyboard.press('Escape')
  await page.locator('.sidebar [data-host="theme-host"]').dblclick()
  await page.waitForSelector('.pane .dot.connected')
  // 패널 머리말에는 테마 드롭다운이 없고, 탭 메뉴에서 고른다
  assert.equal(await page.locator('.pane-head select').count(), 0)
  await openPaneMenu(0)
  assert.equal(await page.locator('.ctx').getByText('터미널 테마').count(), 0, 'single pane menu has no theme items')
  await closeMenu()
  // 색상은 2차 메뉴: 1차 메뉴에 색 견본이 없고, 올리면 화면 안에 열리고, 다른 줄로 옮기면 닫힌다
  await openPaneMenu(0)
  assert.equal(await page.locator('.ctx .swatch').count(), 0, 'no swatches in the first level')
  await page.locator('.ctx button').filter({ hasText: '터미널 색상' }).hover()
  await page.locator('.ctx-sub .swatch').first().waitFor()
  const subBox = await page.locator('.ctx-sub').boundingBox()
  const view = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }))
  assert.ok(subBox.x >= 0 && subBox.y >= 0 && subBox.x + subBox.width <= view.w && subBox.y + subBox.height <= view.h, JSON.stringify({ subBox, view }))
  await page.locator('.ctx button').filter({ hasText: '찾기' }).hover()
  await page.locator('.ctx-sub').waitFor({ state: 'detached' })
  // 2차 메뉴의 색을 누르면 적용되고 메뉴가 닫힌다
  await page.locator('.ctx button').filter({ hasText: '터미널 색상' }).click()
  await page.locator('.ctx-sub .swatch:not(.none)').first().click()
  await page.locator('.ctx').first().waitFor({ state: 'detached' })
  await workspace(w => !!w?.tabs[0]?.root.color)
  await openPaneMenu(0)
  await page.locator('.ctx button').filter({ hasText: '터미널 색상' }).click()
  await page.locator('.ctx-sub .swatch.none').click()
  await workspace(w => !w?.tabs[0]?.root.color)
  await openTabMenu()
  assert.equal(await page.locator('.ctx .swatch').count(), 0, 'no swatches in the tab menu first level')
  if (process.env.BT_SCREENSHOT) {
    await page.locator('.ctx button').filter({ hasText: '터미널 테마' }).hover()
    await page.locator('.ctx-sub').waitFor()
    await page.waitForTimeout(200)
    await page.screenshot({ path: process.env.BT_SCREENSHOT })
  }
  assert.match((await checked())[0], /기본값 · BrightTerm Light/)
  await pick('Nord')
  await workspace(w => w?.tabs[0]?.root.terminalTheme === 'Nord')
  assert.equal(await termBg(0), '#2e3440')
  await openTabMenu()
  assert.match((await checked())[0], /^Nord/)
  await pick('기본값')
  await workspace(w => w?.tabs[0]?.root.type === 'pane' && !w.tabs[0].root.terminalTheme)
  assert.equal(await termBg(0), '#ffffff')
  // 분할하면 패널 메뉴에서 패널별로 고른다
  await page.locator('.pane button[title^="오른쪽으로 분할"]').click()
  await page.waitForFunction(() => document.querySelectorAll('.pane').length === 2)
  await openPaneMenu(0)
  await pick('Solarized Dark')
  await workspace(w => w?.tabs[0]?.root.children?.[0]?.terminalTheme === 'Solarized Dark')
  await assertPaneChecked(1, /기본값 · BrightTerm Light/)
  assert.equal((await call('store:get')).hosts[0].terminalTheme, 'BrightTerm Light')
  // 패널들의 값이 다르면 탭 메뉴에는 체크가 없다
  await openTabMenu()
  await page.locator('.ctx').getByText('터미널 테마 (모든 패널)').waitFor()
  assert.deepEqual(await checked(), [])
  await closeMenu()
  // Global theme changes must leave both the override and host default intact.
  const current = await call('store:get')
  await call('store:patch', { settings: { ...current.settings, terminalTheme: 'BrightTerm Dark' } })
  await page.reload()
  await page.waitForFunction(() => document.querySelectorAll('.pane').length === 2)
  await assertPaneChecked(0, /^Solarized Dark/)
  await assertPaneChecked(1, /BrightTerm Light/)
  assert.equal(await termBg(0), '#002b36')
  assert.equal(await termBg(1), '#ffffff')
  const font = await page.locator('.statusbar').evaluate(el => el.style.fontFamily)
  assert.match(font, /^"?D2Coding ligature"?, D2Coding,/)
  assert.match((await call('store:get')).settings.fontFamily, /^'D2Coding ligature', 'D2Coding',/)
  await stop()
  await start()
  await call('vault:unlock', 'ThemesTest!2026')
  await page.waitForFunction(() => document.querySelectorAll('.pane').length === 2)
  await assertPaneChecked(0, /^Solarized Dark/)
  await openPaneMenu(0)
  await pick('기본값')
  await assertPaneChecked(0, /BrightTerm Light/)
  // 탭 메뉴에서 고르면 모든 패널에 적용되고, 기본값으로 모두 되돌린다
  await openTabMenu()
  await pick('Monokai')
  await workspace(w => w?.tabs[0]?.root.children?.every(c => c.terminalTheme === 'Monokai'))
  assert.equal(await termBg(0), '#272822')
  assert.equal(await termBg(1), '#272822')
  await openTabMenu()
  assert.match((await checked())[0], /^Monokai/)
  await pick('기본값')
  await workspace(w => w?.tabs[0]?.root.children?.every(c => !c.terminalTheme))
  assert.equal(await termBg(0), '#ffffff')
  assert.equal(await termBg(1), '#ffffff')
  await openPaneMenu(0)
  await pick('Solarized Dark')
  await page.locator('.pane').nth(0).getByTitle('닫기', { exact: true }).click()
  if (await page.locator('.confirm').count()) await page.getByRole('button', { name: '닫기', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('.pane').length === 1)
  await workspace(w => w?.tabs[0]?.root.type === 'pane' && !w.tabs[0].root.terminalTheme)
  await page.locator('.pane button[title^="오른쪽으로 분할"]').click()
  await page.waitForFunction(() => document.querySelectorAll('.pane').length === 2)
  await assertPaneChecked(1, /기본값/)
  await page.screenshot({ path: join(tmpdir(), 'brightterm-themes.png') })
  assert.deepEqual(errors, [])
  console.log('PASS: tab menu theme, per-pane overrides, host defaults, reload/restart persistence, reset/close, status font')
} finally {
  if (app) await stop().catch(() => {})
  rmSync(data, { recursive: true, force: true })
}
