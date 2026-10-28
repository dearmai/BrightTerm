import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { startupLines, startupPlan } from '../src/main/persist.ts'
import { typeStartup } from '../src/main/startup.ts'

const fast = { firstMs: 20, quietMs: 30, maxWaitMs: 400, pollMs: 5 }
const host = { id: 'h1', alias: 'web', protocol: 'ssh', startupCommand: 'export LANG=ko_KR.UTF-8\r\n\n# 주석\n  cd /var/www  \nsudo -i' }

/** 줄마다 서버가 바로 응답하는 가짜 셸 — reply 가 그 줄의 응답 */
function fakeShell(reply = () => '$ ') {
  const io = { sent: [], at: [], notices: [], last: 0, out: '', open: true }
  return Object.assign(io, {
    write(line) { io.sent.push(line); io.at.push(Date.now()); setTimeout(() => { io.out += reply(line); io.last = Date.now() }, 5) },
    lastOutputAt: () => io.last, tail: () => io.out, alive: () => io.open, notice: (m) => io.notices.push(m)
  })
}

test('빈 줄·# 주석은 빼고 줄 끝 공백만 지운다', () => {
  assert.deepEqual(startupLines(host), ['export LANG=ko_KR.UTF-8', '  cd /var/www', 'sudo -i'])
  assert.deepEqual(startupLines({}), [])
  assert.deepEqual(startupPlan({ ...host, persist: false }), startupLines(host))
})

test('세션 유지: 한 줄로 tmux 에 붙고, 새 세션에만 1초 간격으로 넣는다', () => {
  const [line, ...rest] = startupPlan({ ...host, persist: true })
  assert.equal(rest.length, 0)
  assert.equal(line.match(/sleep 1; tmux send-keys/g).length, 3)
  assert.match(line, /\} >\/dev\/null 2>&1 & \}/)
  execFileSync('sh', ['-n'], { input: line })
  execFileSync('sh', ['-n'], { input: startupPlan({ ...host, persist: true, startupCommand: '' })[0] })
})

test('응답을 기다려 한 줄씩 보낸다', async () => {
  const io = fakeShell()
  assert.equal(await typeStartup(['a', 'b', 'c'], io, fast), 3)
  assert.deepEqual(io.sent, ['a\r', 'b\r', 'c\r'])
  for (let i = 1; i < io.at.length; i++) assert(io.at[i] - io.at[i - 1] >= fast.quietMs, '줄 사이에 응답을 기다린다')
})

test('비밀번호 프롬프트에서 멈춘다', async () => {
  const io = fakeShell((line) => (line.startsWith('sudo') ? '[sudo] password for tester: ' : '$ '))
  assert.equal(await typeStartup(['cd /', 'sudo -i', 'whoami', 'ls'], io, fast), 2)
  assert.deepEqual(io.sent, ['cd /\r', 'sudo -i\r'])
  assert.match(io.notices[0], /2줄은 보내지 않았습니다/)
})

test('끊기면 남은 줄을 버리고, 출력이 계속되면 최대 대기 뒤 보낸다', async () => {
  const io = fakeShell()
  io.write = (line) => { io.sent.push(line); io.open = false }
  assert.equal(await typeStartup(['a', 'b'], io, fast), 1)
  const busy = fakeShell()
  const timer = setInterval(() => { busy.last = Date.now() }, 5)
  const start = Date.now()
  await typeStartup(['x', 'y'], busy, fast)
  clearInterval(timer)
  assert.deepEqual(busy.sent, ['x\r', 'y\r'])
  assert(Date.now() - start >= fast.maxWaitMs, '계속 출력되면 maxWaitMs 까지 기다린다')
})
