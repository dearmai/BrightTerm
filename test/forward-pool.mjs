import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { createServer, connect } from 'node:net'
import { registerHooks } from 'node:module'
registerHooks({ resolve(specifier, context, next) {
  return next(specifier === './forwardHealth' && context.parentURL?.endsWith('/forwardPool.ts') ? './forwardHealth.ts' : specifier, context)
} })
const { ForwardPool } = await import('../src/main/transports/forwardPool.ts')

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(check) {
  for (let i = 0; i < 100; i++) { if (check()) return; await wait(20) }
  assert.fail('Timed out waiting for forwarding state')
}
async function echo(prefix) {
  const sockets = new Set()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('data', (data) => socket.write(prefix + data))
  }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { port: server.address().port, close: () => { for (const s of sockets) s.destroy(); server.close() } }
}
class Client extends EventEmitter {
  calls = 0
  forwardOut(_host, _port, host, port, callback) {
    this.calls++
    const socket = connect(port, host)
    socket.once('connect', () => callback(null, socket))
    socket.once('error', (error) => callback(error))
  }
}
const first = await echo('A:')
const second = await echo('B:')
const probe = createServer().listen(0, '127.0.0.1')
await once(probe, 'listening')
const port = probe.address().port
await new Promise((r) => probe.close(r))
const host = { host: 'test', port: 22, username: 'user', forwards: [{ id: 'rule', type: 'L', bindHost: '127.0.0.1', bindPort: port, destHost: '127.0.0.1', destPort: first.port }] }
let a = [], b = [], c = []
const owner = new Client(), other = new Client()
const leases = []
let socket
try {
  const one = ForwardPool.acquire(host, owner, (s) => { a = s }, () => {})
  leases.push(one)
  await until(() => a[0]?.health === 'healthy')
  assert.equal(a[0].totalConnections, 0, 'health probes excluded from connection totals')
  assert.equal(a[0].sentBytes, 0)
  const two = ForwardPool.acquire(host, other, (s) => { b = s }, () => {})
  leases.push(two)
  assert.equal(one.pool, two.pool, 'same target reuses pool')
  await until(() => b[0]?.state === 'active')
  socket = connect(port, '127.0.0.1')
  await once(socket, 'connect')
  socket.write('hello')
  assert.equal((await once(socket, 'data'))[0].toString(), 'A:hello')
  await until(() => b[0]?.receivedBytes === 7)
  assert.equal(b[0].sentBytes, 5)
  assert.equal(b[0].connections, 1)
  assert.equal(b[0].totalConnections, 1)
  assert.equal(owner.calls, 2, 'one health probe plus one user connection')
  assert.equal(other.calls, 0)
  one.release()
  assert.equal(one.pool.retains(owner), true, 'closing owner terminal retains forwarding connection')
  socket.write('again')
  assert.equal((await once(socket, 'data'))[0].toString(), 'A:again')
  socket.destroy()
  await until(() => b[0]?.connections === 0)
  const changed = { ...host, forwards: [{ ...host.forwards[0], destPort: second.port }] }
  const three = ForwardPool.acquire(changed, other, (s) => { c = s }, () => {})
  leases.push(three)
  await until(() => c[0]?.state === 'active' && c[0]?.destPort === second.port)
  assert.equal(b[0].destPort, second.port, 'existing sessions see revised rule')
  socket = connect(port, '127.0.0.1')
  await once(socket, 'connect')
  socket.write('new')
  assert.equal((await once(socket, 'data'))[0].toString(), 'B:new')
  two.release()
  three.release()
  assert.equal(one.pool.retains(owner), false, 'last session releases pool')
  console.log('PASS: shared local forwarding, payload counters, owner release, changed destination, last release')
} finally {
  socket?.destroy()
  for (const lease of leases) lease.release()
  first.close(); second.close()
}
// Remote forwarding is verified against the ssh2 callback contract using a fake client.
class RemoteClient extends EventEmitter {
  requested = []
  removed = []
  forwardIn(host, port, callback) { this.requested.push([host, port]); setTimeout(() => callback(null, port || 45000), 10) }
  unforwardIn(host, port, callback) { this.removed.push([host, port]); callback(null) }
}
const remote = new RemoteClient()
const remoteHost = { host: 'remote-test', port: 22, username: 'user', forwards: [{ id: 'r1', type: 'R', bindHost: '127.0.0.1', bindPort: 0, destHost: '127.0.0.1', destPort: 9000 }] }
let remoteState = []
const r1 = ForwardPool.acquire(remoteHost, remote, (s) => { remoteState = s }, () => {})
const r2 = ForwardPool.acquire(remoteHost, new RemoteClient(), () => {}, () => {})
try {
  await until(() => remoteState[0]?.state === 'active')
  assert.equal(remoteState[0].bindPort, 45000)
  assert.equal(remote.requested.length, 1, 'pending remote rule reused')
  const revised = { ...remoteHost, forwards: [{ ...remoteHost.forwards[0], destPort: 9001 }, { ...remoteHost.forwards[0], id: 'r2', bindPort: 45001 }] }
  let nextState = []
  const r3 = ForwardPool.acquire(revised, remote, (s) => { nextState = s }, () => {})
  try {
    await until(() => nextState.length === 2 && nextState.every((f) => f.state === 'active'))
    assert.equal(remote.requested.length, 3, 'only changed and new rules requested')
    assert.deepEqual(remote.removed[0], ['127.0.0.1', 45000])
    remote.emit('close')
    assert.ok(nextState.every((f) => f.state === 'error'), 'SSH loss invalidates shared state')
  } finally { r3.release() }
} finally { r1.release(); r2.release() }
console.log('PASS: pending remote reuse, allocated port, changed/new rules, SSH loss')
const { probeForwardDestination } = await import('../src/main/transports/forwardHealth.ts')
const { PassThrough } = await import('node:stream')
let lateCallback, cancelledNotified = false
const [timeoutError] = await Promise.all([new Promise((resolve) => probeForwardDestination({ forwardOut(...args) { lateCallback = args.at(-1) } }, host.forwards[0], resolve, 20)), wait(30)])
assert.match(timeoutError.message, /시간 초과/)
const lateChannel = new PassThrough()
lateCallback(null, lateChannel)
assert.equal(lateChannel.destroyed, true, 'late channel is closed after timeout')
const cancel = probeForwardDestination({ forwardOut() {} }, host.forwards[0], () => { cancelledNotified = true }, 20)
cancel()
await wait(30)
assert.equal(cancelledNotified, false, 'cancelled probe cannot update state')

