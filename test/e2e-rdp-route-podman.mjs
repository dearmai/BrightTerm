// npm run build && node test/e2e-rdp-route-podman.mjs
// RDP 경로 — 점프 호스트 경유, 이 서버의 SSH 터널. podman 의 sshd(ksh 이미지)와 같은 네트워크 공간에 xrdp 를 띄워
// sshd 컨테이너 안에서만 127.0.0.1:3389 로 xrdp 에 닿게 한다(이 PC 에서 3389 로 바로는 못 간다).
// 필요: podman, test/podman/ksh 이미지(없으면 만든다), docker.io/scottyhardy/docker-remote-desktop
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright-core'
import { closeApp } from './close-app.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const SSHD = 'bt-rdp-jump'
const XRDP = 'bt-rdp-behind'
const SSH_PORT = 12422
const IMAGE = 'localhost/bt-ksh-sshd:test'
const podman = (...a) => execFileSync('podman', a, { encoding: 'utf8' }).trim()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const data = mkdtempSync(join(tmpdir(), 'bt-rdp-route-'))
let app, page
let trusting = false
let trusted = 0
const errors = []
const call = (channel, ...args) => page.evaluate(({ channel, args }) => window.bt.call(channel, ...args), { channel, args })
const rdp = { mode: 'builtin', port: 3389, auth: 'own', clipboard: true, resolution: '1280x720', route: 'direct', openIn: 'window' }
const base = { groupId: null, protocol: 'ssh', host: '127.0.0.1', port: SSH_PORT, username: 'kshuser', authType: 'password', tags: [], encoding: 'utf-8', termType: 'xterm-256color', keepaliveSec: 0, forwards: [], sort: 0 }

async function connectWindow(hostId, trust) {
  const winP = app.waitForEvent('window', { predicate: (w) => w.url().includes('rdp.html'), timeout: 40000 })
  const opened = call('rdp:open', hostId)
  void trust
  const r = await opened
  const w = await winP
  w.on('pageerror', (e) => errors.push(`rdp: ${e.message}`))
  await w.waitForSelector('.rdp-bar .dot.connected', { timeout: 60000 })
  const label = await w.locator('.rdp-sub').innerText()
  await w.getByRole('button', { name: '연결 끊기' }).click()
  const closed = new Promise((res) => w.once('close', res))
  await w.getByRole('button', { name: '창 닫기' }).click()
  await Promise.race([closed, sleep(8000)])
  return { r, label }
}

