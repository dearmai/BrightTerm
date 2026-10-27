import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright-core'
const data = mkdtempSync(join(tmpdir(), 'bt-statusbar-'))
let app
try {
  app = await electron.launch({ args: ['.'], env: { ...process.env, BRIGHTTERM_DATA: data } })
  const page = await app.firstWindow()
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.waitForSelector('.lock-card')
  await page.evaluate(async () => {
    localStorage.setItem('bt.importOffered', '1')
    const store = await window.bt.call('store:get')
    const hosts = ['Metrics A', 'Metrics B'].map((alias, i) => ({
      id: `metrics-${i}`, groupId: null, alias, protocol: 'local', host: '', port: 0,
      username: '', authType: 'ask', tags: [], encoding: 'utf-8', termType: 'xterm-256color',
      keepaliveSec: 0, forwards: [], persist: false, local: { cwd: '/tmp' }, sort: i
    }))
    await window.bt.call('store:patch', { hosts, settings: { ...store.settings, checkUpdates: false } })
  })
  await page.reload()
  await page.waitForSelector('.lock-card')
  await page.fill('input[placeholder^="마스터 비밀번호"]', 'MetricsTest!2026')
  await page.fill('input[placeholder="비밀번호 확인"]', 'MetricsTest!2026')
  await page.click('button:has-text("볼트 만들기")')
  await page.waitForSelector('.recovery')
  await page.check('input[type=checkbox]')
  await page.click('button:has-text("시작하기")')
  await page.waitForSelector('.welcome')
  if (await page.$('.modal')) await page.keyboard.press('Escape')
  await page.locator('.sidebar [data-host="metrics-0"]').dblclick()
  await page.waitForSelector('.pane .dot.connected')
  await page.waitForFunction(() => [...document.querySelectorAll('.sb-metric')].slice(1, 4).every(el => /[0-9.]+%/.test(el.textContent)))
  assert.equal(await page.locator('.sb-metric').count(), 5)
  assert.match(await page.locator('.statusbar .sb-session').textContent(), /Metrics A/)
  await page.waitForFunction(() => /[0-9]+분/.test(document.querySelector('.sb-uptime')?.textContent || ''))
  // Split and focus each actual terminal textarea, including keyboard-driven focus.
  await page.locator('.sidebar [data-host="metrics-1"]').hover()
  await page.locator('.sidebar [data-host="metrics-1"] button[title="분할로 연결"]').click()
  await page.waitForFunction(() => document.querySelectorAll('.pane').length === 2)
  const panes = page.locator('.pane')
  for (const index of [0, 1, 0]) {
    const pane = panes.nth(index)
    await pane.locator('textarea').focus()
    await page.waitForFunction(id => document.querySelector('.pane.focused')?.getAttribute('data-pane') === id, await pane.getAttribute('data-pane'))
    await page.waitForFunction(name => document.querySelector('.statusbar .sb-session')?.textContent === name, index === 0 ? 'Metrics A' : 'Metrics B')
  }
  assert.deepEqual(errors, [])
  console.log('PASS: live system metrics and focused split pane tracking')
} finally {
  if (app) {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {})
    await app.close().catch(() => {})
  }
  rmSync(data, { recursive: true, force: true })
}
