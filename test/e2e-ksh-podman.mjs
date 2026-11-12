// npm run build && node test/e2e-ksh-podman.mjs
// 실제 OpenSSH + ksh 로그인 셸(podman 컨테이너)에서 셸에 의존하는 기능을 앱으로 확인한다.
//   - 서버 환경 감지(로그인 셸·매뉴얼 추천), 상태 표시줄 지표
//   - 여러 줄 자동 실행 명령(ksh 문법), 유휴 방지 + TMOUT 조회, TMOUT 경고 뒤 구조
//   - SFTP(서브시스템을 로그인 셸 -c 로 실행), SFTP 없는 서버의 셸 명령 파일 관리
//   - tmux 세션 유지(ksh 에서 입력하는 한 줄, 다시 붙기, 종료)
// 필요: podman (머신 실행 중). 이미지는 test/podman/ksh/ 에서 만든다.
//   Containerfile        리눅스 ksh: /bin/ksh = ksh93u+m, /bin/mksh
//   Containerfile.aix72  AIX 7.2 근사: /usr/bin/ksh93 = 93t+ 2009-05-01, /usr/bin/ksh = pdksh(ksh88 대용)
// KSH_SHELLS=ksh93,mksh,aix-ksh93t,aix-ksh88-pdksh 로 검증할 셸을 고른다 (기본: 전부). KSH_REBUILD=1 이면 이미지를 다시 만든다.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright-core'
import { manualsFor } from '../src/renderer/src/manuals/manual.ts'

const here = dirname(fileURLToPath(import.meta.url))
const PASSWORD = 'KshPass!1'
const base = 20000 + (process.pid % 20000)
const SERVERS = {
  linux: { image: 'localhost/bt-ksh-sshd:test', file: 'Containerfile', hostname: 'ksh-linux', port: base, nosftp: base + 1 },
  aix72: { image: 'localhost/bt-aix72-ksh-sshd:test', file: 'Containerfile.aix72', hostname: 'aix72', port: base + 2, nosftp: base + 3 }
}
for (const [key, sv] of Object.entries(SERVERS)) sv.name = `bt-ksh-${key}-${process.pid}`
// AIX 사이트에서 흔한 'user@host [경로] ' 프롬프트 — 유휴 방지의 프롬프트 판별을 함께 확인한다
const AIX_PS1 = 'PS1="${LOGNAME}@$(hostname) [\\${PWD}] "'
// warns: TMOUT 이 다 되면 경고를 찍고 60초 더 기다리는 셸. tmux: 패널의 프로세스 이름
const SHELLS = {
  ksh93: { server: 'linux', user: 'kshuser', path: '/bin/ksh', version: /93u\+m/, warns: true, tmux: 'ksh' },
  mksh: { server: 'linux', user: 'mkshuser', path: '/bin/mksh', version: /MIRBSD KSH/, warns: false, tmux: 'mksh' },
  'aix-ksh93t': { server: 'aix72', user: 'aixksh93', path: '/usr/bin/ksh93', version: /93t\+ 2009-05-01/, warns: true, tmux: 'ksh93', ps1: AIX_PS1 },
  'aix-ksh88-pdksh': { server: 'aix72', user: 'aixksh', path: '/usr/bin/ksh', version: /PD KSH v5\.2\.14/, warns: false, tmux: 'ksh', ps1: AIX_PS1 }
}
const pick = (process.env.KSH_SHELLS ?? Object.keys(SHELLS).join(',')).split(',').map((s) => s.trim()).filter(Boolean)
for (const s of pick) if (!SHELLS[s]) throw new Error(`알 수 없는 셸: ${s}`)