try {
  for (const n of [XRDP, SSHD]) try { podman('rm', '-f', n) } catch { /* */ }
  if (spawnSync('podman', ['image', 'exists', IMAGE]).status !== 0) podman('build', '-t', IMAGE, '-f', join(here, 'podman', 'ksh', 'Containerfile'), join(here, 'podman', 'ksh'))
  podman('run', '-d', '--name', SSHD, '-p', `127.0.0.1:${SSH_PORT}:22`, IMAGE)
  podman('run', '-d', '--name', XRDP, '--network', `container:${SSHD}`, '--shm-size=1g', 'docker.io/scottyhardy/docker-remote-desktop:latest')

  app = await electron.launch({ args: ['.', '--password-store=basic'], env: { ...process.env, BRIGHTTERM_DATA: data } })
  page = await app.firstWindow()
  page.on('pageerror', (e) => errors.push(e.message))
  await page.waitForSelector('.lock-card')
  await page.evaluate(() => localStorage.setItem('bt.importOffered', '1'))
  await call('vault:setup', 'Route!2026')
  await call('vault:unlock', 'Route!2026')
  const sshCred = await call('cred:save', { name: 'ksh', kind: 'password', username: 'kshuser', password: 'KshPass!1' })
  const rdpCred = await call('cred:save', { name: 'xrdp', kind: 'password', username: 'ubuntu', password: 'ubuntu' })
  const store = await call('store:get')
  await call('store:patch', {
    settings: { ...store.settings, checkUpdates: false },
    hosts: [
      { ...base, id: 'jump', alias: 'bastion', credentialId: sshCred.id },
      // 점프 호스트 안쪽의 Windows — 주소 127.0.0.1 은 베스천에서 본 주소
      { ...base, id: 'via-jump', alias: '베스천 뒤 윈도우', host: '127.0.0.1', port: 22, jumpHostId: 'jump', os: 'windows', rdp: { ...rdp, username: 'ubuntu', credentialId: rdpCred.id } },
      // 이 서버의 SSH 로 접속해 127.0.0.1:3389 터널
      { ...base, id: 'via-ssh', alias: 'SSH 터널 윈도우', credentialId: sshCred.id, os: 'windows', rdp: { ...rdp, route: 'ssh', username: 'ubuntu', credentialId: rdpCred.id } }
    ]
  })
  await page.reload()
  await page.waitForSelector('.welcome')
  // 베스천의 SSH 호스트 키·RDP 인증서 — 처음 보는 것이라 묻는다. 나오는 대로 신뢰한다
  trusting = true
  ;(async () => {
    while (trusting) {
      const b = page.getByRole('button', { name: '신뢰하고 접속' })
      if (await b.count().catch(() => 0)) { await b.first().click().catch(() => {}); trusted++ }
      await sleep(300)
    }
  })()

  // 이 PC 에서 3389 로는 닿지 않는다
  const direct = await call('rdp:check', { ...base, id: 'd', host: '127.0.0.1', os: 'windows', rdp: { ...rdp, port: 3389 } })
  assert.notEqual(direct.state, 'ok', '이 PC 의 3389 가 열려 있어 경로 검증이 의미 없습니다')

  // xrdp 준비
  const hosts = (await call('store:get')).hosts
  let jumpCheck
  for (let i = 0; i < 60; i++) {
    jumpCheck = await call('rdp:check', hosts.find((h) => h.id === 'via-jump'))
    if (jumpCheck.state === 'ok') break
    await sleep(1000)
  }
  assert.equal(jumpCheck.state, 'ok', JSON.stringify(jumpCheck))
  assert.match(jumpCheck.route, /^점프 호스트 bastion → 127\.0\.0\.1:3389$/)
  console.log('jump check:', jumpCheck.route, jumpCheck.security)

  const sshCheck = await call('rdp:check', hosts.find((h) => h.id === 'via-ssh'))
  assert.equal(sshCheck.state, 'ok', JSON.stringify(sshCheck))
  assert.match(sshCheck.route, /^SSH 터널 \(SSH 터널 윈도우\) → 127\.0\.0\.1:3389$/)
  assert.equal(sshCheck.fingerprint, jumpCheck.fingerprint)
  console.log('ssh check:', sshCheck.route)

  // 두 경로로 내장 창 연결 — 인증서 신뢰 키는 서버 주소:RDP포트 라 두 번째는 묻지 않는다
  const a = await connectWindow('via-jump', true)
  assert.match(a.label, /점프 호스트 bastion/)
  const b = await connectWindow('via-ssh', false)
  assert.match(b.label, /SSH 터널/)
  console.log('connected via', a.label, '/', b.label)

  // 경로 SSH 연결이 정리됐는지 — 창을 닫은 뒤 sshd 의 kshuser 세션이 남지 않는다
  await sleep(1500)
  const left = podman('exec', SSHD, 'sh', '-c', "ps -eo user,args | grep '^kshuser' | grep sshd | grep -v grep | wc -l")
  assert.equal(left, '0', `남은 SSH 세션 ${left}`)

  trusting = false
  console.log('trust prompts accepted:', trusted)
  assert.deepEqual(errors, [])
  console.log('e2e-rdp-route-podman OK')
} catch (e) {
  console.error(e)
  console.error('page errors:', errors)
  process.exitCode = 1
} finally {
  trusting = false
  await closeApp(app)
  for (const n of [XRDP, SSHD]) try { podman('rm', '-f', n) } catch { /* */ }
  rmSync(data, { recursive: true, force: true })
}
