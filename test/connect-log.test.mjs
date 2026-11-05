import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ConnectLog } from '../src/main/connectLog.ts'

const at = new Date(2026, 10, 5, 9, 8, 7, 6)

test('줄마다 시각을 붙인다', () => {
  const log = new ConnectLog()
  log.add('Handshake: KEX method: curve25519-sha256', at)
  assert.equal(log.text(), '2026-11-05 09:08:07.006  Handshake: KEX method: curve25519-sha256')
})

test('입력 길이가 드러나는 패킷 줄은 남기지 않는다', () => {
  const log = new ConnectLog()
  log.add('Outbound: Sending CHANNEL_DATA (r:0, 9)', at)
  log.add('Inbound: CHANNEL_DATA (r:0, 31)', at)
  log.add('Inbound: CHANNEL_WINDOW_ADJUST (r:0, 32768)', at)
  log.add('Outbound: Sending USERAUTH_REQUEST (password)', at)
  assert.deepEqual(log.text().split('\n').map((l) => l.slice(25)), ['Outbound: Sending USERAUTH_REQUEST (password)'])
})

test('아주 긴 줄은 자른다', () => {
  const log = new ConnectLog()
  log.add('x'.repeat(5000), at)
  assert.ok(log.text().length < 2100)
})

test('넘치면 처음 접속 과정과 최근 줄을 남기고 가운데를 줄인다', () => {
  const log = new ConnectLog()
  for (let i = 0; i < 2500; i++) log.add(`line ${i}`, at)
  const lines = log.text().split('\n')
  assert.equal(lines.length, 2001)
  assert.match(lines[0], /line 0$/)
  assert.match(lines[999], /line 999$/)
  assert.equal(lines[1000], '… 500줄 생략 …')
  assert.match(lines[1001], /line 1500$/)
  assert.match(lines[2000], /line 2499$/)
})
