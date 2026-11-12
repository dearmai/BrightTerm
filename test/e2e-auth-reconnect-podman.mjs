// npm run build && node test/e2e-auth-reconnect-podman.mjs
// 실제 OpenSSH(podman 컨테이너)로 인증 실패 시 자동 재접속 중단과, 정상 접속 뒤 자동 재접속 복구를 확인한다.
// 필요: podman (머신 실행 중). 이미지가 없으면 debian:bookworm-slim 위에 openssh-server 를 설치해 만든다.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright-core'

const IMAGE = 'localhost/bt-auth-sshd:test'
const NAME = `bt-auth-sshd-${process.pid}`
const PORT = 20000 + (process.pid % 20000)
const GOOD = 'GoodPass!1'
const BAD = 'Changed!2'

function podman(...args) {
  const r = spawnSync('podman', args, { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`podman ${args.join(' ')}: ${r.stderr || r.stdout}`)
  return r.stdout
}
const setPassword = (pw) => podman('exec', NAME, 'sh', '-c', `echo 'tester:${pw}' | chpasswd`)
// tester 소유 프로세스(sshd: tester@pts/N 포함)를 끝내 서버 쪽에서 연결을 끊는다
const dropSessions = () => spawnSync('podman', ['exec', NAME, 'pkill', '-KILL', '-u', 'tester'])
// sshd -e 는 로그를 stderr 로 낸다
const logs = () => { const r = spawnSync('podman', ['logs', NAME], { encoding: 'utf8' }); return r.stdout + r.stderr }
const failedAuths = () => (logs().match(/Failed password for tester/g) ?? []).length
const acceptedAuths = () => (logs().match(/Accepted password for tester/g) ?? []).length
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

if (spawnSync('podman', ['image', 'exists', IMAGE]).status !== 0) {
  const ctx = mkdtempSync(join(tmpdir(), 'bt-sshd-image-'))
  writeFileSync(join(ctx, 'Containerfile'), [
    'FROM docker.io/library/debian:bookworm-slim',
    'RUN apt-get update && apt-get install -y --no-install-recommends openssh-server procps && rm -rf /var/lib/apt/lists/* \\',
    ` && mkdir -p /run/sshd && useradd -m -s /bin/bash tester && echo 'tester:${GOOD}' | chpasswd \\`,
    " && printf 'PasswordAuthentication yes\\nKbdInteractiveAuthentication no\\nMaxAuthTries 10\\nLogLevel VERBOSE\\n' > /etc/ssh/sshd_config.d/test.conf",
    'CMD ["/usr/sbin/sshd", "-D", "-e"]', ''
  ].join('\n'))
  podman('build', '-t', IMAGE, ctx)
  rmSync(ctx, { recursive: true, force: true })
}
podman('run', '-d', '--rm', '--name', NAME, '-p', `127.0.0.1:${PORT}:22`, IMAGE)

const data = mkdtempSync(join(tmpdir(), 'bt-auth-reconnect-'))
let app, page
const errors = []
const call = (channel, ...args) => page.evaluate(({ channel, args }) => window.bt.call(channel, ...args), { channel, args })
const info = (id) => page.evaluate((id) => window.__infos[id], id)
const out = () => page.evaluate(() => window.__out)
const waitState = (id, states, timeout = 20000) => page.waitForFunction(({ id, states }) => states.includes(window.__infos[id]?.state), { id, states }, { timeout })

try {
  // sshd 가 뜰 때까지
  for (let i = 0; i < 50 && !/Server listening/.test(logs()); i++) await sleep(200)

  app = await electron.launch({ args: ['.', '--password-store=basic'], env: { ...process.env, BRIGHTTERM_DATA: data } })
  page = await app.firstWindow()
  page.on('pageerror', (e) => errors.push(e.message))
  await page.waitForSelector('.lock-card')
  await page.evaluate(() => {
    localStorage.setItem('bt.importOffered', '1')
    window.__infos = {}; window.__out = ''
    window.bt.on('session:state', (i) => { window.__infos[i.id] = i })
    window.bt.on('session:data', (_id, d) => { window.__out += d })
  })
  await call('vault:setup', 'AuthReconnect!2026')
  await call('vault:unlock', 'AuthReconnect!2026')
  const cred = await call('cred:save', { name: 'tester', kind: 'password', username: 'tester', password: GOOD })
  const store = await call('store:get')
  const host = {
    id: 'auth-host', groupId: null, alias: 'Auth server', protocol: 'ssh', host: '127.0.0.1', port: PORT,
    username: 'tester', authType: 'password', credentialId: cred.id, tags: [], encoding: 'utf-8',
    termType: 'xterm-256color', keepaliveSec: 0, forwards: [], sort: 0, persist: false,
    autoReconnect: true, reconnectPolicy: { initialDelaySec: 1, mode: 'fixed', incrementSec: 1, multiplier: 2, maxDelaySec: 1, maxAttempts: 5 }
  }
  await call('store:patch', { hosts: [host], settings: { ...store.settings, checkUpdates: false } })

  // 1) 올바른 비밀번호로 접속 (처음 보는 호스트 키는 신뢰)
  const s = await call('session:open', { hostId: host.id, cols: 80, rows: 24 })
  await page.click('button:has-text("신뢰하고 접속")')
  await waitState(s.id, ['connected'])
  console.log('1. connected with vault password')

  // 2) 서버 비밀번호를 바꾸고 연결을 끊는다 → 자동 재접속 → 저장된 비밀번호 실패 → 입력 창 취소 → 중단
  setPassword(BAD)
  const failedBefore = failedAuths()
  dropSessions()
  await page.waitForFunction((id) => /재접속 \(1\/5\)/.test(window.__infos[id]?.message ?? ''), s.id)
  await page.waitForSelector('.modal input[type=password]', { timeout: 20000 })
  await page.locator('.modal').getByRole('button', { name: '취소' }).click()
  await waitState(s.id, ['error'])
  const failedAtStop = failedAuths()
  assert(failedAtStop > failedBefore, `server saw the failed saved password (${failedBefore} -> ${failedAtStop})`)
  assert.match(await out(), /인증에 실패해 자동 재접속을 중단합니다/)
  console.log(`2. auth failure stopped auto reconnect (state=${(await info(s.id)).state}, failed auths ${failedBefore} -> ${failedAtStop})`)

  // 정책상 1초 간격 5회가 남아 있지만 6초 동안 더 시도하지 않아야 한다
  const outAtStop = (await out()).length
  await sleep(6000)
  assert.equal((await info(s.id)).state, 'error', 'still stopped')
  assert.equal(failedAuths(), failedAtStop, 'no further auth attempts reached the server')
  assert.doesNotMatch((await out()).slice(outAtStop), /자동 재접속합니다/, 'no reconnect scheduled after auth failure')
  assert.equal(await page.locator('.modal input[type=password]').count(), 0, 'no further password prompt')
  console.log('3. no retries for 6s (policy allowed 5 more)')

  // 3) 서버 비밀번호를 되돌리고 Enter 로 수동 접속 → 정상 접속
  setPassword(GOOD)
  const acceptedBefore = acceptedAuths()
  await page.evaluate((id) => window.bt.write(id, '\r'), s.id)
  await waitState(s.id, ['connected'])
  assert.equal(acceptedAuths(), acceptedBefore + 1)
  console.log('4. manual reconnect succeeded')

  // 4) 정상 접속 뒤 끊기면 자동 재접속이 다시 동작한다
  dropSessions()
  await page.waitForFunction((id) => /재접속 \(1\/5\)/.test(window.__infos[id]?.message ?? ''), s.id)
  await waitState(s.id, ['connected'])
  assert.equal(acceptedAuths(), acceptedBefore + 2, 'auto reconnect logged in again')
  console.log('5. auto reconnect works again after a successful login')

  await call('session:close', s.id)
  assert.deepEqual(errors, [])
  console.log('PASS: auth failure stops auto reconnect; successful login re-enables it')
} catch (e) {
  if (page) console.error('connect log:\n' + await page.evaluate(() => Object.keys(window.__infos)).then((ids) => ids[0] ? call('session:connectLog', ids[0]) : '').catch(() => ''))
  throw e
} finally {
  await app?.close().catch(() => {})
  spawnSync('podman', ['rm', '-f', NAME])
  rmSync(data, { recursive: true, force: true })
}
