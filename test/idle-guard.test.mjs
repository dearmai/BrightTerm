import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isShellPrompt, isTerminalReport, nextAltScreen, shouldSendIdleCommand } from '../src/main/idleGuard.ts'

const ready = { tail: 'done\r\n$ ', altScreen: false, lineOpen: false, idleMs: 300000, intervalMs: 240000 }

test('셸 프롬프트로 보는 줄', () => {
  for (const tail of ['$ ', '# ', '% ', 'out\r\nuser@aix72:/home/user $ ', '[root@web ~]# ', 'aix72:/tmp> ', '\x1b[32muser@web\x1b[0m:~$ ', '\x1b[H\x1b[2J$ ', '\x1b[?2004huser@web:~$ ', 'viewer@eaiap01t [/eai/viewer] ', 'out\r\nviewer@eaiap01t [~] ', 'postgres@db:~$ ', 'mysql@db $ ', 'ftpuser@host> ']) {
    assert.equal(isShellPrompt(tail), true, JSON.stringify(tail))
  }
})

test('셸 프롬프트가 아닌 줄', () => {
  for (const tail of [
    '', '$ sleep 1000\r\n', '> ', 'SQL> ', 'RMAN> ', 'mysql> ', '    -> ', 'postgres=# ', 'postgres-# ', 'sftp> ', 'ftp> ', '>>> ',
    'Password: ', 'password> ', 'Enter passphrase: ', 'login: ', 'Continue? > ', '--More--', '(END)', ':', 'Downloading 100%',
    '"a.txt" 10 lines, 100 characters', 'price $\x1b[24;1H', 'price $\x1b[1;1H', '$ ls',
    'Continue [y/n] ', 'Save as [/tmp/x] ', 'Overwrite [yes/no] ', 'viewer@eaiap01t [/eai/viewer] ls'
  ]) {
    assert.equal(isShellPrompt(tail), false, JSON.stringify(tail))
  }
})

test('간격이 지나고 조건이 맞을 때만 보낸다', () => {
  assert.equal(shouldSendIdleCommand(ready), true)
  assert.equal(shouldSendIdleCommand({ ...ready, idleMs: 239000 }), false)
  assert.equal(shouldSendIdleCommand({ ...ready, altScreen: true }), false)
  assert.equal(shouldSendIdleCommand({ ...ready, lineOpen: true }), false)
  assert.equal(shouldSendIdleCommand({ ...ready, tail: 'SQL> ' }), false)
})

test('ksh 경고가 보이면 간격 전이라도 보내되, 입력 중이거나 대체 화면이면 안 보낸다', () => {
  for (const tail of ['ksh: shell will time out in 60 seconds', '\x07ksh: shell will time out in 60 seconds\r\n', 'shell will time out in 60 seconds\r\n$ ']) {
    const warned = { ...ready, tail, idleMs: 3000 }
    assert.equal(shouldSendIdleCommand(warned), true, JSON.stringify(tail))
    assert.equal(shouldSendIdleCommand({ ...warned, idleMs: 1000 }), false)
    assert.equal(shouldSendIdleCommand({ ...warned, lineOpen: true }), false)
    assert.equal(shouldSendIdleCommand({ ...warned, altScreen: true }), false)
  }
  // 경고 뒤에 명령이 실행됐으면 더 이상 경고 상태가 아니다
  assert.equal(shouldSendIdleCommand({ ...ready, tail: 'shell will time out in 60 seconds\r\n$ date\r\nThu Nov  5\r\n$ ', idleMs: 3000 }), false)
})

test('대체 화면은 마지막 코드를 따른다', () => {
  assert.equal(nextAltScreen(false, '\x1b[?1049h'), true)
  assert.equal(nextAltScreen(true, 'text\x1b[?1049l$ '), false)
  assert.equal(nextAltScreen(false, '\x1b[?47h'), true)
  assert.equal(nextAltScreen(false, '\x1b[?1;1049h'), true)
  assert.equal(nextAltScreen(false, '\x1b[?1049h...\x1b[?1049l'), false)
  assert.equal(nextAltScreen(true, 'plain \x1b[?25l text'), true)
})

test('터미널 자동 응답은 사용자 입력이 아니다', () => {
  for (const d of ['\x1b[?1;2c', '\x1b[>0;276;0c', '\x1b[24;80R', '\x1b[I', '\x1b[O', '\x1b]11;rgb:0000/0000/0000\x07']) assert.equal(isTerminalReport(d), true, JSON.stringify(d))
  for (const d of ['a', '\r', '\x1b[A', '\x7f', 'ls\r', '\x1b[3~']) assert.equal(isTerminalReport(d), false, JSON.stringify(d))
})