const target = await echo('health:')
const healthHost = { ...host, host: 'health-test', forwards: [{ ...host.forwards[0], bindPort: 0, destPort: target.port }] }
let health = []
const healthLease = ForwardPool.acquire(healthHost, new Client(), (s) => { health = s }, () => {})
const realNow = Date.now
let replacement
try {
  await until(() => health[0]?.health === 'healthy')
  assert.equal(health[0].totalConnections, 0)
  target.close()
  Date.now = () => realNow() + 16000
  await until(() => health[0]?.health === 'unhealthy')
  assert.ok(health[0].healthError)
  assert.equal(health[0].state, 'active', 'destination failure does not misreport listener failure')
  replacement = createServer((s) => s.end()).listen(target.port, '127.0.0.1')
  await once(replacement, 'listening')
  Date.now = () => realNow() + 32000
  await until(() => health[0]?.health === 'healthy')
  assert.equal(health[0].healthError, undefined)
  assert.equal(health[0].totalConnections, 0, 'all probes excluded from user counts')
  const remoteProbeError = await new Promise((resolve) => probeForwardDestination({}, { ...healthHost.forwards[0], type: 'R' }, resolve))
  assert.equal(remoteProbeError, undefined, 'remote forwarding checks local destination')
} finally {
  Date.now = realNow
  healthLease.release()
  target.close()
  replacement?.close()
}
console.log('PASS: TCP health success/failure/recovery, remote destination probe, timeout, cancellation, late cleanup, statistics exclusion')
