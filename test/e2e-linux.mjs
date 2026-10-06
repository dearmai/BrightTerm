// npm run build && node test/e2e-linux.mjs (requires an X11/Wayland session).
// BT_EXECUTABLE=dist/linux-unpacked/brightterm also verifies the packaged app.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { _electron as electron } from 'playwright-core'

assert.equal(process.platform, 'linux')
const data = mkdtempSync(join(tmpdir(), 'brightterm-linux-'))
const errors = []
let app
try {
  app = await electron.launch({
    ...(process.env.BT_EXECUTABLE ? { executablePath: resolve(process.env.BT_EXECUTABLE) } : {}),
    args: [...(process.env.BT_EXECUTABLE ? [] : ['.']), '--password-store=basic'],
    env: { ...process.env, SHELL: '/missing-brightterm-shell', BRIGHTTERM_DATA: data }
  })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => errors.push(e.message))
  await page.waitForSelector('.lock-card')
  const call = (channel, ...args) => page.evaluate(({ channel, args }) => window.bt.call(channel, ...args), { channel, args })
  assert.equal(await page.evaluate(() => window.bt.platform), 'linux')
  const shells = await call('local:shells')
  assert.equal(shells[0].path, existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh')
  assert.ok(shells.every((s) => existsSync(s.path)))
  assert.equal((await call('vault:status')).osUnlockKind, 'linux')
  assert.equal((await call('vault:status')).osUnlockAvailable, false)
  await call('vault:setup', 'Linux-test-password-2026')
  await assert.rejects(call('vault:setOsUnlock', true), /OS 보안 저장소/)
  assert.equal((await call('vault:status')).osUnlockEnabled, false)
  await call('vault:lock')
  assert.equal(await call('vault:unlockOs'), false)
  assert.equal(await call('vault:unlock', 'Linux-test-password-2026'), true)
  assert.match((await call('store:get')).settings.fontFamily, /DejaVu/)
  await page.evaluate(() => {
    window.linuxOutput = ''
    window.linuxStates = {}
    window.bt.on('session:data', (_id, text) => { window.linuxOutput += text })
    window.bt.on('session:state', (info) => { window.linuxStates[info.id] = info.state })
  })
  const session = await call('session:open', { adhoc: { protocol: 'local', cwd: data }, cols: 80, rows: 24 })
  await page.waitForFunction((id) => window.linuxStates[id] === 'connected', session.id)
  await page.evaluate((id) => window.bt.write(id, "printf '\\nBRIGHTTERM_%s_OK\\n' LINUX\r"), session.id)
  await page.waitForFunction(() => window.linuxOutput.includes('BRIGHTTERM_LINUX_OK'))
  await call('session:close', session.id)
  // Exercise serial native binding without requiring attached hardware.
  const ports = await app.evaluate(({ app }) => {
    const requireApp = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json')
    return requireApp('serialport').SerialPort.list()
  })
  assert.ok(Array.isArray(ports))
  assert.ok(Array.isArray(await call('serial:list')))
  assert.deepEqual(errors, [])
  console.log('PASS: Linux startup, shell fallback, PTY I/O, fonts, vault fallback and serial enumeration')
} finally {
  if (app) {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {})
    await app.close().catch(() => {})
  }
  rmSync(data, { recursive: true, force: true })
}