function podman(args, input) {
  const r = spawnSync('podman', args, { encoding: 'utf8', input })
  if (r.status !== 0) throw new Error(`podman ${args.join(' ')}: ${r.stderr || r.stdout}`)
  return r.stdout
}
let NAME
const asUser = (user, script, input) => podman(['exec', ...(input === undefined ? [] : ['-i']), '-u', user, '-w', `/home/${user}`, NAME, 'sh', '-c', script], input)
/** 로그인 셸이 읽는 ~/.profile — 단계마다 TMOUT 을 바꾼다 */
const setProfile = (user, lines) => asUser(user, 'cat > ~/.profile', lines.map((l) => l + '\n').join(''))
const logsOf = (name) => { const r = spawnSync('podman', ['logs', name], { encoding: 'utf8' }); return r.stdout + r.stderr }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const count = (text, re) => (text.match(new RegExp(re, 'g')) ?? []).length

const used = [...new Set(pick.map((s) => SHELLS[s].server))].map((k) => SERVERS[k])
for (const sv of used) {
  if (process.env.KSH_REBUILD || spawnSync('podman', ['image', 'exists', sv.image]).status !== 0) {
    podman(['build', '-t', sv.image, '-f', join(here, 'podman', 'ksh', sv.file), join(here, 'podman', 'ksh')])
  }
  podman(['run', '-d', '--rm', '--name', sv.name, '--hostname', sv.hostname, '-p', `127.0.0.1:${sv.port}:22`, '-p', `127.0.0.1:${sv.nosftp}:2222`, sv.image])
}

const data = mkdtempSync(join(tmpdir(), 'bt-ksh-'))
const local = mkdtempSync(join(tmpdir(), 'bt-ksh-local-'))
let app, page
const errors = []
const results = []
const call = (channel, ...args) => page.evaluate(({ channel, args }) => window.bt.call(channel, ...args), { channel, args })
const info = (id) => page.evaluate((id) => window.__infos[id], id)
const out = (id) => page.evaluate((id) => window.__out[id] ?? '', id)
const write = (id, text) => page.evaluate(({ id, text }) => window.bt.write(id, text), { id, text })
const waitState = (id, states, timeout = 20000) => page.waitForFunction(({ id, states }) => states.includes(window.__infos[id]?.state), { id, states }, { timeout })
const waitOut = (id, re, timeout = 20000) => page.waitForFunction(({ id, re }) => new RegExp(re).test(window.__out[id] ?? ''), { id, re: re.source ?? re }, { timeout })
const step = (shell, name, detail = '') => { results.push(`${shell}: ${name}`); console.log(`  ok ${name}${detail ? ` — ${detail}` : ''}`) }

let credId
const baseHost = {
  groupId: null, protocol: 'ssh', host: '127.0.0.1', authType: 'password', tags: [], encoding: 'utf-8',
  termType: 'xterm-256color', keepaliveSec: 0, forwards: [], sort: 0, persist: false, autoReconnect: false
}
async function saveHost(host) {
  const store = await call('store:get')
  await call('store:patch', { hosts: [...store.hosts.filter((h) => h.id !== host.id), { ...baseHost, credentialId: credId, ...host }] })
}
/** 처음 보는 호스트 키(포트마다 한 번)는 신뢰한다 */
async function open(hostId, opts = {}) {
  const s = await call('session:open', { hostId, cols: 100, rows: 30, ...opts })
  const trust = page.locator('button:has-text("신뢰하고 접속")')
  for (let i = 0; i < 100; i++) {
    const st = (await info(s.id))?.state
    if (st === 'connected' || st === 'error' || st === 'closed') break
    if (await trust.count()) await trust.click().catch(() => {})
    await sleep(100)
  }
  await waitState(s.id, ['connected'])
  return s.id
}

