// npm run build && node test/e2e-git-sync-notice.mjs
// Isolated profile, synthetic status events; no user vault or remote repository is accessed.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright-core'

const data = mkdtempSync(join(tmpdir(), 'bt-git-notice-'))
const config = { enabled: true, remote: 'git@example.invalid:test/vault.git', branch: 'main' }
let app
try {
  app = await electron.launch({ args: ['.'], env: { ...process.env, BRIGHTTERM_DATA: data } })
  const page = await app.firstWindow()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.waitForSelector('.lock-card')
  await page.evaluate(async () => {
    localStorage.setItem('bt.importOffered', '1')
    await window.bt.call('vault:setup', 'Notice-test-2026')
  })
  await page.reload()
  await page.waitForSelector('.lock-card', { state: 'detached' })
  await page.waitForSelector('.git-sync-indicator[data-state="disabled"]')
  const emit = (state, message = 'Test connection failed') => app.evaluate(({ BrowserWindow }, status) => {
    BrowserWindow.getAllWindows()[0].webContents.send('git-sync:changed', status)
  }, { state, message, config })
  const notice = page.locator('.git-sync-notice')
  const indicator = page.locator('.git-sync-indicator')
  await indicator.focus()
  await emit('error')
  await notice.waitFor()
  assert.match(await notice.innerText(), /Git 동기화 실패/)
  assert.match(await notice.innerText(), /Test connection failed/)
  assert.ok(await indicator.evaluate((el) => document.activeElement === el), 'failure must not steal keyboard focus')
  const anchor = await indicator.boundingBox()
  const box = await notice.boundingBox()
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  assert.ok(box.y > anchor.y + anchor.height && box.x >= 0 && box.x + box.width <= viewport.width)
  await page.screenshot({ path: '/tmp/brightterm-git-sync-notice.png' })
  await page.getByRole('button', { name: 'Git 동기화 알림 닫기' }).click()
  await emit('syncing', 'Retrying')
  await emit('error')
  await page.waitForSelector('.git-sync-indicator[data-state="error"]')
  assert.equal(await notice.count(), 0, 'same retry failure stays dismissed')

  await emit('error', 'Different error')
  await notice.waitFor()
  assert.match(await notice.innerText(), /Different error/)
  await emit('synced', 'Done')
  await notice.waitFor({ state: 'detached' })
  await emit('error', 'Different error')
  await notice.waitFor()
  await emit('conflict', 'Local and remote differ')
  await page.waitForSelector('.git-sync-notice[data-state="conflict"]')
  assert.match(await notice.innerText(), /자동 덮어쓰기를 중단/)
  await emit('password-required', 'Remote password needed')
  await page.waitForSelector('.git-sync-notice[data-state="password-required"]')
  await page.getByRole('button', { name: '동기화 설정 열기', exact: true }).click()
  await page.getByLabel('Git URL', { exact: true }).waitFor()
  assert.equal(await notice.count(), 0)
  assert.deepEqual(errors, [])
  console.log('PASS: anchored failure notice, no focus theft, retry deduplication, recovery and settings navigation')
} finally {
  if (app) { await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {}) }
  rmSync(data, { recursive: true, force: true })
}
