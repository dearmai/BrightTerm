// npm run test:git-sync — two isolated Electron profiles and a local bare Git remote.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, rmSync, existsSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron } from 'playwright-core'

const root = mkdtempSync(join(tmpdir(), 'brightterm-git-test-'))
const remote = join(root, 'remote.git')
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
git('init', '--bare', remote)
const seed = join(root, 'seed')
mkdirSync(seed)
git('-C', seed, 'init', '-b', 'main')
writeFileSync(join(seed, 'README.md'), 'Keep unrelated repository files.\n')
git('-C', seed, 'add', 'README.md')
git('-C', seed, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'Seed')
git('-C', seed, 'push', remote, 'main')
const clients = new Set()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function start(name) {
  const data = join(root, name)
  mkdirSync(data, { recursive: true })
  const app = await _electron.launch({ ...(process.env.BT_EXECUTABLE ? { executablePath: process.env.BT_EXECUTABLE } : {}),
    args: [...(process.env.BT_EXECUTABLE ? [] : ['.']), '--password-store=basic'], env: { ...process.env, BRIGHTTERM_DATA: data } })
  const page = await app.firstWindow()
  await page.waitForSelector('.lock-card')
  const client = { app, page, data,
    call: (channel, ...args) => page.evaluate(({ channel, args }) => window.bt.call(channel, ...args), { channel, args }),
    close: async () => { clients.delete(client); await app.close() } }
  clients.add(client)
  return client
}
async function state(c, expected) {
  const start = Date.now()
  let s
  do {
    s = await c.call('git-sync:status')
    if (s.state === expected) return s
    if (s.state === 'error' && expected !== 'error') throw Error(s.message)
    await sleep(100)
  } while (Date.now() - start < 30000)
  throw Error(`Expected ${expected}, got ${JSON.stringify(s)}`)
}
async function autoSynced(c, edit) {
  const last = (await c.call('git-sync:status')).lastSync
  await edit()
  for (let i = 0; i < 300; i++) {
    const s = await c.call('git-sync:status')
    if (s.state === 'synced' && s.lastSync !== last) return
    if (s.state === 'error') throw Error(s.message)
    await sleep(100)
  }
  throw Error('Automatic sync did not run after an edit')
}
const config = { enabled: true, remote, branch: 'main' }
const rawRemote = () => git('--git-dir', remote, 'show', 'main:brightterm.vault.json')
const patchAlias = async (c, alias) => {
  const s = await c.call('store:get')
  await c.call('store:patch', { hosts: s.hosts.map((h) => ({ ...h, alias })) })
}
try {
  let a = await start('a')
  const password = 'Vault-password-A-2026'
  await a.call('vault:setup', password)
  await a.call('vault:unlock', password)
  const cred = await a.call('cred:save', { name: 'private-credential-name', kind: 'password', username: 'private-user', password: 'never-plaintext-secret' })
  const host = { id: 'host-1', groupId: 'group-1', alias: 'private-production-host', protocol: 'ssh', host: 'private.example.invalid', port: 22,
    username: 'private-user', authType: 'password', credentialId: cred.id, tags: [], encoding: 'utf-8', termType: 'xterm-256color', keepaliveSec: 30, forwards: [], sort: 0 }
  await a.call('store:patch', { groups: [{ id: 'group-1', parentId: null, name: 'private-folder', sort: 0 }], hosts: [host] })
  await assert.rejects(a.call('git-sync:configure', { ...config, remote: 'https://token-secret@example.invalid/repo.git' }), /토큰/)
  await a.page.waitForSelector('.lock', { state: 'detached' })
  await a.page.keyboard.press('Escape')
  await a.page.getByTitle('설정', { exact: true }).click()
  await a.page.getByRole('button', { name: 'Git 동기화', exact: true }).click()
  await a.page.getByLabel('Git URL', { exact: true }).fill(remote)
  await a.page.getByLabel('동기화 브랜치').fill('main')
  await a.page.locator('.s-body .switch').click()
  await a.page.getByRole('button', { name: '설정 저장', exact: true }).click()
  await state(a, 'synced')
  assert.deepEqual((await a.call('git-sync:status')).config, config)
  await a.page.screenshot({ path: '/tmp/brightterm-git-settings.png' })
  await a.page.keyboard.press('Escape')
  for (const secret of [host.alias, host.host, password, 'private-folder', 'private-user', 'never-plaintext-secret', 'osWrapped']) assert(!rawRemote().includes(secret), secret)
  assert.equal(git('--git-dir', remote, 'show', 'main:README.md'), 'Keep unrelated repository files.')
  console.log('PASS: encrypted first push, URL validation, unrelated files preserved')

  let b = await start('b')
  await b.call('vault:setup', 'Different-local-password')
  await b.call('vault:unlock', 'Different-local-password')
  const bSettings = (await b.call('store:get')).settings
  await b.call('store:patch', { settings: { ...bSettings, fontSize: 19 } })
  await b.call('git-sync:configure', config)
  await state(b, 'conflict')
  assert.equal((await b.call('git-sync:resolve', 'remote', 'wrong-password')).state, 'password-required')
  assert.equal((await b.call('store:get')).hosts.length, 0)
  assert.equal((await b.call('git-sync:resolve', 'remote', password)).state, 'synced')
  assert.equal((await b.call('store:get')).hosts[0].alias, host.alias)
  assert.equal((await b.call('store:get')).settings.fontSize, 19)
  assert.equal((await b.call('cred:get', cred.id)).password, 'never-plaintext-secret')
  assert(readdirSync(join(b.data, 'git-sync', 'backups')).length > 0)
  console.log('PASS: first-device conflict, remote password import, local settings and recovery backup')

  await b.close()
  await autoSynced(a, () => patchAlias(a, 'Changed while B was closed'))
  b = await start('b')
  await state(b, 'locked')
  assert.equal((await b.call('store:get')).hosts[0].alias, host.alias)
  assert.equal(await b.call('vault:unlock', password), true)
  await state(b, 'synced')
  assert.equal((await b.call('store:get')).hosts[0].alias, 'Changed while B was closed')
  console.log('PASS: startup fetch and automatic apply after unlocking')

  await a.call('git-sync:configure', { ...config, enabled: false })
  await patchAlias(a, 'A concurrent change')
  await autoSynced(b, () => patchAlias(b, 'B concurrent change'))
  const beforeConflict = rawRemote()
  await a.call('git-sync:configure', config)
  await state(a, 'conflict')
  assert.equal(rawRemote(), beforeConflict)
  // Do not apply an old conflict decision after another machine changes the remote.
  await autoSynced(b, () => patchAlias(b, 'B newer change'))
  assert.equal((await a.call('git-sync:resolve', 'local')).state, 'conflict')
  const parent = git('--git-dir', remote, 'rev-parse', 'main')
  assert.equal((await a.call('git-sync:resolve', 'local')).state, 'synced')
  assert.equal(git('--git-dir', remote, 'rev-parse', 'main^'), parent)
  assert.equal((await b.call('git-sync:now')).state, 'synced')
  assert.equal((await b.call('store:get')).hosts[0].alias, 'A concurrent change')
  console.log('PASS: concurrent edits preserve both versions; stale decisions rejected; no force push')

  renameSync(remote, remote + '.offline')
  await patchAlias(a, 'Pending offline edit')
  await state(a, 'error')
  assert.equal((await a.call('store:get')).hosts[0].alias, 'Pending offline edit')
  renameSync(remote + '.offline', remote)
  assert.equal((await a.call('git-sync:now')).state, 'synced')
  assert.equal((await b.call('git-sync:now')).state, 'synced')
  assert.equal((await b.call('store:get')).hosts[0].alias, 'Pending offline edit')
  console.log('PASS: offline edits survive and upload on retry')

  const validEnvelope = rawRemote()
  const beforeTamper = (await b.call('store:get')).hosts
  git('-C', seed, 'fetch', remote, 'main')
  git('-C', seed, 'checkout', '-B', 'test-updates', 'FETCH_HEAD')
  const broken = JSON.parse(validEnvelope)
  broken.payload.ct = (broken.payload.ct.startsWith('A') ? 'B' : 'A') + broken.payload.ct.slice(1)
  const commitEnvelope = (text) => {
    writeFileSync(join(seed, 'brightterm.vault.json'), text)
    git('-C', seed, 'add', 'brightterm.vault.json')
    git('-C', seed, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'Test remote update')
    git('-C', seed, 'push', remote, 'HEAD:main')
  }
  commitEnvelope(JSON.stringify(broken))
  assert.equal((await b.call('git-sync:now')).state, 'password-required')
  assert.deepEqual((await b.call('store:get')).hosts, beforeTamper)
  assert.equal((await b.call('cred:get', cred.id)).password, 'never-plaintext-secret')
  commitEnvelope(validEnvelope)
  assert.equal((await b.call('git-sync:now')).state, 'synced')
  console.log('PASS: tampered ciphertext cannot replace local data')

  const hook = join(remote, 'hooks', 'pre-receive')
  const receiving = join(root, 'receiving')
  writeFileSync(hook, `#!/bin/sh\ntouch '${receiving}'\nsleep 1\n`, { mode: 0o755 })
  const commits = Number(git('--git-dir', remote, 'rev-list', '--count', 'main'))
  await patchAlias(a, 'First in-flight edit')
  for (let i = 0; i < 200 && !existsSync(receiving); i++) await sleep(50)
  assert(existsSync(receiving), 'Push must have started')
  await patchAlias(a, 'Second in-flight edit')
  for (let i = 0; i < 300 && Number(git('--git-dir', remote, 'rev-list', '--count', 'main')) < commits + 2; i++) await sleep(100)
  assert.equal(Number(git('--git-dir', remote, 'rev-list', '--count', 'main')), commits + 2)
  unlinkSync(hook)
  await state(a, 'synced')
  assert.equal((await b.call('git-sync:now')).state, 'synced')
  assert.equal((await b.call('store:get')).hosts[0].alias, 'Second in-flight edit')
  console.log('PASS: edits during an active push are queued and preserved')

  await autoSynced(a, () => a.call('vault:changePassword', password, 'New-master-password-2026'))
  assert.equal((await b.call('git-sync:now')).state, 'synced')
  await b.call('vault:lock')
  assert.equal(await b.call('vault:unlock', password), false)
  assert.equal(await b.call('vault:unlock', 'New-master-password-2026'), true)
  await state(b, 'synced')
  await autoSynced(a, async () => { await a.call('store:patch', { hosts: [], groups: [] }); await a.call('cred:delete', cred.id) })
  assert.equal((await b.call('git-sync:now')).state, 'synced')
  assert.equal((await b.call('store:get')).hosts.length, 0)
  assert.equal((await b.call('cred:list')).length, 0)
  console.log('PASS: master-password rotation and connection/credential deletion propagate')

  await a.call('git-sync:configure', { ...config, enabled: false })
  const aData = a.data
  await a.close()
  const before = { store: JSON.parse(readFileSync(join(aData, 'store.json'))), vault: JSON.parse(readFileSync(join(aData, 'vault.json'))), tracking: JSON.parse(readFileSync(join(aData, 'git-sync.json'))) }
  writeFileSync(join(aData, 'git-sync', 'rollback.json'), JSON.stringify(before))
  writeFileSync(join(aData, 'store.json'), JSON.stringify({ ...before.store, hosts: [host] }))
  a = await start('a')
  assert.deepEqual((await a.call('store:get')).hosts, before.store.hosts)
  assert.equal((await a.call('git-sync:status')).state, 'disabled')
  console.log('PASS: interrupted two-file apply recovers the previous snapshot')
} finally {
  for (const c of [...clients]) await c.close().catch(() => {})
  rmSync(root, { recursive: true, force: true })
}
