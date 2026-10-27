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
try {
  await start()
  await page.evaluate(() => localStorage.setItem('bt.importOffered', '1'))
  const store = await call('store:get')
  const host = { id: 'theme-host', groupId: null, alias: 'Theme server', protocol: 'local', host: '', port: 0,
    username: '', authType: 'ask', tags: [], encoding: 'utf-8', termType: 'xterm-256color',
    keepaliveSec: 0, forwards: [], local: { cwd: '/tmp' }, sort: 0, terminalTheme: 'BrightTerm Light' }
  await call('store:patch', { hosts: [host], settings: { ...store.settings, checkUpdates: false } })
  await page.reload()
  await page.waitForSelector('.lock-card')
  await call('vault:setup', 'ThemesTest!2026')
  await call('vault:unlock', 'ThemesTest!2026')
  await page.waitForSelector('.welcome')
  await page.keyboard.press('Escape')
  await page.locator('.sidebar [data-host="theme-host"]').dblclick()
  await page.waitForSelector('.pane .dot.connected')
  const selectors = () => page.getByRole('combobox', { name: '패널 터미널 테마' })
  assert.match(await selectors().locator('option:checked').textContent(), /기본값 · BrightTerm Light/)
  await page.locator('.pane button[title^="오른쪽으로 분할"]').click()
  await page.waitForFunction(() => document.querySelectorAll('.pane').length === 2)
  await selectors().nth(0).selectOption('Solarized Dark')
  await workspace(w => w?.tabs[0]?.root.children?.[0]?.terminalTheme === 'Solarized Dark')
  assert.equal(await selectors().nth(1).inputValue(), '')
  assert.equal((await call('store:get')).hosts[0].terminalTheme, 'BrightTerm Light')
  // Global theme changes must leave both the override and host default intact.
  const current = await call('store:get')
  await call('store:patch', { settings: { ...current.settings, terminalTheme: 'BrightTerm Dark' } })
  await page.reload()
  await page.waitForFunction(() => document.querySelectorAll('.pane').length === 2)
  assert.equal(await selectors().nth(0).inputValue(), 'Solarized Dark')
  assert.match(await selectors().nth(1).locator('option:checked').textContent(), /BrightTerm Light/)
  assert.equal(await page.locator('.pane').nth(0).evaluate(el => el.style.getPropertyValue('--term-bg')), '#002b36')
  assert.equal(await page.locator('.pane').nth(1).evaluate(el => el.style.getPropertyValue('--term-bg')), '#ffffff')
  const font = await page.locator('.statusbar').evaluate(el => el.style.fontFamily)
  assert.match(font, /^"?D2Coding ligature"?, D2Coding,/)
  assert.match((await call('store:get')).settings.fontFamily, /^'D2Coding ligature', 'D2Coding',/)
  await stop()
  await start()
  await call('vault:unlock', 'ThemesTest!2026')
  await page.waitForFunction(() => document.querySelectorAll('.pane').length === 2)
  assert.equal(await selectors().nth(0).inputValue(), 'Solarized Dark')
  await selectors().nth(0).selectOption('')
  assert.match(await selectors().nth(0).locator('option:checked').textContent(), /BrightTerm Light/)
  await selectors().nth(0).selectOption('Solarized Dark')
  await page.locator('.pane').nth(0).getByTitle('닫기', { exact: true }).click()
  if (await page.locator('.confirm').count()) await page.getByRole('button', { name: '닫기', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('.pane').length === 1)
  await workspace(w => w?.tabs[0]?.root.type === 'pane' && !w.tabs[0].root.terminalTheme)
  await page.locator('.pane button[title^="오른쪽으로 분할"]').click()
  await page.waitForFunction(() => document.querySelectorAll('.pane').length === 2)
  assert.equal(await selectors().nth(1).inputValue(), '')
  await page.screenshot({ path: '/tmp/brightterm-themes.png' })
  assert.deepEqual(errors, [])
  console.log('PASS: host defaults, independent overrides, reload/restart persistence, reset/close, status font')
} finally {
  if (app) await stop().catch(() => {})
  rmSync(data, { recursive: true, force: true })
}
