import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MAX_SNIPPETS, mergeSnippets, parseSnippets, serializeSnippets } from '../src/main/snippetsFile.ts'

const one = { id: 'a', name: '로그 보기', body: 'tail -f /var/log/messages\nls', sendEnter: true }
const file = (snippets, extra = {}) => JSON.stringify({ app: 'brightterm', type: 'snippets', version: 1, snippets, ...extra })

test('내보낸 파일을 그대로 다시 읽는다 — 내부 id 는 파일에 넣지 않는다', () => {
  const text = serializeSnippets([one], new Date('2026-11-05T00:00:00Z'))
  assert.equal(JSON.parse(text).exportedAt, '2026-11-05T00:00:00.000Z')
  assert.doesNotMatch(text, /"id"/)
  assert.deepEqual(parseSnippets(text), [{ name: one.name, body: one.body, sendEnter: true }])
})

test('메모장의 BOM 을 허용하고, 빠진 값은 안전한 쪽으로 채운다', () => {
  assert.deepEqual(parseSnippets('﻿' + file([{ body: 'df -h' }])), [{ name: '', body: 'df -h', sendEnter: false }])
})

test('잘못된 파일은 전체를 거부한다', () => {
  assert.throws(() => parseSnippets('not json'), /JSON/)
  assert.throws(() => parseSnippets('null'), /스니펫 파일이 아닙니다/)
  assert.throws(() => parseSnippets('[]'), /스니펫 파일이 아닙니다/)
  assert.throws(() => parseSnippets(JSON.stringify({ app: 'brightterm', version: 1, store: {} })), /스니펫 파일이 아닙니다/)
  assert.throws(() => parseSnippets(file([], { version: 2 })), /버전/)
  for (const bad of [null, {}, { body: '' }, { body: 1 }, { name: 1, body: 'x' }, { body: 'x', sendEnter: 'yes' }]) {
    assert.throws(() => parseSnippets(file([{ body: 'ok' }, bad])), /2번째/, JSON.stringify(bad))
  }
  assert.throws(() => parseSnippets(file(Array(MAX_SNIPPETS + 1).fill({ body: 'x' }))), /까지/)
})

test('합치기: 같으면 건너뛰고, 이름만 같으면 번호를 붙이며, 기존 항목은 그대로 둔다', () => {
  let n = 0
  const r = mergeSnippets([one, { ...one, id: 'b', name: '디스크', body: 'df' }], [
    { name: one.name, body: one.body, sendEnter: true },
    { name: one.name, body: 'other', sendEnter: true },
    { name: one.name, body: 'third', sendEnter: true },
    { name: '새 항목', body: 'new', sendEnter: false },
    { name: '', body: 'x', sendEnter: false },
    { name: '', body: 'y', sendEnter: false }
  ], () => `id${++n}`)
  assert.equal(r.added, 5)
  assert.equal(r.skipped, 1)
  assert.deepEqual(r.snippets.slice(0, 2).map((s) => s.id), ['a', 'b'])
  assert.deepEqual(r.snippets.slice(2).map((s) => s.name), [`${one.name} (2)`, `${one.name} (3)`, '새 항목', '', ''])
  assert.deepEqual(r.snippets.slice(2).map((s) => s.id), ['id1', 'id2', 'id3', 'id4', 'id5'])
})

test('합친 결과가 동기화 한도를 넘으면 거부한다', () => {
  const full = Array.from({ length: MAX_SNIPPETS }, (_, i) => ({ id: String(i), name: '', body: String(i), sendEnter: false }))
  assert.throws(() => mergeSnippets(full, [{ name: '', body: 'over', sendEnter: false }]), /까지/)
})
