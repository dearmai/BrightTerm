import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import { execFileSync } from 'node:child_process'
import { METRICS_SCRIPT, parseMetrics, sessionMetrics } from '../src/main/metrics.ts'

test('Linux CPU uses counter deltas; other metrics parse independently', () => {
  assert.deepEqual(parseMetrics('COUNTER 10000000000 8000000000\nCOUNTER 10000000100 8000000025\nMEMORY 62.345\nDISK 81\n'), { cpu: 75, memory: 62.3, disk: 81, uptimeSec: null })
})
test('macOS CPU uses the last sample and rejects invalid percentages', () => {
  assert.deepEqual(parseMetrics('CPU 99\nCPU 12.5\nMEMORY NaN\nDISK 101\n'), { cpu: 12.5, memory: null, disk: null, uptimeSec: null })
  assert.deepEqual(parseMetrics('COUNTER 100 50\nCOUNTER 50 20\n'), { cpu: null, memory: null, disk: null, uptimeSec: null })
  assert.deepEqual(parseMetrics('command not found\n'), { cpu: null, memory: null, disk: null, uptimeSec: null })
})
test('SSH metrics use separate channels, reuse samples and clear disconnected values', async () => {
  let commands = 0
  const session = {
    info: { state: 'connected', protocol: 'ssh' }, transport: {},
    sshTransport: () => ({ client: { exec(_cmd, cb) {
      commands++
      const channel = new EventEmitter()
      channel.stderr = { resume() {} }
      channel.close = () => {}
      channel.end = (script) => queueMicrotask(() => {
        channel.emit('data', Buffer.from(script.includes('BT_PONG') ? 'BT_PONG\n' : 'CPU 25\nMEMORY 50\nDISK 75\nUPTIME 93784\n'))
        channel.emit('close')
      })
      cb(null, channel)
    } } })
  }
  const first = sessionMetrics(session)
  assert.equal(sessionMetrics(session), first)
  const result = await first
  assert.ok(result.pingMs >= 0)
  assert.deepEqual([result.cpu, result.memory, result.disk, result.uptimeSec], [25, 50, 75, 93784])
  assert.equal(commands, 2)
  session.info.state = 'closed'
  assert.deepEqual(await sessionMetrics(session), { pingMs: null, cpu: null, memory: null, disk: null, uptimeSec: null })
})
test('native system collector returns CPU, memory and root disk percentages', { skip: !['darwin', 'linux'].includes(process.platform) }, () => {
  const output = execFileSync('/bin/sh', ['-c', METRICS_SCRIPT], { encoding: 'utf8', timeout: 4500 })
  const result = parseMetrics(output)
  for (const key of ['cpu', 'memory', 'disk', 'uptimeSec']) assert.equal(typeof result[key], 'number', `${key}: ${output}`)
})

test('uptime accepts long durations and zero, and rejects invalid or missing values', () => {
  assert.equal(parseMetrics('UPTIME 9876543.21\n').uptimeSec, 9876543)
  assert.equal(parseMetrics('UPTIME 0\n').uptimeSec, 0)
  for (const value of ['-1', 'NaN', 'Infinity', 'unknown', '']) {
    assert.equal(parseMetrics(`UPTIME ${value}\n`).uptimeSec, null)
  }
})
