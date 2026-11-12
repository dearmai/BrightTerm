// npm run build && node test/e2e-connect-diagnosis-podman.mjs
// 접속 실패 때 터미널에 접속 진단(ssh -v 요약)이 나오는지 실제 OpenSSH(podman)로 확인한다.
//   비밀번호 틀림 / 닫힌 포트 / 알고리즘 협상 실패 / 같은 원인 반복 시 생략 / 비밀번호 비노출
// 필요: podman. 이미지는 test/podman/ksh/Containerfile (e2e-ksh-podman 과 같은 이미지)
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright-core'

const here = dirname(fileURLToPath(import.meta.url))
const IMAGE = 'localhost/bt-ksh-sshd:test'
const NAME = `bt-diag-${process.pid}`
const PORT = 20000 + (process.pid % 20000)
const PORT_KEX = PORT + 1
const PORT_CLOSED = PORT + 2
const WRONG = 'Wrong-Secret-9x'

function podman(...args) {
  const r = spawnSync('podman', args, { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`podman ${args.join(' ')}: ${r.stderr || r.stdout}`)
  return r.stdout
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const plain = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')

if (spawnSync('podman', ['image', 'exists', IMAGE]).status !== 0) podman('build', '-t', IMAGE, join(here, 'podman', 'ksh'))
podman('run', '-d', '--rm', '--name', NAME, '-p', `127.0.0.1:${PORT}:22`, '-p', `127.0.0.1:${PORT_KEX}:2223`, IMAGE)
// ssh2 가 지원하지 않는 키 교환만 허용하는 sshd — 협상 실패
podman('exec', NAME, '/usr/sbin/sshd', '-p', '2223', '-o', 'KexAlgorithms=sntrup761x25519-sha512@openssh.com', '-o', 'PidFile=/run/sshd-kex.pid')

const data = mkdtempSync(join(tmpdir(), 'bt-diag-'))
let app, page
const errors = []
const call = (channel, ...args) => page.evaluate(({ channel, args }) => window.bt.call(channel, ...args), { channel, args })
const out = async (id) => plain(await page.evaluate((id) => window.__out[id] ?? '', id))
const waitState = (id, states, timeout = 20000) => page.waitForFunction(({ id, states }) => states.includes(window.__infos[id]?.state), { id, states }, { timeout })

async function open(host) {
  const store = await call('store:get')
  await call('store:patch', { hosts: [...store.hosts.filter((h) => h.id !== host.id), host] })
  const s = await call('session:open', { hostId: host.id, cols: 140, rows: 40 })
  const trust = page.locator('button:has-text("신뢰하고 접속")')
  for (let i = 0; i < 100; i++) {
    const st = await page.evaluate((id) => window.__infos[id]?.state, s.id)
    if (st === 'connected' || st === 'error' || st === 'closed') break
    if (await trust.count()) await trust.click().catch(() => {})
    const pw = page.locator('.modal input[type=password]')
    if (await pw.count()) await page.locator('.modal').getByRole('button', { name: '취소' }).click().catch(() => {})
    await sleep(100)
  }
  await waitState(s.id, ['error', 'closed'])
  return s.id
}

try {
  for (let i = 0; i < 50 && !/Server listening on 0\.0\.0\.0 port 22\b/.test(spawnSync('podman', ['logs', NAME], { encoding: 'utf8' }).stderr); i++) await sleep(200)
  app = await electron.launch({ args: ['.', '--password-store=basic'], env: { ...process.env, BRIGHTTERM_DATA: data } })
  page = await app.firstWindow()
  page.on('pageerror', (e) => errors.push(e.message))
  await page.waitForSelector('.lock-card')
  await page.evaluate(() => {
    localStorage.setItem('bt.importOffered', '1')
    window.__infos = {}; window.__out = {}
    window.bt.on('session:state', (i) => { window.__infos[i.id] = i })
    window.bt.on('session:data', (id, d) => { window.__out[id] = (window.__out[id] ?? '') + d })
  })
  await call('vault:setup', 'Diagnose!2026')
  await call('vault:unlock', 'Diagnose!2026')
  const cred = await call('cred:save', { name: 'wrong', kind: 'password', username: 'kshuser', password: WRONG })
  const store = await call('store:get')
  await call('store:patch', { settings: { ...store.settings, checkUpdates: false } })
  const base = {
    groupId: null, protocol: 'ssh', host: '127.0.0.1', username: 'kshuser', tags: [], encoding: 'utf-8',
    termType: 'xterm-256color', keepaliveSec: 0, forwards: [], sort: 0, persist: false, autoReconnect: false
  }

  // 1) 비밀번호 틀림
  const a = await open({ ...base, id: 'diag-auth', alias: 'diag auth', port: PORT, authType: 'password', credentialId: cred.id })
  const ao = await out(a)
  assert.match(ao, /● 접속 진단 \(ssh -v 요약/)
  assert.match(ao, /debug: Client: Trying 127\.0\.0\.1 on port \d+/)
  assert.match(ao, /debug: Remote ident: 'SSH-2\.0-OpenSSH_/)
  assert.match(ao, /debug: Inbound: Received USERAUTH_FAILURE \(publickey,password\)/)
  assert.match(ao, /debug: Client: password auth failed/)
  assert.match(ao, /debug: 인증 요약: 서버 허용 방식 publickey,password · 시도한 방식 password/)
  assert(!ao.includes(WRONG), '비밀번호가 터미널에 나오지 않는다')
  const diag = ao.slice(ao.indexOf('● 접속 진단'))
  console.log('1. auth failure diagnosis\n' + diag.split('\n').slice(0, 22).map((l) => '   ' + l.trimEnd()).join('\n'))

  // 2) 닫힌 포트 + Enter 로 다시 시도하면 같은 원인은 생략
  const c = await open({ ...base, id: 'diag-closed', alias: 'diag closed', port: PORT_CLOSED, authType: 'password', credentialId: cred.id })
  assert.match(await out(c), /debug: Socket error: connect ECONNREFUSED 127\.0\.0\.1:\d+/)
  assert.equal(((await out(c)).match(/● 접속 진단/g) ?? []).length, 1)
  await page.evaluate((id) => window.bt.write(id, '\r'), c)
  await page.waitForFunction((id) => /직전과 같은 원인/.test(window.__out[id] ?? ''), c, { timeout: 15000 })
  assert.equal(((await out(c)).match(/● 접속 진단/g) ?? []).length, 1)
  console.log('2. refused port diagnosis, repeated cause skipped')

  // 3) 알고리즘 협상 실패 — 양쪽 목록을 보인다
  const k = await open({ ...base, id: 'diag-kex', alias: 'diag kex', port: PORT_KEX, authType: 'password', credentialId: cred.id })
  const ko = await out(k)
  assert.match(ko, /debug: Handshake: \(local\) KEX method: /)
  assert.match(ko, /debug: Handshake: \(remote\) KEX method: sntrup761x25519-sha512@openssh\.com/)
  assert.match(ko, /debug: 오류 원문: Handshake failed: no matching key exchange algorithm/)
  // 화면 안내(빨간 '접속 실패' 줄)는 진단에 다시 넣지 않는다
  for (const o of [ao, ko]) assert.doesNotMatch(o, /debug: 접속 실패/)
  console.log('3. KEX mismatch diagnosis\n' + ko.slice(ko.indexOf('● 접속 진단')).split('\n').slice(0, 12).map((l) => '   ' + l.trimEnd().slice(0, 160)).join('\n'))

  for (const id of [a, c, k]) await call('session:close', id)
  assert.deepEqual(errors, [])
  console.log('PASS: connect failure diagnosis is shown in the terminal')
} finally {
  await app?.close().catch(() => {})
  spawnSync('podman', ['rm', '-f', NAME])
  rmSync(data, { recursive: true, force: true })
}
