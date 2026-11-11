import assert from 'node:assert/strict'
import { test } from 'node:test'
import { compareSnapshots } from '../src/main/gitSyncDiff.ts'

const base = () => ({ version: 1, groups: [{ id: 'g', parentId: null, name: '운영', sort: 0 }], hosts: [{
  id: 'h', alias: '서버 A', groupId: 'g', host: 'host.example', port: 22, protocol: 'ssh', username: 'user', authType: 'password', tags: [], forwards: []
}], snippets: [{ id: 's', name: '스니펫 A', body: 'echo local', sendEnter: false }],
vault: { version: 1, kdf: { salt: 'a' }, wrapped: { ct: 'wrapped' }, items: [{ id: 'c', name: '계정 A', kind: 'password', username: 'user', updatedAt: 1, iv: 'a', ct: 'ciphertext-a', tag: 'a' }] } })

test('shows actual fields and both values, including omitted defaults and resolved references', () => {
  const a = base(), b = base()
  assert.deepEqual(compareSnapshots(a, b, {}, {}), [])
  b.hosts[0].port = 2222
  b.hosts[0].mouseReporting = true
  b.groups.push({ id: 'g2', name: '개발', parentId: null, sort: 1 })
  b.hosts[0].groupId = 'g2'
  const diff = compareSnapshots(a, b, {}, {})
  const fields = diff.find((d) => d.category === 'hosts').fields
  assert.deepEqual(fields.find((d) => d.label === '포트'), { label: '포트', local: '22', remote: '2222', concealed: false })
  assert.match(fields.find((d) => d.label === '마우스 입력 전달').local, /미설정/)
  assert.match(fields.find((d) => d.label === '폴더').remote, /개발/)
  assert.equal(diff.find((d) => d.id === 'g2').kind, 'remote-only')
})

test('credential secrets never appear in the result; cipher changes do not imply password changes', () => {
  const a = base(), b = base()
  b.vault.items[0].iv = 'b'
  b.vault.items[0].ct = 'ciphertext-b'
  const secrets = { c: { username: 'user', password: 'DO-NOT-EXPOSE-PASSWORD', privateKey: 'DO-NOT-EXPOSE-KEY', passphrase: 'DO-NOT-EXPOSE-PASSPHRASE' } }
  const equal = compareSnapshots(a, b, secrets, secrets)
  assert.match(equal[0].fields[0].local, /실제 계정 값 같음/)
  const diff = compareSnapshots(a, b, secrets, { c: { ...secrets.c, password: 'REMOTE-SECRET' } })
  assert.ok(diff[0].fields.some((d) => /비밀번호 — 값이 다름/.test(d.label)))
  for (const secret of [...Object.values(secrets.c).filter((s) => s.startsWith('DO-NOT')), 'REMOTE-SECRET', 'ciphertext-a', 'ciphertext-b']) assert.ok(!JSON.stringify(diff).includes(secret))
})

test('one-sided entries never claim addition/deletion; absent legacy snippets are preserved', () => {
  const a = base(), b = base()
  b.hosts = []; delete b.snippets
  const diff = compareSnapshots(a, b, {}, {})
  assert.equal(diff.find((d) => d.category === 'hosts').kind, 'local-only')
  assert.ok(!diff.some((d) => d.category === 'snippets'))
  assert.ok(compareSnapshots(a, null, {}, {}).every((d) => d.kind === 'local-only'))
})

test('masks URL credentials and unknown fields, and conceals commands and snippets', () => {
  const a = base(), b = base()
  b.hosts[0].host = 'https://user:URL-PASSWORD@host.example'
  b.hosts[0].newSecretSetting = 'UNKNOWN-SECRET'
  b.hosts[0].startupCommand = 'echo private-command'
  b.snippets[0].body = 'echo private-snippet'
  const diff = compareSnapshots(a, b, {}, {})
  assert.ok(!JSON.stringify(diff).includes('URL-PASSWORD'))
  assert.ok(!JSON.stringify(diff).includes('UNKNOWN-SECRET'))
  assert.ok(diff.find((d) => d.category === 'hosts').fields.find((f) => f.label === '자동 실행 명령').concealed)
  assert.ok(diff.find((d) => d.category === 'snippets').fields.find((f) => f.label === '스니펫 본문').concealed)
})
