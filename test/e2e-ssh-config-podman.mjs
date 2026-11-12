// npm run build && node test/e2e-ssh-config-podman.mjs
// 서버 목록 → ~/.ssh/config 동기화를 실제 앱과 실제 OpenSSH 클라이언트로 확인한다.
//   - 기본은 대상 아님, 서버 편집 → 고급의 토글로 켠 서버만 들어간다
//   - 사용자가 쓴 ~/.ssh/config 는 그대로 두고 맨 앞에 Include 한 줄만 넣는다
//   - ssh -G 로 해석 결과, ProxyJump(베스천 경유)로 실제 접속, 모두 끄면 원래 config 로 복원
// 필요: podman, ssh·ssh-keygen (OpenSSH 클라이언트). BRIGHTTERM_SSH_DIR 로 실제 ~/.ssh 대신 임시 폴더를 쓴다.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright-core'
import { closeApp } from './close-app.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const IMAGE = 'localhost/bt-ksh-sshd:test'
const NAME = `bt-sshcfg-${process.pid}`
const PORT = 20000 + (process.pid % 20000)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts })
  if (r.status !== 0 && !opts.allowFail) throw new Error(`${cmd} ${args.join(' ')}: ${r.status}\n${r.stderr || r.stdout}`)
  return r
}

if (spawnSync('podman', ['image', 'exists', IMAGE]).status !== 0) run('podman', ['build', '-t', IMAGE, join(here, 'podman', 'ksh')])
run('podman', ['run', '-d', '--rm', '--name', NAME, '-p', `127.0.0.1:${PORT}:22`, IMAGE])

const data = mkdtempSync(join(tmpdir(), 'bt-sshcfg-'))
// Include 의 상대 경로는 ~/.ssh 기준이다 — ssh 의 HOME 을 임시 폴더로 바꿔 실제 배치와 같게 한다
const sshDir = join(data, '.ssh')
const sshEnv = { ...process.env, HOME: data }
mkdirSync(sshDir)
const slash = (p) => p.replace(/\\/g, '/')
const key = join(data, 'id_test')
run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key])
run('podman', ['exec', '-i', NAME, 'sh', '-c', 'install -d -m 700 -o kshuser -g kshuser /home/kshuser/.ssh && cat > /home/kshuser/.ssh/authorized_keys && chown kshuser:kshuser /home/kshuser/.ssh/authorized_keys && chmod 600 /home/kshuser/.ssh/authorized_keys'], { input: readFileSync(key + '.pub', 'utf8') })

// 사용자가 원래 쓰던 config — 전역 옵션과 Host * (테스트용 키·known_hosts 도 여기서 지정)
const original = [
  '# 내 설정',
  'ServerAliveCountMax 7',
  '',
  'Host *',
  '  User nobody-global',
  `  IdentityFile "${slash(key)}"`,
  '  IdentitiesOnly yes',
  '  BatchMode yes',
  '  StrictHostKeyChecking no',
  `  UserKnownHostsFile "${slash(join(data, 'known_hosts'))}"`,
  ''
].join('\n')
const configPath = join(sshDir, 'config')
const confPath = join(sshDir, 'brightterm.conf')
writeFileSync(configPath, original)

let app, page
const errors = []
const call = (channel, ...args) => page.evaluate(({ channel, args }) => window.bt.call(channel, ...args), { channel, args })
async function waitFile(test, what, timeout = 10000) {
  for (const end = Date.now() + timeout; Date.now() < end; await sleep(100)) if (test()) return
  throw new Error(`timeout: ${what}`)
}
const conf = () => (existsSync(confPath) ? readFileSync(confPath, 'utf8') : '')
const sshG = (name) => Object.fromEntries(run('ssh', ['-F', slash(configPath), '-G', name], { env: sshEnv }).stdout.split(/\r?\n/).filter(Boolean).map((l) => { const i = l.indexOf(' '); return [l.slice(0, i), l.slice(i + 1)] }))

