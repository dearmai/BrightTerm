// npm run build && node test/e2e-snippets-file.mjs
// 스니펫 패널의 내보내기·가져오기 버튼. 파일 선택 창만 가짜로 바꾸고 나머지는 실제 앱으로 확인한다.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright-core'

const data = mkdtempSync(join(tmpdir(), 'bt-snippets-'))
const file = join(data, 'snippets.json')
const first = { id: 's1', name: '로그 보기', body: 'tail -f app.log\nls', sendEnter: true }

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
  await call('store:patch', { snippets: [first], settings: { ...store.settings, checkUpdates: false } })
  await page.reload()
  await page.waitForSelector('.lock-card')
  await call('vault:setup', 'SnippetsTest!2026')
  await call('vault:unlock', 'SnippetsTest!2026')
  await page.waitForSelector('.welcome')
  await page.keyboard.press('Escape')

  await app.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path })
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, file)

  await page.getByTitle(/^SFTP 패널/).click()
  await page.locator('.rp-tab', { hasText: '스니펫' }).click()

  // 내보내기: 평문 JSON, 내부 id 없음
  await page.getByTitle('스니펫 내보내기 (JSON)').click()
  await page.getByText('암호화되지 않은 파일').waitFor()
  const exported = JSON.parse(readFileSync(file, 'utf8'))
  assert.deepEqual(exported.snippets, [{ name: first.name, body: first.body, sendEnter: true }])
  assert.equal(exported.type, 'snippets')

  // 가져오기: 같은 내용은 건너뛰고, 이름만 같으면 번호를 붙여 추가
  exported.snippets.push({ name: first.name, body: 'other', sendEnter: false }, { name: '새 항목', body: 'df -h' })
  writeFileSync(file, JSON.stringify(exported))
  await page.getByTitle('스니펫 가져오기 (JSON)').click()
  await page.getByText('스니펫 2개를 가져왔습니다 (같은 내용 1개 건너뜀)').waitFor()
  const after = (await call('store:get')).snippets
  assert.deepEqual(after.map((s) => s.name), [first.name, `${first.name} (2)`, '새 항목'])
  assert.equal(after[0].id, 's1')
  assert.equal(after[2].sendEnter, false)
  await page.locator('.snip', { hasText: '새 항목' }).waitFor()

  // 잘못된 파일은 알려 주고 아무것도 바꾸지 않는다
  writeFileSync(file, '{"app":"other"}')
  await page.getByTitle('스니펫 가져오기 (JSON)').click()
  await page.getByText('BrightTerm 스니펫 파일이 아닙니다').waitFor()
  assert.equal((await call('store:get')).snippets.length, 3)

  assert.deepEqual(errors, [])
  console.log('PASS: export, import merge, invalid file')
} finally {
  if (app) await app.close().catch(() => {})
  rmSync(data, { recursive: true, force: true })
}
