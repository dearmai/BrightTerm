import assert from 'node:assert/strict'
import { test } from 'node:test'
import { VAULT_FEATURES, VaultUpdateRequired, checkVaultFeatures, stampVaultFeatures } from '../src/main/vaultFeatures.ts'

test('새 기능을 쓸 때만 표시 — 안 쓰면 이전 버전과 같은 형식', () => {
  const v = { version: 1, items: [{ kind: 'password' }, { kind: 'key' }] }
  stampVaultFeatures(v)
  assert.equal('features' in v, false)
  assert.equal('minAppVersion' in v, false)
  v.items.push({ kind: 'totp' })
  stampVaultFeatures(v)
  assert.deepEqual(v.features, ['totp'])
  assert.equal(v.minAppVersion, VAULT_FEATURES.totp)
  v.items.pop()
  stampVaultFeatures(v)
  assert.equal('features' in v, false, 'TOTP 를 다 지우면 표시도 지운다')
})

test('모르는 기능·계정 종류는 형식 오류가 아니라 업데이트 안내', () => {
  assert.doesNotThrow(() => checkVaultFeatures({ features: ['totp'], minAppVersion: '1.3.0', items: [{ kind: 'totp' }] }))
  assert.doesNotThrow(() => checkVaultFeatures(null))
  assert.throws(() => checkVaultFeatures({ features: ['passkey'], minAppVersion: '1.5.0', items: [] }),
    (e) => e instanceof VaultUpdateRequired && /1\.5\.0 이상/.test(e.message) && /passkey/.test(e.message))
  assert.throws(() => checkVaultFeatures({ items: [{ kind: 'passkey' }] }), (e) => e instanceof VaultUpdateRequired && /최신 버전/.test(e.message))
  // 이상한 버전 문자열은 그대로 보여 주지 않는다
  assert.throws(() => checkVaultFeatures({ features: ['x'], minAppVersion: '<b>9</b>', items: [] }), (e) => /최신 버전/.test(e.message) && !/<b>/.test(e.message))
})
