// npm run build && node test/e2e-sidebar-keyboard.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright-core'

const data = mkdtempSync(join(tmpdir(), 'bt-sidebar-'))
let app
try {
  app = await electron.launch({ args: ['.', '--password-store=basic'], env: { ...process.env, BRIGHTTERM_DATA: data } })
  const page = await app.firstWindow()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  const call = (channel, ...args) => page.evaluate(({ channel, args }) => window.bt.call(channel, ...args), { channel, args })
  await page.waitForSelector('.lock-card')
  await page.evaluate(() => localStorage.setItem('bt.importOffered', '1'))
  const store = await call('store:get')
  const host = (id, alias, groupId = null, extra = {}) => ({
    id, alias, groupId, protocol: 'local', host: '', port: 22, username: '', authType: 'ask',
    tags: [], encoding: 'utf-8', termType: 'xterm-256color', keepaliveSec: 0, forwards: [], sort: 0, ...extra
  })
  await call('store:patch', {
    settings: { ...store.settings, checkUpdates: false },
    groups: [{ id: 'folder', name: 'Folder', parentId: null, collapsed: true, sort: 0 }],
    hosts: [host('z', 'Zulu'), host('a', 'Alpha'), host('child', 'Child', 'folder'), host('fav', 'Favorite', null, { favorite: true })]
  })
  await call('vault:setup', 'SidebarTest!2026')
  await call('vault:unlock', 'SidebarTest!2026')
  await page.reload()
  await page.waitForSelector('.tree')
  const search = page.locator('#sidebar-search')
  const tree = page.locator('.tree')
  const active = () => tree.getAttribute('aria-activedescendant')
  const press = (key) => page.keyboard.press(key)
  await search.focus()
  await press('ArrowDown')
  assert.equal(await active(), 'sb-fav-fav')
  await press('ArrowDown')
  assert.equal(await active(), 'sb-group-folder')
  await press('ArrowRight')
  await page.locator('#sb-host-child').waitFor()
  await press('ArrowRight')
  assert.equal(await active(), 'sb-host-child')
  await press('ArrowLeft')
  assert.equal(await active(), 'sb-group-folder')
  await press('ArrowLeft')
  await page.locator('#sb-host-child').waitFor({ state: 'detached' })
  await press('ArrowDown')
  assert.equal(await active(), 'sb-host-a')
  await press('End')
  assert.equal(await active(), 'sb-host-z')
  await press('ArrowDown')
  assert.equal(await active(), 'sb-host-z')
  await press('Home')
  assert.equal(await active(), 'sb-fav-fav')
  assert.equal(await tree.evaluate((el) => document.activeElement === el), true)
  await press('Escape')
  assert.equal(await search.evaluate((el) => document.activeElement === el), true)
  await search.fill('Child')
  await press('ArrowDown')
  assert.equal(await active(), 'sb-group-folder')
  await press('ArrowDown')
  assert.equal(await active(), 'sb-host-child')
  await press('F2')
  await page.locator('.modal').waitFor()
  await press('Escape')
  await page.locator('.modal').waitFor({ state: 'detached' })
  await search.fill('no-match')
  await press('Delete')
  await press('F2')
  assert.equal(await page.locator('.modal').count(), 0, 'search keys must not edit/delete selected hosts')
  await press('ArrowDown')
  assert.equal(await search.evaluate((el) => document.activeElement === el), true)
  await press('Escape')
  await search.fill('Alpha')
  // Observe actual sessions: contextBridge API objects are immutable.
  await page.evaluate(() => {
    window.__opened = {}
    window.bt.on('session:state', (info) => { window.__opened[info.id] = info.hostId })
  })
  await press('Enter')
  await page.waitForSelector('.pane')
  await page.waitForFunction(() => Object.keys(window.__opened).length > 0)
  assert.deepEqual(await page.evaluate(() => Object.values(window.__opened)), ['a'])
  assert.equal(await page.locator('.pane').count(), 1)
  assert.deepEqual(errors, [])
  console.log('PASS: sidebar keyboard navigation, folders, filtering, editing, input isolation, single Enter connection')
} finally {
  if (app) await app.close()
  rmSync(data, { recursive: true, force: true })
}
