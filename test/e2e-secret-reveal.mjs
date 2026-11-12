// npm run build && node test/e2e-secret-reveal.mjs
// 서버 편집에서 저장된 비밀번호를 눈 버튼으로 평문 보기(볼트 잠금 해제 상태).
//   - 보기/가리기, 읽어 온 값을 그대로 저장하면 볼트에 다시 쓰지 않음(공유 계정이 갈라지지 않음)
//   - 공유 계정 선택 모드에서도 보기, 값을 바꾸면 정상 저장
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright-core'
import { closeApp } from './close-app.mjs'

const data = mkdtempSync(join(tmpdir(), 'bt-reveal-'))
const OWN = 'Own-Secret-1!'
const SHARED = 'Shared-Secret-2#'
let app, page
const errors = []
const call = (channel, ...args) => page.evaluate(({ channel, args }) => window.bt.call(channel, ...args), { channel, args })

async function openAuth(id) {
  await page.locator(`.sidebar [data-host="${id}"]`).click()
  await page.keyboard.press('F2')
  await page.locator('.mtabs button', { hasText: '인증' }).click()
}
/** 눈 버튼을 누르면 볼트에서 읽어 채운다 — 채워질 때까지 기다린 뒤 값 */
async function revealed(label) {
  await page.waitForFunction((l) => { const el = document.querySelector('input[aria-label="' + l + '"]'); return el && el.type === 'text' && el.value !== '' }, label)
  return page.getByLabel(label, { exact: true }).inputValue()
}
const save = () => page.locator('.modal').getByRole('button', { name: '저장', exact: true }).first().click()

try {
  app = await electron.launch({ args: ['.', '--password-store=basic'], env: { ...process.env, BRIGHTTERM_DATA: data } })
  page = await app.firstWindow()
  page.on('pageerror', (e) => errors.push(e.message))
  await page.waitForSelector('.lock-card')
  await page.evaluate(() => localStorage.setItem('bt.importOffered', '1'))
  await call('vault:setup', 'Reveal!2026')
  await call('vault:unlock', 'Reveal!2026')
  const own = await call('cred:save', { name: 'own', kind: 'password', username: 'u1', password: OWN })
  const shared = await call('cred:save', { name: 'shared', kind: 'password', username: 'u2', password: SHARED })
  const base = { groupId: null, protocol: 'ssh', host: '10.0.0.1', port: 22, authType: 'password', tags: [], encoding: 'utf-8', termType: 'xterm-256color', keepaliveSec: 0, forwards: [], sort: 0 }
  const store = await call('store:get')
  await call('store:patch', {
    settings: { ...store.settings, checkUpdates: false },
    hosts: [
      { ...base, id: 'h1', alias: 'own host', username: 'u1', credentialId: own.id },
      { ...base, id: 'h2', alias: 'shared a', username: 'u2', credentialId: shared.id },
      { ...base, id: 'h3', alias: 'shared b', username: 'u2', credentialId: shared.id }
    ]
  })
  await page.reload()
  await page.waitForSelector('.welcome')
  const credsBefore = await call('cred:list')

  // 1) 보기 / 가리기
  await openAuth('h1')
  const input = page.getByLabel('비밀번호', { exact: true })
  assert.equal(await input.getAttribute('type'), 'password')
  assert.equal(await input.inputValue(), '')
  await page.getByRole('button', { name: '비밀번호 보기' }).click()
  await page.waitForFunction(() => document.querySelector('input[aria-label="비밀번호"]')?.type === 'text')
  assert.equal(await input.inputValue(), OWN)
  if (process.env.BT_SCREENSHOT) await page.screenshot({ path: process.env.BT_SCREENSHOT })
  await page.getByRole('button', { name: '비밀번호 가리기' }).click()
  assert.equal(await input.getAttribute('type'), 'password')
  assert.equal(await input.inputValue(), OWN, '가려도 값은 그대로')
  await save()
  await page.waitForSelector('.modal', { state: 'detached' })
  console.log('1. reveal/hide stored password')

  // 2) 공유 계정을 쓰는 서버(공유 계정 선택 모드로 열린다)에서 읽기 전용으로 보고 저장 — 계정이 그대로
  await openAuth('h2')
  await page.getByRole('button', { name: '계정 비밀번호 보기' }).click()
  const sharedInput = page.getByLabel('계정 비밀번호', { exact: true })
  assert.equal(await revealed('계정 비밀번호'), SHARED)
  assert.equal(await sharedInput.getAttribute('readonly'), '', '공유 계정은 여기서 바꾸지 않는다')
  await save()
  await page.waitForSelector('.modal', { state: 'detached' })
  await page.waitForTimeout(300)
  const credsAfter = await call('cred:list')
  assert.deepEqual(credsAfter.map((c) => [c.id, c.updatedAt]).sort(), credsBefore.map((c) => [c.id, c.updatedAt]).sort(), '볼트에 다시 쓰지 않는다')
  const hosts = (await call('store:get')).hosts
  assert.equal(hosts.find((h) => h.id === 'h1').credentialId, own.id)
  assert.equal(hosts.find((h) => h.id === 'h2').credentialId, shared.id, '공유 계정 유지')
  console.log('2. saving an unchanged revealed password keeps vault and shared credential as is')

  // 3) 공유 계정 서버를 '이 서버 전용'으로 바꿔 보고 그대로 저장 — 새 계정을 만들지 않는다
  await openAuth('h3')
  await page.locator('.modal').getByText('이 서버 전용').click()
  await page.getByRole('button', { name: '비밀번호 보기' }).click()
  assert.equal(await revealed('비밀번호'), SHARED)
  await save()
  await page.waitForSelector('.modal', { state: 'detached' })
  await page.waitForTimeout(300)
  assert.equal((await call('cred:list')).length, credsBefore.length, '읽어 온 값 그대로면 계정을 새로 만들지 않는다')
  assert.equal((await call('store:get')).hosts.find((h) => h.id === 'h3').credentialId, shared.id)
  console.log('3. own mode on a shared credential: unchanged revealed value does not split the account')

  // 4) 본 뒤 고치면 정상 저장
  await openAuth('h1')
  await page.getByRole('button', { name: '비밀번호 보기' }).click()
  await page.getByLabel('비밀번호', { exact: true }).fill('Changed-3$')
  await save()
  await page.waitForSelector('.modal', { state: 'detached' })
  await page.waitForTimeout(300)
  const hostId = (await call('store:get')).hosts.find((h) => h.id === 'h1').credentialId
  assert.equal((await call('cred:get', hostId)).password, 'Changed-3$')
  console.log('4. editing a revealed password saves the new value')

  assert.deepEqual(errors, [])
  console.log('PASS: stored passwords can be revealed in the server editor')
} finally {
  await closeApp(app)
  rmSync(data, { recursive: true, force: true })
}
