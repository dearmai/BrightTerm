import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseLaunchArgs, parseTarget, parseXsh, parseCrtSession, decodeSessionFile } from '../src/main/launchArgs.ts'

test('no launch arguments means a normal start', () => {
  assert.equal(parseLaunchArgs([]), null)
  assert.equal(parseLaunchArgs(['--no-sandbox', '-psn_0_12345']), null)
})

test('PuTTY style', () => {
  assert.deepEqual(parseLaunchArgs(['-ssh', 'admin@10.0.0.5', '-P', '2222', '-pw', 'p w']), {
    style: 'putty', protocol: 'ssh', host: '10.0.0.5', port: 2222, username: 'admin', password: 'p w'
  })
  assert.deepEqual(parseLaunchArgs(['-ssh', '-l', 'root', '-i', 'C:\\keys\\a.ppk', '-L', '8080:localhost:80', 'web01']), {
    style: 'putty', protocol: 'ssh', host: 'web01', username: 'root', keyFile: 'C:\\keys\\a.ppk'
  })
  // -l 이 user@ 보다 앞선다
  assert.equal(parseLaunchArgs(['-l', 'kim', 'lee@h'])?.username, 'kim')
  assert.deepEqual(parseLaunchArgs(['-load', 'tmp session 1']), { style: 'putty', session: 'tmp session 1' })
  assert.deepEqual(parseLaunchArgs(['-telnet', 'telnet://sw1:2323/']), { style: 'putty', protocol: 'telnet', host: 'sw1', port: 2323 })
  assert.equal(parseLaunchArgs(['-serial', 'COM3', '-sercfg', '9600'])?.unsupported, 'serial')
  assert.equal(parseLaunchArgs(['-ssh', 'h', '-pwfile', 'C:\\t\\pw'])?.passwordFile, 'C:\\t\\pw')
})

test('Xshell style', () => {
  assert.deepEqual(parseLaunchArgs(['-url', 'ssh://tok%40en:p%3Aw@gw.corp:2222', '-newtab', '서버A']), {
    style: 'xshell', protocol: 'ssh', host: 'gw.corp', port: 2222, username: 'tok@en', password: 'p:w', title: '서버A'
  })
  assert.deepEqual(parseLaunchArgs(['C:\\Temp\\s_1.xsh']), { style: 'xshell', sessionFile: 'C:\\Temp\\s_1.xsh' })
  assert.deepEqual(parseLaunchArgs(['--bt-launch=xshell', 'prod-db']), { style: 'xshell', session: 'prod-db' })
  assert.deepEqual(parseLaunchArgs(['-url', 'telnet://10.1.1.1']), { style: 'xshell', protocol: 'telnet', host: '10.1.1.1' })
})

test('SecureCRT style', () => {
  assert.deepEqual(parseLaunchArgs(['/T', '/SSH2', '/L', 'user', '/PASSWORD', 'secret', '/P', '22', '/ACCEPTHOSTKEYS', '10.0.0.7']), {
    style: 'securecrt', protocol: 'ssh', host: '10.0.0.7', port: 22, username: 'user', password: 'secret'
  })
  assert.deepEqual(parseLaunchArgs(['/F', 'C:\\agent\\crt', '/S', 'Sessions A']), { style: 'securecrt', configDir: 'C:\\agent\\crt', session: 'Sessions A' })
  assert.deepEqual(parseLaunchArgs(['/telnet', 'sw2', '2323']), { style: 'securecrt', protocol: 'telnet', host: 'sw2', port: 2323 })
  assert.equal(parseLaunchArgs(['/RLOGIN', 'h'])?.unsupported, 'rlogin')
})

test('bridge marker and pipe', () => {
  const r = parseLaunchArgs(['--bt-launch=securecrt', '--bt-pipe=\\\\.\\pipe\\brightterm-bridge-1', '/SSH2', 'h'])
  assert.equal(r?.style, 'securecrt')
  assert.equal(r?.pipe, '\\\\.\\pipe\\brightterm-bridge-1')
  assert.equal(r?.host, 'h')
  // 인자 없이 브릿지만 실행해도 파이프는 받는다(바로 끝내도록)
  assert.deepEqual(parseLaunchArgs(['--bt-launch=putty', '--bt-pipe=p']), { style: 'putty', pipe: 'p' })
})

test('target forms', () => {
  assert.deepEqual(parseTarget('[fe80::1]:2200'), { host: 'fe80::1', port: 2200, username: undefined })
  assert.deepEqual(parseTarget('a@b@host'), { host: 'host', port: undefined, username: 'a@b' })
  assert.deepEqual(parseTarget('rdp://x'), {})
})

test('session files', () => {
  const xsh = '[CONNECTION]\r\nHost=10.2.3.4\r\nPort=2200\r\nProtocol=SSH\r\n[CONNECTION:AUTHENTICATION]\r\nUserName=deploy\r\nPassword=ENCRYPTED\r\n'
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xsh, 'utf16le')])
  assert.deepEqual(parseXsh(decodeSessionFile(utf16)), { protocol: 'ssh', host: '10.2.3.4', port: 2200, username: 'deploy' })
  const crt = 'S:"Protocol Name"=SSH2\nS:"Hostname"=db01\nS:"Username"=oracle\nD:"[SSH2] Port"=00000016\n'
  assert.deepEqual(parseCrtSession(crt), { protocol: 'ssh', host: 'db01', port: 22, username: 'oracle' })
})
