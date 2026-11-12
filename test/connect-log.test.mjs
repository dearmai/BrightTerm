import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ConnectLog, summarizeAttempt } from '../src/main/connectLog.ts'

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

// 실제 ssh2 1.17 debug 출력 (OpenSSH 9.2 podman 컨테이너, 비밀번호 틀림) 중 일부
const AUTH_FAIL = [
  'Custom crypto binding not available',
  "Local ident: 'SSH-2.0-ssh2js1.17.0'",
  'Client: Trying 127.0.0.1 on port 22999 ...',
  'Socket connected',
  "Remote ident: 'SSH-2.0-OpenSSH_9.2p1 Debian-2+deb12u10'",
  'Outbound: Sending KEXINIT',
  'Handshake: (local) KEX method: curve25519-sha256@libssh.org,curve25519-sha256',
  'Handshake: (remote) KEX method: sntrup761x25519-sha512,curve25519-sha256',
  'Handshake: KEX algorithm: curve25519-sha256@libssh.org',
  'Handshake: Host key format: ssh-ed25519',
  'Handshake: C->S Cipher: aes128-gcm@openssh.com',
  'Handshake: S->C cipher: aes128-gcm@openssh.com',
  'Handshake: C->S MAC: <implicit>',
  'Host accepted by default (no verification)',
  'Host accepted (verified)',
  'Handshake completed',
  'Outbound: Sending USERAUTH_REQUEST (none)',
  'Inbound: Received USERAUTH_FAILURE (publickey,password)',
  'Client: none auth failed',
  'Outbound: Sending USERAUTH_REQUEST (password)',
  'Inbound: Received USERAUTH_FAILURE (publickey,password)',
  'Client: password auth failed',
  '오류 원문: All configured authentication methods failed'
]

test('접속 진단: 인증 실패는 접속·식별·협상 결과·인증 과정과 허용/시도 방식을 보인다', () => {
  assert.deepEqual(summarizeAttempt(AUTH_FAIL), [
    'Client: Trying 127.0.0.1 on port 22999 ...',
    "Remote ident: 'SSH-2.0-OpenSSH_9.2p1 Debian-2+deb12u10'",
    'Handshake: KEX algorithm: curve25519-sha256@libssh.org',
    'Handshake: Host key format: ssh-ed25519',
    'Handshake: C->S Cipher: aes128-gcm@openssh.com',
    'Handshake: S->C cipher: aes128-gcm@openssh.com',
    'Host accepted (verified)',
    'Handshake completed',
    'Outbound: Sending USERAUTH_REQUEST (none)',
    'Inbound: Received USERAUTH_FAILURE (publickey,password)',
    'Client: none auth failed',
    'Outbound: Sending USERAUTH_REQUEST (password)',
    'Inbound: Received USERAUTH_FAILURE (publickey,password)',
    'Client: password auth failed',
    '오류 원문: All configured authentication methods failed',
    '인증 요약: 서버 허용 방식 publickey,password · 시도한 방식 password'
  ])
})

test('접속 진단: 협상이 끝나지 않았으면 양쪽 알고리즘 목록을 보인다', () => {
  const lines = summarizeAttempt([...AUTH_FAIL.slice(0, 9), 'Handshake: No matching host key format', '오류 원문: Handshake failed: no matching host key format'])
  assert(lines.includes('Handshake: (local) KEX method: curve25519-sha256@libssh.org,curve25519-sha256'))
  assert(lines.includes('Handshake: (remote) KEX method: sntrup761x25519-sha512,curve25519-sha256'))
  assert(lines.includes('Handshake: No matching host key format'))
  assert(!lines.some((l) => l.startsWith('인증 요약')))
})

test('접속 진단: 소켓 오류, 식별 전 끊김, 점프 서버 표시', () => {
  assert.deepEqual(summarizeAttempt(['Client: Trying 127.0.0.1 on port 1 ...', 'Socket error: connect ECONNREFUSED 127.0.0.1:1', '오류 원문: connect ECONNREFUSED 127.0.0.1:1']),
    ['Client: Trying 127.0.0.1 on port 1 ...', 'Socket error: connect ECONNREFUSED 127.0.0.1:1', '오류 원문: connect ECONNREFUSED 127.0.0.1:1'])
  assert.deepEqual(summarizeAttempt(['Client: Trying 10.0.0.1 on port 22 ...', 'Socket connected', 'Socket ended', 'Socket closed']),
    ['Client: Trying 10.0.0.1 on port 22 ...', 'Socket ended', 'Socket closed'])
  assert.deepEqual(summarizeAttempt(['[bastion] Client: Trying 1.2.3.4 on port 22 ...', '[bastion] Inbound: Received USERAUTH_FAILURE (publickey)', '[bastion] Custom crypto binding not available']),
    ['[bastion] Client: Trying 1.2.3.4 on port 22 ...', '[bastion] Inbound: Received USERAUTH_FAILURE (publickey)', '인증 요약: 서버 허용 방식 publickey · 시도한 방식 (없음)'])
})

test('접속 진단: 줄이 많으면 앞뒤를 남기고 줄인다, 시도마다 새로 모은다', () => {
  const many = Array.from({ length: 100 }, (_, i) => `Socket error: e${i}`)
  const lines = summarizeAttempt(many)
  assert.equal(lines.length, 40)
  assert.equal(lines[10], '… 60줄 생략 …')
  assert.equal(lines.at(-1), 'Socket error: e99')
  const log = new ConnectLog()
  log.debug('Socket error: old', at)
  log.beginAttempt()
  log.debug('Socket error: new', at)
  log.add('접속 실패: 화면 안내는 진단에 넣지 않는다', at)
  assert.deepEqual(log.attemptSummary(), ['Socket error: new'])
  assert.match(log.text(), /old[\s\S]*new/)
})
