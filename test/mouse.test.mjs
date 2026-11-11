import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isMouseReport, MouseModeFilter } from '../src/shared/mouse.ts'

test('mouse requests split at any packet boundary are blocked without dropping other modes', () => {
  const data = 'before\x1b[?1003;1049;1006h\x1b[31mred\x1b[?1002lafter'
  const expected = 'before\x1b[?1049h\x1b[31mredafter'
  for (let i = 0; i <= data.length; i++) {
    const f = new MouseModeFilter()
    assert.equal(f.push(data.slice(0, i), true) + f.push(data.slice(i), true), expected, `split ${i}`)
  }
  const f = new MouseModeFilter()
  assert.equal([...data].map((c) => f.push(c, true)).join(''), expected)
})

test('allowed sessions retain protocol bytes, and reconnect discards unfinished old requests', () => {
  const f = new MouseModeFilter()
  assert.equal(f.push('\x1b[?1003;1006h', false), '\x1b[?1003;1006h')
  assert.equal(f.push('\x1b[?100', true), '')
  f.reset()
  assert.equal(f.push('new connection', true), 'new connection')
  assert.equal(f.push('\x1b[?100', true), '')
  assert.equal(f.push('3h', false), '\x1b[?1003h')
})

test('recognizes X10, SGR and urxvt reports without consuming typed text or arrow keys', () => {
  for (const report of ['\x1b[M !!', '\x1b[<35;90;30M', '\x1b[<0;1;1m', '\x1b[35;90;30M']) assert.ok(isMouseReport(report))
  for (const text of ['35;90;30M', 'echo hello', '\x1b[A', '\x1b[1;2R', '\x1b[?1003h', 'echo \x1b[35;90;30M']) assert.equal(isMouseReport(text), false)
})