try {
  for (let i = 0; i < 50 && !/Server listening/.test(run('podman', ['logs', NAME]).stderr); i++) await sleep(200)
  app = await electron.launch({ args: ['.', '--password-store=basic'], env: { ...process.env, BRIGHTTERM_DATA: data, BRIGHTTERM_SSH_DIR: sshDir } })
  page = await app.firstWindow()
  page.on('pageerror', (e) => errors.push(e.message))
  await page.waitForSelector('.lock-card')
  await page.evaluate(() => localStorage.setItem('bt.importOffered', '1'))
  await call('vault:setup', 'SshConfig!2026')
  await call('vault:unlock', 'SshConfig!2026')
  await page.waitForSelector('.sidebar')
  const base = { protocol: 'ssh', tags: [], encoding: 'utf-8', termType: 'xterm-256color', keepaliveSec: 0, forwards: [], sort: 0, authType: 'agent', credentialId: null }
  const store = await call('store:get')
  await call('store:patch', {
    settings: { ...store.settings, checkUpdates: false },
    groups: [{ id: 'g', parentId: null, name: '테스트 그룹', sort: 0 }],
    hosts: [
      // 베스천: 처음부터 동기화 대상
      { ...base, id: 'bastion', groupId: 'g', alias: 'Lab Bastion', host: '127.0.0.1', port: PORT, username: 'kshuser', sshConfig: true, tags: ['lab'], notes: '컨테이너 베스천' },
      // 대상: 베스천을 거쳐 컨테이너 안의 127.0.0.1:22 로 — UI 에서 켠다
      { ...base, id: 'target', groupId: 'g', alias: '내부 서버', host: '127.0.0.1', port: 22, username: 'kshuser', jumpHostId: 'bastion', keepaliveSec: 15 },
      // 끈 서버(기본값)
      { ...base, id: 'other', groupId: null, alias: 'other', host: '10.9.9.9', port: 22, username: 'x' }
    ]
  })

  // 0) 앱 설정 기본값은 자동 동기화 꺼짐 — 대상 서버가 있어도 이 PC 의 ~/.ssh 를 건드리지 않는다
  assert.equal((await call('store:get')).settings.sshConfigAutoSync, false)
  await sleep(1200)
  assert(!existsSync(confPath), '자동 동기화가 꺼져 있으면 쓰지 않는다')
  assert.equal(readFileSync(configPath, 'utf8'), original)
  console.log('0. auto sync is off by default; nothing written')

  // 1) 자동 동기화를 켜면 처음부터 켠 서버만, 사용자 config 는 그대로 + 맨 앞 Include
  await call('store:patch', { settings: { ...(await call('store:get')).settings, sshConfigAutoSync: true } })
  await waitFile(() => conf().includes('Host Lab-Bastion'), 'bastion written')
  assert.doesNotMatch(conf(), /Host (other|target|내부)/)
  const cfg1 = readFileSync(configPath, 'utf8')
  assert(cfg1.startsWith('# BrightTerm: 아래 Include 는 BrightTerm 이 관리합니다'))
  assert(cfg1.endsWith(original), '사용자 config 내용 보존')
  console.log('1. only enabled host written; user config kept, Include prepended')

  // 2) 서버 편집 → 고급 → .ssh/config 동기화 토글 + Host 이름 (IPC 로 넣은 서버를 화면에 읽힌다)
  await page.reload()
  await page.waitForSelector('.welcome')
  await page.locator('.sidebar [data-host="target"]').click()
  await page.keyboard.press('F2')
  await page.locator('.mtabs button', { hasText: '고급' }).click()
  const box = page.locator('.ssh-config-sync')
  await box.scrollIntoViewIfNeeded()
  assert.equal(await box.locator('.switch.on').count(), 0, '기본값은 대상 아님')
  await box.locator('.switch').click()
  await box.locator('input').fill('bt-inner')
  await box.getByText('ssh bt-inner 로 접속합니다').waitFor()
  await box.getByText(/자동 동기화 · 현재 1개 서버 반영됨/).waitFor()
  assert.equal(await box.locator('.ssh-config-manual').count(), 0, '자동 동기화 중에는 수동 버튼이 없다')
  if (process.env.BT_SCREENSHOT) await page.screenshot({ path: process.env.BT_SCREENSHOT })
  await page.locator('.modal').getByRole('button', { name: '저장', exact: true }).first().click()
  await waitFile(() => conf().includes('Host bt-inner'), 'target written')
  const text = conf()
  const inner = text.slice(text.indexOf('Host bt-inner'))
  assert.match(inner, /# BrightTerm 별칭: 내부 서버/)
  assert.match(inner, /# 그룹: 테스트 그룹/)
  assert.match(inner, /  ProxyJump Lab-Bastion\n/)
  assert.match(inner, /  ServerAliveInterval 15\n/)
  assert.match(text, /Host Lab-Bastion[\s\S]*# 태그: lab[\s\S]*# 메모: 컨테이너 베스천/)
  console.log('2. UI toggle + Host name saved; extra info kept as comments')

  // 3) 실제 OpenSSH: 해석 결과와 ProxyJump 경유 접속
  const g = sshG('bt-inner')
  assert.equal(g.hostname, '127.0.0.1')
  assert.equal(g.port, '22')
  assert.equal(g.user, 'kshuser', 'Include 가 Host * 보다 먼저 읽혀 서버별 User 가 적용된다')
  assert.equal(g.proxyjump, 'Lab-Bastion')
  assert.equal(g.serveraliveinterval, '15')
  assert.equal(g.serveralivecountmax, '7', '사용자 전역 옵션도 그대로 적용된다')
  const r = run('ssh', ['-F', slash(configPath), 'bt-inner', 'echo BT_OK $(hostname) "$KSH_VERSION"'], { timeout: 30000, env: sshEnv })
  assert.match(r.stdout, /BT_OK \S+ Version AJM 93u\+m/)
  console.log(`3. ssh -G resolved; real login via ProxyJump: ${r.stdout.trim()}`)

  // 4) 끄면 빠지고, 모두 끄면 앱이 만든 파일·Include 를 걷어 내 원래 config 로
  let hosts = (await call('store:get')).hosts
  await call('store:patch', { hosts: hosts.map((h) => (h.id === 'target' ? { ...h, sshConfig: undefined } : h)) })
  await waitFile(() => !conf().includes('Host bt-inner'), 'target removed')
  assert.match(conf(), /Host Lab-Bastion/)
  hosts = (await call('store:get')).hosts
  await call('store:patch', { hosts: hosts.map((h) => ({ ...h, sshConfig: undefined })) })
  await waitFile(() => !existsSync(confPath), 'brightterm.conf removed')
  assert.equal(readFileSync(configPath, 'utf8'), original, '원래 config 로 복원')
  console.log('4. disabling removes entries; none left restores the original config')

  // 5) 자동 동기화를 끄면 서버를 바꿔도 쓰지 않고, 서버 편집의 버튼으로 이 서버만 반영·빼기
  await call('store:patch', { settings: { ...(await call('store:get')).settings, sshConfigAutoSync: false } })
  hosts = (await call('store:get')).hosts
  await call('store:patch', { hosts: hosts.map((h) => (h.id === 'target' ? { ...h, sshConfig: true, sshConfigName: 'bt-inner' } : h)) })
  await sleep(1200)
  assert(!existsSync(confPath), '자동 동기화를 끄면 저장해도 쓰지 않는다')
  await page.reload()
  await page.waitForSelector('.welcome')
  await page.locator('.sidebar [data-host="target"]').click()
  await page.keyboard.press('F2')
  await page.locator('.mtabs button', { hasText: '고급' }).click()
  const manual = page.locator('.ssh-config-manual')
  await manual.scrollIntoViewIfNeeded()
  await manual.getByText(/자동 동기화가 꺼져 있습니다\. 이 서버는 아직 config 에 없습니다/).waitFor()
  await manual.getByRole('button', { name: 'config에 반영' }).click()
  await waitFile(() => conf().includes('Host bt-inner'), 'manual apply')
  await manual.getByRole('button', { name: 'config 다시 반영' }).waitFor()
  // 베스천은 동기화 대상이 아니므로 ProxyJump 는 주소로
  assert.match(conf(), new RegExp(`  ProxyJump kshuser@127\\.0\\.0\\.1:${PORT}\\n`))
  assert.doesNotMatch(conf(), /^Host Lab-Bastion$/m)
  // ssh -G 는 주소를 [127.0.0.1] 로 감싸 출력한다
  assert.match(sshG('bt-inner').proxyjump, new RegExp(`^kshuser@\\[?127\\.0\\.0\\.1\\]?:${PORT}$`))
  const r2 = run('ssh', ['-F', slash(configPath), 'bt-inner', 'echo BT_MANUAL_OK'], { timeout: 30000, env: sshEnv })
  assert.match(r2.stdout, /BT_MANUAL_OK/)
  // 대상을 끄면 버튼이 '빼기'로 — 이 서버만 빼고, 남은 게 없으면 원래 config 로
  await page.locator('.ssh-config-sync .switch').first().click()
  await manual.getByRole('button', { name: 'config에서 빼기' }).click()
  await waitFile(() => !existsSync(confPath), 'manual remove')
  assert.equal(readFileSync(configPath, 'utf8'), original)
  await page.locator('.modal').getByRole('button', { name: '취소' }).click()
  console.log('5. auto off: saving does not write; per-server button applies (real login) and removes')

  assert.deepEqual(errors, [])
  console.log('PASS: server list synced to ~/.ssh/config')
} finally {
  await closeApp(app)
  spawnSync('podman', ['rm', '-f', NAME])
  rmSync(data, { recursive: true, force: true })
}
