import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startupPlan, tmuxMouseScript } from '../src/main/persist.ts'

const binary = process.env.BRIGHTTERM_TEST_TMUX || 'tmux'
const available = spawnSync(binary, ['-V']).status === 0
const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'"

test('실제 tmux: 최초 접속·재접속·마우스 전환은 선택한 세션에만 적용한다', { skip: !available }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'bt-mouse-'))
  // 소켓 경로 길이 제한과 기존 사용자 tmux 세션 간섭을 피한다.
  const socket = join(root, 's')
  const env = { ...process.env, TMUX: '', TMUX_PANE: '', PATH: `${root}:${process.env.PATH}` }
  const real = execFileSync('/usr/bin/which', [binary], { encoding: 'utf8' }).trim()
  const args = ['-S', socket, '-f', '/dev/null']
  const tmux = (...command) => execFileSync(real, [...args, ...command], { env, encoding: 'utf8' }).trim()
  const attached = join(root, 'attached')
  // attach는 TTY가 필요해 호출만 기록하고, 나머지는 실제 tmux에 전달한다.
  writeFileSync(join(root, 'tmux'), `#!/bin/sh\nif [ "$1" = attach-session ]; then printf '%s\\n' "$*" >> ${quote(attached)}; exit 0; fi\nexec ${quote(real)} -S ${quote(socket)} -f /dev/null "$@"\n`, { mode: 0o755 })
  const marker = join(root, 'startup')
  const host = { id: 'mouse-test', protocol: 'ssh', alias: 'mouse', persist: true, startupCommand: `printf x >> ${quote(marker)}` }
  const run = (script) => execFileSync('/bin/sh', ['-c', script], { env, encoding: 'utf8' })
  try {
    // 似た名前の別セッションを変えないことも確認する。
    tmux('new-session', '-d', '-s', 'bt-mouse-other', 'sleep 60')
    tmux('set-option', '-t', '=bt-mouse-other:', 'mouse', 'off')
    run(startupPlan(host)[0])
    assert.equal(tmux('show-options', '-v', '-t', '=bt-mouse:', 'mouse'), 'on')
    assert.equal(tmux('show-options', '-v', '-t', '=bt-mouse:', 'status'), 'off')
    for (let i = 0; i < 50 && !existsSync(marker); i++) await new Promise((r) => setTimeout(r, 100))
    assert.equal(readFileSync(marker, 'utf8'), 'x')
    run(tmuxMouseScript('bt-mouse', false))
    assert.equal(tmux('show-options', '-v', '-t', '=bt-mouse:', 'mouse'), 'off')
    run(startupPlan(host)[0])
    assert.equal(tmux('show-options', '-v', '-t', '=bt-mouse:', 'mouse'), 'on')
    run(startupPlan({ ...host, persistMouse: false })[0])
    assert.equal(tmux('show-options', '-v', '-t', '=bt-mouse:', 'mouse'), 'off')
    run(tmuxMouseScript('bt-mouse', true))
    assert.equal(tmux('show-options', '-v', '-t', '=bt-mouse:', 'mouse'), 'on')
    assert.equal(tmux('show-options', '-v', '-t', '=bt-mouse-other:', 'mouse'), 'off')
    assert.equal(readFileSync(marker, 'utf8'), 'x')
    assert.equal(readFileSync(attached, 'utf8').trim().split('\n').length, 3)
  } finally {
    spawnSync(real, [...args, 'kill-server'], { env })
    rmSync(root, { recursive: true, force: true })
  }
})
