// npm run build && node test/e2e-host-folder.mjs
// 서버 편집 창에서 폴더 만들기 — Esc 는 입력란만 닫고 편집 창은 남는다. Enter 로 만들면 그 폴더를 고른다
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright-core'
import { closeApp } from './close-app.mjs'

const data = mkdtempSync(join(tmpdir(), 'bt-folder-'))
let app, page
const errors = []
const call = (channel, ...args) => page.evaluate(({ channel, args }) => window.bt.call(channel, ...args), { channel, args })

try {
  app = await electron.launch({ args: ['.', '--password-store=basic'], env: { ...process.env, BRIGHTTERM_DATA: data } })
  page = await app.firstWindow()
  page.on('pageerror', (e) => errors.push(e.message))
  await page.waitForSelector('.lock-card')
  await page.evaluate(() => localStorage.setItem('bt.importOffered', '1'))
  await call('vault:setup', 'Folder!2026')
  await call('vault:unlock', 'Folder!2026')
  const store = await call('store:get')
  await call('store:patch', {
    settings: { ...store.settings, checkUpdates: false },
    groups: [{ id: 'g1', parentId: null, name: '운영', sort: 0 }],
    hosts: [{ id: 'h1', groupId: 'g1', alias: 'web', protocol: 'ssh', host: '10.0.0.1', port: 22, username: 'u', authType: 'ask', tags: [], encoding: 'utf-8', termType: 'xterm-256color', keepaliveSec: 0, forwards: [], sort: 0 }]
  })
  await page.reload()
  await page.waitForSelector('.welcome')
  if (await page.$('.modal')) await page.keyboard.press('Escape')

  await page.locator('.sidebar [data-host="h1"]').hover()
  await page.locator('.sidebar [data-host="h1"] button[title^="서버 편집"]').click()
  await page.waitForSelector('.modal')
  const folderInput = page.locator('.modal input[placeholder="새 폴더 이름"]')

  // 1) Esc — 입력란만 닫히고 편집 창·폴더 선택은 그대로
  await page.locator('.modal button[title="새 폴더 만들기"]').click()
  await folderInput.fill('취소할 폴더')
  await page.keyboard.press('Escape')
  await folderInput.waitFor({ state: 'detached' })
  assert.ok(await page.$('.modal'), 'Esc 로 편집 창이 닫히지 않는다')
  assert.ok(await page.$('.modal button[title="새 폴더 만들기"]'), '폴더 선택으로 돌아온다')
  assert.equal((await call('store:get')).groups.length, 1, '취소하면 폴더를 만들지 않는다')
  console.log('1. Esc closes only the folder input')

  // 2) Enter — 선택한 폴더(운영) 아래에 만들고 바로 고른다
  await page.locator('.modal button[title="새 폴더 만들기"]').click()
  await folderInput.fill('DB')
  await page.keyboard.press('Enter')
  await folderInput.waitFor({ state: 'detached' })
  await page.waitForFunction(async () => (await window.bt.call('store:get')).groups.length === 2)
  const created = (await call('store:get')).groups.find((g) => g.name === 'DB')
  assert.equal(created.parentId, 'g1')
  assert.equal(await page.locator('.modal select').first().inputValue(), created.id, '만든 폴더를 고른다')
  console.log('2. Enter creates the folder under the selected one and selects it')

  // 3) 입력란이 없을 때 Esc 는 전처럼 편집 창을 닫는다
  await page.keyboard.press('Escape')
  await page.waitForSelector('.modal', { state: 'detached' })
  console.log('3. Esc closes the editor when no inner layer is open')

  assert.deepEqual(errors, [])
  console.log('PASS: host editor folder creation')
} finally {
  await closeApp(app)
  rmSync(data, { recursive: true, force: true })
}
