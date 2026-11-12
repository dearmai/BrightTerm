import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_RECONNECT_POLICY, normalizeReconnectPolicy, resolveReconnectPolicy, reconnectDelay, canReconnect, isAuthFailure } from '../src/shared/reconnect.ts'

test('기본 대기 시간과 기존 8회 제한 유지', () => {
  assert.deepEqual(Array.from({ length: 8 }, (_, i) => reconnectDelay(DEFAULT_RECONNECT_POLICY, i)), [2, 4, 8, 16, 30, 30, 30, 30])
  assert.equal(canReconnect(DEFAULT_RECONNECT_POLICY, 7), true)
  assert.equal(canReconnect(DEFAULT_RECONNECT_POLICY, 8), false)
})
test('고정·일정 증가·배수 증가와 상한', () => {
  const base = { ...DEFAULT_RECONNECT_POLICY, initialDelaySec: 3, incrementSec: 4, multiplier: 1.5, maxDelaySec: 12 }
  assert.deepEqual([0, 1, 2, 10].map((i) => reconnectDelay({ ...base, mode: 'fixed' }, i)), [3, 3, 3, 3])
  assert.deepEqual([0, 1, 2, 10].map((i) => reconnectDelay({ ...base, mode: 'linear' }, i)), [3, 7, 11, 12])
  assert.deepEqual([0, 1, 2, 1000].map((i) => reconnectDelay(base, i)), [3, 4.5, 6.75, 12])
})
test('서버 규칙 우선, 없으면 앱 규칙, 이전 저장 형식은 기본값', () => {
  const app = { ...DEFAULT_RECONNECT_POLICY, initialDelaySec: 5 }
  const host = { ...app, initialDelaySec: 10 }
  assert.equal(resolveReconnectPolicy(app, host).initialDelaySec, 10)
  assert.equal(resolveReconnectPolicy(app).initialDelaySec, 5)
  assert.deepEqual(resolveReconnectPolicy(), DEFAULT_RECONNECT_POLICY)
})
test('0회는 무제한, 유효하지 않은 백업값과 타이머 범위를 정규화', () => {
  assert.equal(canReconnect({ ...DEFAULT_RECONNECT_POLICY, maxAttempts: 0 }, 100000), true)
  const policy = normalizeReconnectPolicy({ initialDelaySec: -1, maxDelaySec: Infinity, maxAttempts: -9, multiplier: 900, mode: 'invalid' })
  assert.equal(policy.initialDelaySec, 1)
  assert.equal(policy.maxDelaySec, 30)
  assert.equal(policy.maxAttempts, 8)
  assert.equal(policy.multiplier, 10)
  assert.equal(policy.mode, 'exponential')
  assert.equal(normalizeReconnectPolicy({ initialDelaySec: 60, maxDelaySec: 20 }).maxDelaySec, 60)
  assert.deepEqual(normalizeReconnectPolicy(null), DEFAULT_RECONNECT_POLICY)
})
test('인증 실패는 자동 재접속 중단 대상, 네트워크 오류는 아님', () => {
  assert.equal(isAuthFailure(Object.assign(new Error('All configured authentication methods failed'), { level: 'client-authentication' })), true)
  assert.equal(isAuthFailure(new Error('All configured authentication methods failed')), true)
  assert.equal(isAuthFailure(new Error('사용자 이름이 입력되지 않았습니다')), true)
  assert.equal(isAuthFailure(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:22'), { code: 'ECONNREFUSED' })), false)
  assert.equal(isAuthFailure(new Error('Timed out while waiting for handshake')), false)
  assert.equal(isAuthFailure(undefined), false)
})
