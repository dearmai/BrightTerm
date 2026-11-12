// node --test test/ssh-config.test.mjs
// 서버 목록 → ~/.ssh/brightterm.conf 생성과 ~/.ssh/config 의 Include 관리
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { registerHooks } from 'node:module'
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith('@shared/')) return next(new URL(`../src/shared/${spec.slice(8)}.ts`, import.meta.url).href, ctx)
    return next(spec, ctx)
  }
})
const { INCLUDE_LINE, INCLUDE_MARKER, buildSshConfig, defaultSshName, hasInclude, sshNames, validSshName, withInclude, withoutInclude } = await import('../src/shared/sshConfig.ts')

const host = (o) => ({
  id: o.id, groupId: null, alias: o.id, protocol: 'ssh', host: '10.0.0.1', port: 22, username: '', authType: 'agent',
  tags: [], encoding: 'utf-8', termType: 'xterm-256color', keepaliveSec: 0, forwards: [], sort: 0, sshConfig: true, ...o
})

test('기본값은 대상 아님 — 켠 SSH 서버만 들어간다', () => {
  const r = buildSshConfig([
    host({ id: 'off', sshConfig: undefined }),
    host({ id: 'telnet', protocol: 'telnet' }),
    host({ id: 'nohost', host: '' }),
    host({ id: 'on' })
  ], [])
  assert.equal(r.count, 1)
  assert.deepEqual([...r.names.keys()], ['on'])
  assert.match(r.text, /^Host on$/m)
  assert.doesNotMatch(r.text, /^Host (off|telnet|nohost)$/m)
})

test('Host 이름: 별칭에서 만들고, 직접 정한 이름이 우선이며, 겹치면 -2', () => {
  assert.equal(defaultSshName({ id: 'abcdef123', alias: '운영 Web #1', host: '' }), 'Web-1')
  assert.equal(defaultSshName({ id: 'abcdef123', alias: '운영', host: '' }), 'bt-abcdef12')
  assert.equal(defaultSshName({ id: 'abcdef123', alias: '운영', host: 'db.example.com' }), 'db.example.com')
  assert.equal(validSshName('prod web'), false)
  assert.equal(validSshName('prod*'), false)
  assert.equal(validSshName('prod-web.1'), true)
  const names = sshNames([
    host({ id: 'a', alias: 'web' }),
    host({ id: 'b', alias: 'web' }),
    host({ id: 'c', alias: 'x', sshConfigName: 'web' }),
    host({ id: 'd', alias: 'Web', sshConfigName: 'bad name' })
  ])
  assert.equal(names.get('c'), 'web')
  assert.deepEqual(['a', 'b', 'd'].map((id) => names.get(id)).sort(), ['Web-4', 'web-2', 'web-3'].sort())
})

test('OpenSSH 옵션과 주석으로 남기는 부가 정보 — 비밀은 쓰지 않는다', () => {
  const groups = [{ id: 'g1', parentId: null, name: '운영', sort: 0 }, { id: 'g2', parentId: 'g1', name: '웹', sort: 0 }]
  const hosts = [
    host({ id: 'bastion', alias: 'bastion', host: 'bastion.example.com', username: 'ec2-user' }),
    host({
      id: 'web', alias: '운영 웹', groupId: 'g2', host: '10.0.0.11', port: 2222, username: 'ubuntu', authType: 'key', credentialId: 'cred-1',
      jumpHostId: 'bastion', tags: ['prod', 'nginx'], env: 'prod', encoding: 'euc-kr', keepaliveSec: 30,
      notes: '담당: 운영팀\n장애 시 #ops 채널', startupCommand: 'cd /app\nls',
      proxy: { type: 'socks5', host: 'proxy.local', port: 1080, credentialId: 'p' },
      forwards: [{ id: 'f1', type: 'L', bindHost: '', bindPort: 8080, destHost: 'localhost', destPort: 80 },
        { id: 'f2', type: 'R', bindHost: '127.0.0.1', bindPort: 9000, destHost: '::1', destPort: 22 }],
      sshConfigName: 'prod-web'
    })
  ]
  const { text } = buildSshConfig(hosts, groups)
  const block = text.slice(text.indexOf('Host prod-web'))
  assert.equal(block.trimEnd(), [
    'Host prod-web',
    '  # BrightTerm 별칭: 운영 웹',
    '  # 그룹: 운영 / 웹',
    '  # 태그: prod, nginx',
    '  # 환경: prod',
    '  # 인증: 개인 키 (BrightTerm 볼트에 저장 — ssh 로 접속하려면 ssh-agent 나 IdentityFile 을 따로 지정)',
    '  # 문자 인코딩: euc-kr (ssh 에는 해당 옵션 없음 — 터미널에서 맞추세요)',
    '  # 프록시: socks5 proxy.local:1080 (ssh 설정에는 반영하지 않음)',
    '  # 접속 후 실행 명령: 2줄 (반영하지 않음)',
    '  # 메모: 담당: 운영팀',
    '  # 메모: 장애 시 #ops 채널',
    '  # BrightTerm id: web',
    '  HostName 10.0.0.11',
    '  Port 2222',
    '  User ubuntu',
    '  ProxyJump bastion',
    '  ServerAliveInterval 30',
    '  LocalForward 8080 localhost:80',
    '  RemoteForward 127.0.0.1:9000 [::1]:22'
  ].join('\n'))
  assert.doesNotMatch(text, /cred-1|^\s*(IdentityFile|PasswordAuthentication)\b/m)
})

