import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_KEYS, TERMINAL_PRESETS, applyPreset, eraseChar, hostKeys, mapKeys, matchPreset } from '../src/shared/terminal.ts'

const aix = TERMINAL_PRESETS.find((p) => p.id === 'aix')

test('기본값은 xterm.js 입력을 그대로 보낸다', () => {
  for (const d of ['\x7f', '\b', '\x1b[3~', '\x1b[H', '\x1b[F', '\r', 'ls -al\r']) assert.equal(mapKeys(d, DEFAULT_KEYS), d)
  assert.equal(eraseChar(DEFAULT_KEYS), 127)
})

test('AIX: 백스페이스 ^H, Ctrl+Backspace 는 ^?, Home/End vt220', () => {
  assert.equal(mapKeys('\x7f', aix.keys), '\b')
  assert.equal(mapKeys('\b', aix.keys), '\x7f')
  assert.equal(mapKeys('\x1b[H', aix.keys), '\x1b[1~')
  assert.equal(mapKeys('\x1bOF', aix.keys), '\x1b[4~')
  assert.equal(eraseChar(aix.keys), 8)
  // 붙여 넣은 글 안의 DEL 은 건드리지 않는다
  assert.equal(mapKeys('a\x7fb', aix.keys), 'a\x7fb')
})

test('Delete ^? 와 Enter CRLF/LF', () => {
  const k = { ...DEFAULT_KEYS, delete: 'del', enter: 'CRLF' }
  assert.equal(mapKeys('\x1b[3~', k), '\x7f')
  assert.equal(mapKeys('\r', k), '\r\n')
  assert.equal(mapKeys('a\rb\r\n', k), 'a\r\nb\r\n')
  assert.equal(mapKeys('a\rb', { ...DEFAULT_KEYS, enter: 'LF' }), 'a\nb')
  assert.equal(mapKeys('\r', k, false), '\r')
})

test('템플릿 적용과 일치 판정', () => {
  const h = { termType: 'xterm-256color', encoding: 'euc-kr' }
  assert.equal(matchPreset(h)?.id, undefined) // Linux 템플릿은 UTF-8
  const a = applyPreset(h, aix)
  assert.equal(a.termType, 'xterm')
  assert.equal(a.encoding, 'euc-kr') // AIX 템플릿은 인코딩을 그대로 둔다
  assert.equal(matchPreset(a)?.id, 'aix')
  const hp = applyPreset(h, TERMINAL_PRESETS.find((p) => p.id === 'hpux'))
  assert.equal(matchPreset(hp)?.id, 'hpux') // 값이 같은 템플릿이면 고른 것을 보여 준다
  assert.equal(matchPreset({ ...a, keys: { ...a.keys, delete: 'del' } }), undefined) // 직접 바꾸면 사용자 지정
  assert.equal(matchPreset({ termType: 'xterm-256color', encoding: 'utf-8' })?.id, 'linux')
  assert.deepEqual(hostKeys({}), DEFAULT_KEYS)
})

test('Android 템플릿 데이터가 데스크톱과 같다', async () => {
  const { readFileSync } = await import('node:fs')
  const { ENCODINGS } = await import('../src/shared/terminal.ts')
  const js = readFileSync(new URL('../android/app/src/main/assets/terminal.js', import.meta.url), 'utf8')
  const json = JSON.parse(js.slice(js.indexOf('/* json */') + 10, js.indexOf('/* /json */')))
  assert.deepEqual(json, JSON.parse(JSON.stringify({ defaultKeys: DEFAULT_KEYS, presets: TERMINAL_PRESETS, encodings: ENCODINGS })))
})
