import assert from 'node:assert/strict'
import { test } from 'node:test'
import { localNetworkHelp } from '../src/main/localNetworkHelp.ts'

test('macOS SSH and Telnet reachability failures explain LAN settings and missing entries', () => {
  for (const protocol of ['ssh', 'telnet']) {
    for (const message of ['connect EHOSTUNREACH 192.168.1.1:22', 'ENETUNREACH', 'connect EPERM', 'connect EACCES', 'ETIMEDOUT', 'Timed out while waiting for handshake', '연결 시간 초과', '프록시 intranet:8080 응답 시간 초과']) {
      const help = localNetworkHelp(new Error(message), protocol, 'darwin')
      assert.match(help, /시스템 설정 → 개인정보 보호 및 보안 → 로컬 네트워크 → BrightTerm/)
      assert.match(help, /목록에 없다면/)
      assert.match(help, /주소·VPN·방화벽/)
      assert.match(help, /tccutil reset으로는 이 권한을 초기화할 수 없으며/)
    }
  }
  assert.ok(localNetworkHelp({ code: 'EHOSTUNREACH', message: 'connect failed' }, 'ssh', 'darwin'))
})

test('unrelated platforms, protocols and authentication errors do not show LAN advice', () => {
  for (const platform of ['win32', 'linux']) {
    assert.equal(localNetworkHelp(new Error('EHOSTUNREACH'), 'ssh', platform), undefined)
  }
  for (const protocol of ['local', 'serial']) {
    assert.equal(localNetworkHelp(new Error('EACCES'), protocol, 'darwin'), undefined)
  }
  for (const message of ['connect ECONNREFUSED', 'getaddrinfo ENOTFOUND', 'All configured authentication methods failed', 'Permission denied (publickey,password)', 'Authentication failed: Permission denied', 'Host denied', '개인 키를 읽을 수 없습니다']) {
    assert.equal(localNetworkHelp(new Error(message), 'ssh', 'darwin'), undefined)
  }
})
