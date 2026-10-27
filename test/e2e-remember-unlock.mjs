// OS storage is stubbed so this test never modifies the user's Keychain.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright-core'
const data = mkdtempSync(join(tmpdir(), 'bt-remember-'))
let app
try {
  app = await electron.launch({ args: ['.'], env: { ...process.env, BRIGHTTERM_DATA: data } })
  await app.evaluate(({ safeStorage, systemPreferences }) => {
    safeStorage.isEncryptionAvailable = () => true
    safeStorage.encryptString = text => Buffer.from(text)
    safeStorage.decryptString = bytes => bytes.toString()
    systemPreferences.canPromptTouchID = () => false
  })
  const page = await app.firstWindow()
  const call = (channel, ...args) => page.evaluate(({ channel, args }) => window.bt.call(channel, ...args), { channel, args })
  await page.waitForSelector('.lock-card')
  await page.evaluate(() => localStorage.setItem('bt.importOffered', '1'))
  await call('vault:setup', 'RememberTest!2026')
  await call('vault:lock')
  await page.reload()
  await page.waitForSelector('input[placeholder="마스터 비밀번호"]')
  await page.getByRole('checkbox').uncheck()
  await page.getByPlaceholder('마스터 비밀번호', { exact: true }).fill('RememberTest!2026')
  await page.getByRole('button', { name: '잠금 해제', exact: true }).click()
  await page.waitForSelector('.lock-card', { state: 'detached' })
  assert.equal((await call('vault:status')).osUnlockEnabled, false)
  await call('vault:lock')
  await page.waitForSelector('input[placeholder="마스터 비밀번호"]')
  await page.getByRole('checkbox').check()
  await page.getByPlaceholder('마스터 비밀번호', { exact: true }).fill('wrong-password')
  await page.getByRole('button', { name: '잠금 해제', exact: true }).click()
  await page.waitForSelector('.err')
  assert.equal((await call('vault:status')).osUnlockEnabled, false)
  await page.getByPlaceholder('마스터 비밀번호', { exact: true }).fill('RememberTest!2026')
  await page.getByRole('button', { name: '잠금 해제', exact: true }).click()
  await page.waitForFunction(async () => (await window.bt.call('vault:status')).osUnlockEnabled)
  assert.ok(JSON.parse(readFileSync(join(data, 'vault.json'), 'utf8')).osWrapped)
  assert.ok(!readFileSync(join(data, 'vault.json'), 'utf8').includes('RememberTest!2026'))
  await call('vault:lock')
  await page.reload()
  await page.waitForFunction(async () => (await window.bt.call('vault:status')).unlocked)
  await page.waitForSelector('.lock-card', { state: 'detached' })
  console.log('PASS: opt-out, wrong password, remembered OS unlock persistence and automatic startup unlock (OS storage stubbed)')
} finally {
  if (app) await app.close()
  rmSync(data, { recursive: true, force: true })
}