test('점프 서버가 동기화 대상이 아니면 주소로, 직접 입력한 베스천도 주소로', () => {
  const hosts = [
    host({ id: 'j', alias: 'jump', host: 'j.example.com', port: 2200, username: 'ops', sshConfig: false, jumpHostId: 'k' }),
    host({ id: 'a', jumpHostId: 'j' }),
    host({ id: 'b', jump: { host: 'fe80::1', port: 22, username: '', authType: 'agent' } })
  ]
  const { text } = buildSshConfig(hosts, [])
  assert.match(text, /Host a\n[\s\S]*?  ProxyJump ops@j\.example\.com:2200\n  # 점프 호스트: jump 의 상위 점프 호스트는 반영되지 않음/)
  assert.match(text, /Host b\n[\s\S]*?  ProxyJump \[fe80::1\]\n/)
})

test('주석에 줄바꿈·제어 문자를 넣어 옵션을 끼워 넣을 수 없다', () => {
  const { text } = buildSshConfig([host({ id: 'x', alias: 'x\n  ProxyCommand evil', notes: 'a\r\nHost *\x1b[31m', tags: ['t\nUser root'] })], [])
  assert.doesNotMatch(text, /^\s*(ProxyCommand|User root)/m)
  assert.doesNotMatch(text, /^Host \*/m)
  assert.equal(text.match(/^\s*[A-Za-z]+ /gm).filter((l) => !l.trim().startsWith('#')).length, 3) // Host, HostName, Port
})

test('Include: 맨 앞에 한 번만 넣고, 뺄 때는 앱이 넣은 줄만 뺀다 — 줄바꿈 유지', () => {
  const user = 'Host *\n  ServerAliveInterval 60\n'
  const added = withInclude(user)
  assert.equal(added, `${INCLUDE_MARKER}\n${INCLUDE_LINE}\n\n${user}`)
  assert.equal(withInclude(added), added)
  assert(hasInclude(added))
  assert.equal(withoutInclude(added), user)
  assert.equal(withInclude(''), `${INCLUDE_MARKER}\n${INCLUDE_LINE}\n`)
  const crlf = 'Host a\r\n  User b\r\n'
  assert.equal(withoutInclude(withInclude(crlf)), crlf)
  assert.match(withInclude(crlf), /^# BrightTerm[^\n]*\r\nInclude brightterm\.conf\r\n\r\nHost a/)
  // 사용자가 직접 쓴 같은 Include(표시 줄 없음)는 앱 것이 아니다
  assert.equal(hasInclude('Include brightterm.conf\n'), false)
})

test('수동 반영: 이 서버 블록만 추가·갱신·삭제하고 다른 블록은 그대로 둔다', async () => {
  const { mergeSshHost, sshHostBlock } = await import('../src/shared/sshConfig.ts')
  const a = host({ id: 'a', alias: 'alpha' })
  const b = host({ id: 'b', alias: 'beta' })
  // 다른 PC 가 쓴 파일이라고 가정 — alpha 만 들어 있고 손으로 넣은 블록도 있다
  let file = buildSshConfig([a], []).text + 'Host manual\n  HostName 1.1.1.1\n'
  // beta 추가
  let r = mergeSshHost(file, 'b', sshHostBlock('b', [a, b], []))
  assert.equal(r.count, 3)
  assert.match(r.text, /Host alpha[\s\S]*Host manual[\s\S]*Host beta/)
  // alpha 갱신(포트 변경) — 위치 유지, 다른 블록 유지
  file = r.text
  r = mergeSshHost(file, 'a', sshHostBlock('a', [{ ...a, port: 2022 }, b], []))
  assert.match(r.text, /Host alpha\n[\s\S]*?  Port 2022\n/)
  assert.equal(r.text.match(/^Host alpha$/gm).length, 1)
  assert.match(r.text, /^Host alpha[\s\S]*^Host manual[\s\S]*^Host beta/m)
  // 동기화를 끈 서버(블록 null)는 뺀다
  r = mergeSshHost(r.text, 'a', sshHostBlock('a', [{ ...a, sshConfig: false }, b], []))
  assert.doesNotMatch(r.text, /^Host alpha$/m)
  assert.match(r.text, /^Host manual$/m)
  assert.match(r.text, /^Host beta$/m)
  assert.equal(r.count, 2)
  // 같은 Host 이름을 쓰던 블록은 새 블록으로 바꾼다
  r = mergeSshHost(r.text, 'c', sshHostBlock('c', [host({ id: 'c', alias: 'x', sshConfigName: 'manual' })], []))
  assert.equal(r.text.match(/^Host manual$/gm).length, 1)
  assert.match(r.text, /Host manual\n  # BrightTerm 별칭: x/)
  // 마지막 블록을 빼면 0
  assert.equal(mergeSshHost(buildSshConfig([a], []).text, 'a', null).count, 0)
})