try {
  for (const sv of used) for (let i = 0; i < 50 && count(logsOf(sv.name), 'Server listening on 0\\.0\\.0\\.0 port') < 2; i++) await sleep(200)
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
  await call('vault:setup', 'KshCompat!2026')
  await call('vault:unlock', 'KshCompat!2026')
  const store = await call('store:get')
  await call('store:patch', { settings: { ...store.settings, checkUpdates: false } })

  for (const shell of pick) {
    const { server, user, path, version, warns, tmux, ps1 } = SHELLS[shell]
    const sv = SERVERS[server]
    NAME = sv.name
    const ver = asUser(user, `${path} -c 'echo "$KSH_VERSION"'`).trim()
    assert.match(ver, version)
    console.log(`\n[${shell}] ${user}@${sv.hostname} ${path} — ${ver}`)
    const prof = (...lines) => setProfile(user, ps1 ? [ps1, ...lines] : lines)
    credId = (await call('cred:save', { name: user, kind: 'password', username: user, password: PASSWORD })).id

    // ── 1. 일반 접속: 서버 환경, 지표, SFTP, 자동 실행, TMOUT 조회, 유휴 방지 ──
    prof('TMOUT=8', 'export TMOUT')
    const hostA = `${shell}-main`
    await saveHost({
      id: hostA, alias: `${shell} main`, port: sv.port, username: user,
      // ksh 문법: 산술 확장, typeset -u, print -r --
      startupCommand: ['print -r -- "BT_START_$((6*7))"', '# 주석 줄은 보내지 않는다', 'typeset -u up=ksh; echo "BT_UP_$up"'].join('\n'),
      idleCommandSec: 2, idleCommand: 'echo "BT_IDLE_$((1+1))"'
    })
    const a = await open(hostA)
    const connectedAt = Date.now()
    await waitOut(a, /BT_START_42[\s\S]*BT_UP_KSH/)
    step(shell, '자동 실행 명령(ksh 문법)', 'BT_START_42, BT_UP_KSH')
    if (ps1) assert.match(await out(a), new RegExp(`${user}@${sv.hostname} \\[/home/${user}\\] `))

    await waitOut(a, /TMOUT=8초/)
    assert.doesNotMatch(await out(a), /TMOUT 값을 확인하지 못했습니다|TMOUT 자동 조회를 건너뛰었습니다/)
    step(shell, 'TMOUT 조회', `TMOUT=8초${ps1 ? ' (AIX형 PS1 프롬프트)' : ''}`)

    const env = await call('session:env', a)
    assert.equal(env.os, 'Linux')
    assert.equal(env.shell, path)
    assert.equal(env.distro?.id, 'debian')
    const manuals = manualsFor(env)
    step(shell, '서버 환경 감지', `shell=${env.shell}, 추천 매뉴얼=[${manuals.join(', ')}]`)

    const metrics = await call('session:metrics', a)
    for (const k of ['pingMs', 'cpu', 'memory', 'disk', 'uptimeSec']) assert.notEqual(metrics[k], null, `metrics.${k}`)
    step(shell, '상태 표시줄 지표', `cpu=${metrics.cpu} mem=${metrics.memory} disk=${metrics.disk} ping=${metrics.pingMs}ms`)

    await page.waitForFunction((id) => window.__infos[id]?.sftp === 'ok', a)
    const home = await call('sftp:home', a)
    assert.equal(home, `/home/${user}`)
    const up = join(local, `${shell}-sftp.txt`)
    writeFileSync(up, `sftp via ${shell}\n`)
    await call('sftp:upload', a, [up], '~')
    assert.equal(asUser(user, `cat ~/${shell}-sftp.txt`), `sftp via ${shell}\n`)
    assert((await call('sftp:list', a, '~')).entries.some((e) => e.name === `${shell}-sftp.txt`))
    await call('sftp:remove', a, [`${home}/${shell}-sftp.txt`])
    step(shell, 'SFTP 서브시스템', `home=${home}, 업로드·목록·삭제`)

    // 유휴 방지: TMOUT(8초)보다 짧은 2초 간격으로 보내 TMOUT 을 넘겨도 연결이 유지된다
    await sleep(Math.max(0, connectedAt + 20000 - Date.now()))
    assert.equal((await info(a)).state, 'connected', 'TMOUT 8초를 넘겨도 접속 유지')
    const idles = count(await out(a), 'BT_IDLE_2')
    assert(idles >= 3, `유휴 방지 명령 실행 ${idles}회`)
    step(shell, '유휴 방지(간격 < TMOUT)', `20초 동안 ${idles}회 실행, 접속 유지`)
    await call('session:close', a)

    // ── 2. TMOUT 경고 뒤 구조: 간격이 TMOUT 보다 길 때 ──
    prof('TMOUT=5', 'export TMOUT')
    const hostW = `${shell}-warn`
    await saveHost({ id: hostW, alias: `${shell} warn`, port: sv.port, username: user, idleCommandSec: 600, idleCommand: 'echo "BT_RESCUE_$((2+3))"' })
    const w = await open(hostW)
    await waitOut(w, /TMOUT=5초[^\n]*먼저 로그아웃될 수 있습니다/)
    if (warns) {
      // ksh93(93t+·93u+m) 은 TMOUT 이 다 되면 경고를 찍고 60초를 더 준다 — 경고를 보면 명령을 보내야 한다
      await waitOut(w, /shell will timeout in \d+ seconds/, 15000)
      const warnedAt = Date.now()
      await waitOut(w, /BT_RESCUE_5/, 10000)
      step(shell, 'TMOUT 경고 뒤 유휴 방지 명령', `경고 뒤 ${Date.now() - warnedAt}ms 에 전송`)
      await sleep(3000)
      assert.equal((await info(w)).state, 'connected')
    } else {
      // mksh·pdksh 는 경고 없이 바로 끊는다 — 간격을 TMOUT 보다 짧게 두는 것만 효과가 있다
      await page.waitForFunction((id) => window.__infos[id]?.state !== 'connected', w, { timeout: 20000 })
      assert.match(await out(w), /timed out waiting for input/)
      assert.doesNotMatch(await out(w), /BT_RESCUE_5/)
      step(shell, 'TMOUT 경고 없음(셸 특성)', `경고 없이 종료 — state=${(await info(w)).state}`)
    }
    await call('session:close', w)
    prof()

    // ── 3. SFTP 없는 서버: SSH 명령(로그인 셸 -c)으로 파일 관리 ──
    const hostS = `${shell}-nosftp`
    await saveHost({ id: hostS, alias: `${shell} nosftp`, port: sv.nosftp, username: user })
    const s = await open(hostS)
    await page.waitForFunction((id) => ['shell', 'ok', 'unavailable'].includes(window.__infos[id]?.sftp), s)
    assert.equal((await info(s)).sftp, 'shell')
    const sh = await call('sftp:home', s)
    assert.equal(sh, `/home/${user}`)
    const dir = `${sh}/BT dir '$(id)'`
    await call('sftp:mkdir', s, dir)
    const tricky = ['-dash.txt', "it's a file.txt", '한글 파일.txt', 'space  two.txt', '$HOME*.txt']
    mkdirSync(join(local, shell), { recursive: true })
    const src = tricky.map((name, i) => {
      const p = join(local, shell, name.replace(/[*$]/g, '_'))
      writeFileSync(p, `${i}:${name}\n`)
      return p
    })
    const bin = join(local, shell, 'binary.bin')
    const binData = Buffer.alloc(300 * 1024)
    for (let i = 0; i < binData.length; i++) binData[i] = (i * 31 + 7) & 0xff
    writeFileSync(bin, binData)
    await call('sftp:upload', s, [...src, bin], dir)
    const listed = (await call('sftp:list', s, dir)).entries
    assert.deepEqual(listed.map((e) => e.name).sort(), [...tricky.map((n) => n.replace(/[*$]/g, '_')), 'binary.bin'].sort())
    assert.equal(listed.find((e) => e.name === 'binary.bin').size, binData.length)
    // 셸 확장이 일어나지 않았는지 — 서버 쪽 실제 이름
    assert.match(asUser(user, `ls -1 ~/"BT dir '\\$(id)'"`), /it's a file\.txt/)
    await call('sftp:rename', s, `${dir}/-dash.txt`, `${dir}/-renamed.txt`)
    await call('sftp:chmod', s, `${dir}/-renamed.txt`, 0o640)
    assert((await call('sftp:list', s, dir)).entries.some((e) => e.name === '-renamed.txt'))
    assert.match(asUser(user, `ls -l ~/"BT dir '\\$(id)'"/./-renamed.txt`), /^-rw-r-----/)
    const preview = await call('sftp:preview', s, `${dir}/한글 파일.txt`)
    assert.deepEqual(preview, { kind: 'text', data: '2:한글 파일.txt\n' })
    const downDir = join(local, `${shell}-down`)
    mkdirSync(downDir)
    await call('sftp:download', s, [`${dir}/binary.bin`, `${dir}/it's a file.txt`], downDir)
    assert(readFileSync(join(downDir, 'binary.bin')).equals(binData), 'binary round trip')
    assert.equal(readFileSync(join(downDir, "it's a file.txt"), 'utf8'), "1:it's a file.txt\n")
    await call('sftp:remove', s, [dir])
    assert.equal(asUser(user, 'ls -A ~ | grep -c "^BT dir" || true').trim(), '0')
    step(shell, 'SFTP 없는 서버의 셸 명령 파일 관리', `특수 문자 이름 ${tricky.length}개, 300KB 바이너리 왕복, 이름 변경·권한·미리보기·삭제`)
    await call('session:close', s)

    // ── 4. tmux 세션 유지 ──
    const hostT = `${shell}-tmux`
    await saveHost({ id: hostT, alias: `${shell} tmux`, port: sv.port, username: user, persist: true, startupCommand: 'echo "BT_IN_TMUX_$((3*3))"; export BT_MARK=kept' })
    const t1 = await open(hostT)
    await waitOut(t1, /BT_IN_TMUX_9/)
    const tmuxName = (await info(t1)).tmuxSession
    assert.equal(tmuxName, `bt-${shell}-tmux`)
    assert.match(asUser(user, 'tmux ls'), new RegExp(`^${tmuxName}:`, 'm'))
    assert.equal(asUser(user, `tmux display -p -t '=${tmuxName}:' '#{pane_current_command}'`).trim(), tmux)
    await call('session:close', t1)
    await sleep(500)
    assert.match(asUser(user, 'tmux ls'), new RegExp(`^${tmuxName}:`, 'm'), '창을 닫아도 tmux 세션 유지')
    const t2 = await open(hostT, { tmux: 'auto' })
    assert.equal((await info(t2)).tmuxSession, tmuxName)
    await sleep(800)
    await write(t2, 'echo "BT_MARK_$BT_MARK"\r')
    await waitOut(t2, /BT_MARK_kept/)
    await call('session:close', t2, true)
    await sleep(500)
    assert.doesNotMatch(spawnSync('podman', ['exec', '-u', user, NAME, 'tmux', 'ls'], { encoding: 'utf8' }).stdout, new RegExp(`^${tmuxName}:`, 'm'))
    step(shell, 'tmux 세션 유지', `${tmuxName} 생성 → 닫기 후 유지 → 다시 붙어 변수 확인 → 종료`)
  }

  assert.deepEqual(errors, [])
  console.log(`\nPASS: ${results.length} checks on ${pick.join(', ')}`)
} catch (e) {
  if (page) {
    const ids = await page.evaluate(() => Object.keys(window.__out)).catch(() => [])
    const last = ids[ids.length - 1]
    if (last) console.error(`--- terminal output (${last}) ---\n` + (await out(last)).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').slice(-3000))
  }
  throw e
} finally {
  await app?.close().catch(() => {})
  for (const sv of used) spawnSync('podman', ['rm', '-f', sv.name])
  rmSync(data, { recursive: true, force: true })
  rmSync(local, { recursive: true, force: true })
}
