import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:net'
import { Client } from 'ssh2'
import { connectSshClient } from '../src/main/transports/sshConnection.ts'

class FakeClient extends EventEmitter {
  destroyed = false
  connect() { return this }
  destroy() { this.destroyed = true; return this }
}

test('socket reset followed by handshake failure rejects once without an uncaught error', async () => {
  const client = new FakeClient()
  const reset = new Error('read ECONNRESET')
  const connection = connectSshClient(client, {})
  client.emit('error', reset)
  assert.doesNotThrow(() => client.emit('error', new Error('Connection lost before handshake')))
  client.emit('close')
  await assert.rejects(connection, error => error === reset)
  assert.equal(client.destroyed, true)
  assert.equal(client.listenerCount('ready'), 0)
  assert.equal(client.listenerCount('close'), 0)
})

test('ready clients retain error handling for later disconnections', async () => {
  const client = new FakeClient()
  const connection = connectSshClient(client, {})
  client.emit('ready')
  await connection
  assert.doesNotThrow(() => client.emit('error', new Error('read ECONNRESET')))
  assert.equal(client.destroyed, false)
  assert.equal(client.listenerCount('ready'), 0)
})

test('close before ready and synchronous connect errors reject cleanly', async () => {
  const client = new FakeClient()
  const connection = connectSshClient(client, {})
  client.emit('close')
  await assert.rejects(connection, /준비되기 전에 종료/)
  assert.doesNotThrow(() => client.emit('error', new Error('late error')))
  const invalid = new FakeClient()
  invalid.connect = () => { throw new Error('Invalid configuration') }
  await assert.rejects(connectSshClient(invalid, {}), /Invalid configuration/)
  assert.equal(invalid.destroyed, true)
})

test('real ssh2 client survives repeated TCP disconnects before handshake', async () => {
  const sockets = new Set()
  const server = createServer(socket => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.on('close', () => sockets.delete(socket))
    socket.once('data', () => socket.resetAndDestroy())
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const client = new Client()
      const closed = new Promise(resolve => client.once('close', resolve))
      await assert.rejects(connectSshClient(client, {
        host: '127.0.0.1', port: server.address().port, username: 'test', readyTimeout: 1500
      }))
      await closed
    }
  } finally {
    for (const socket of sockets) socket.destroy()
    await new Promise(resolve => server.close(resolve))
  }
})
