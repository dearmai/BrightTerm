import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { filterSections, manualsFor, parseInline, parseManual, withCommon } from '../src/renderer/src/manuals/manual.ts'
import { parseServerEnv, SERVER_ENV_SCRIPT } from '../src/main/serverEnv.ts'

test('uname 결과에서 AIX 버전과 쉘을 읽는다', () => {
  assert.deepEqual(parseServerEnv('Welcome to prod\nBT_OS AIX\nBT_REL 3\nBT_VER 7\nBT_SHELL /usr/bin/ksh\n'), { os: 'AIX', osVersion: '7.3', shell: '/usr/bin/ksh' })
  assert.deepEqual(parseServerEnv('BT_OS Linux\nBT_REL 6.8.0-40\nBT_VER #40-Ubuntu SMP\nBT_SHELL /bin/bash\n'), { os: 'Linux', osVersion: '6.8.0-40', shell: '/bin/bash' })
  assert.equal(parseServerEnv('sh: not found\n'), null)
})

test('/etc/os-release 에서 배포판을 읽는다 — 따옴표는 벗긴다', () => {
  const env = parseServerEnv('BT_OS Linux\nBT_REL 5.14.0-687.33.1.el9_8.x86_64\nBT_VER #1 SMP\nBT_SHELL /usr/bin/zsh\nBT_DIST_NAME "Rocky Linux 9.8 (Blue Onyx)"\nBT_DIST_ID "rocky"\nBT_DIST_LIKE "rhel centos fedora"\nBT_DIST_VER "9.8"\n')
  assert.deepEqual(env.distro, { id: 'rocky', like: 'rhel centos fedora', version: '9.8', name: 'Rocky Linux 9.8 (Blue Onyx)' })
  assert.deepEqual(parseServerEnv('BT_OS Linux\nBT_REL 6\nBT_VER 1\nBT_SHELL /bin/bash\nBT_DIST_ID ubuntu\nBT_DIST_VER 24.04\n').distro, { id: 'ubuntu', like: '', version: '24.04', name: '' })
})

test('RHEL 과 호환 배포판을 메이저 버전으로 고른다', () => {
  const linux = (id, like, version, shell) => ({ os: 'Linux', osVersion: '6', shell, distro: { id, like, version, name: id } })
  // 실제 UBI 의 값: RHEL 9 의 ID_LIKE 는 fedora, RHEL 10 은 centos fedora
  assert.deepEqual(manualsFor(linux('rhel', 'fedora', '9.8', '/bin/bash')), ['rhel9', 'bash'])
  assert.deepEqual(manualsFor(linux('rhel', 'centos fedora', '10.2', '/usr/bin/zsh')), ['rhel10', 'zsh'])
  assert.deepEqual(manualsFor(linux('rocky', 'rhel centos fedora', '9.8', '/usr/bin/zsh')), ['rhel9', 'zsh'])
  assert.deepEqual(manualsFor(linux('almalinux', 'rhel centos fedora', '10.1', '/bin/bash')), ['rhel10', 'bash'])
  assert.deepEqual(manualsFor(linux('rhel', 'fedora', '8.10', '/bin/bash')), ['bash'])
  assert.deepEqual(manualsFor(linux('ubuntu', 'debian', '24.04', '/bin/bash')), ['bash'])
  assert.deepEqual(manualsFor(linux('fedora', '', '40', '/bin/zsh')), ['zsh'])
  // 9.10 이 10 으로 읽히면 안 된다
  assert.deepEqual(manualsFor(linux('rhel', 'fedora', '9.10', '/bin/sh')), ['rhel9'])
})

test('버전별 문서 뒤에 공통 절을 넣고 공식 문서는 맨 뒤에 둔다', () => {
  const titles = withCommon('## 차이\n글\n## 공식 문서\n- 링크\n', '## 공통1\n글\n## 공통2\n글\n').map((s) => s.title)
  assert.deepEqual(titles, ['차이', '공통1', '공통2', '공식 문서'])
})

test('감지 스크립트는 실제 sh 에서 읽을 수 있는 결과를 낸다', () => {
  const output = execFileSync('sh', ['-s'], { input: SERVER_ENV_SCRIPT, encoding: 'utf8', timeout: 4500, env: { ...process.env, SHELL: '/usr/bin/ksh' } })
  const env = parseServerEnv(output)
  assert.ok(env?.os && env.osVersion, output)
  assert.equal(env.shell, '/usr/bin/ksh')
})

test('서버에 맞는 매뉴얼을 고른다', () => {
  assert.deepEqual(manualsFor({ os: 'AIX', osVersion: '7.2', shell: '/usr/bin/ksh' }), ['aix', 'ksh'])
  assert.deepEqual(manualsFor({ os: 'AIX', osVersion: '7.3', shell: '/usr/bin/ksh93' }), ['aix', 'ksh'])
  assert.deepEqual(manualsFor({ os: 'AIX', osVersion: '7.1', shell: '/usr/bin/csh' }), [])
  assert.deepEqual(manualsFor({ os: 'Linux', osVersion: '7.3', shell: '/bin/ksh' }), ['ksh'])
  assert.deepEqual(manualsFor({ os: 'Linux', osVersion: '6.8', shell: '/bin/bash' }), ['bash'])
  assert.deepEqual(manualsFor({ os: 'Linux', osVersion: '6.8', shell: '/bin/zsh' }), ['zsh'])
  assert.deepEqual(manualsFor({ os: 'Linux', osVersion: '6.8', shell: '/usr/bin/fish' }), [])
  assert.deepEqual(manualsFor({ os: 'AIX', osVersion: '7.3', shell: '/usr/bin/bash' }), ['aix', 'bash'])
})

test('마크다운 일부를 절과 블록으로 나눈다', () => {
  const [a, b] = parseManual('# 제목\n버리는 글\n\n## 하나\n첫 줄\n둘째 줄\n\n- 가\n- 나\n\n```\n# 주석\n| 파이프\n```\n\n## 둘\n### 소제목\n| A | B |\n|---|---|\n| `x \\| y` | 2 |\n')
  assert.deepEqual(a, { title: '하나', blocks: [
    { type: 'p', text: '첫 줄 둘째 줄' },
    { type: 'ul', items: ['가', '나'] },
    { type: 'code', text: '# 주석\n| 파이프' }
  ] })
  assert.deepEqual(b, { title: '둘', blocks: [
    { type: 'h3', text: '소제목' },
    { type: 'table', head: ['A', 'B'], rows: [['`x | y`', '2']] }
  ] })
})

test('줄 안의 코드·굵게·링크를 나눈다', () => {
  assert.deepEqual(parseInline('a `b` **c** [d](https://e.f) g'), [
    { type: 'text', text: 'a ' }, { type: 'code', text: 'b' }, { type: 'text', text: ' ' }, { type: 'bold', text: 'c' },
    { type: 'text', text: ' ' }, { type: 'link', text: 'd', url: 'https://e.f' }, { type: 'text', text: ' g' }
  ])
})

test('검색은 절 전체에서 모든 단어를 찾는다', () => {
  const sections = parseManual('## 로그\n```\nerrpt -a\n```\n## 표\n| LVM | lspv |\n|---|---|\n| x | CHFS |\n')
  assert.deepEqual(filterSections(sections, 'ERRPT').map((s) => s.title), ['로그'])
  assert.deepEqual(filterSections(sections, 'lvm chfs').map((s) => s.title), ['표'])
  assert.deepEqual(filterSections(sections, 'errpt chfs'), [])
  assert.equal(filterSections(sections, '  ').length, 2)
})

test('포함된 문서가 파서 규칙에 맞다', () => {
  for (const name of ['aix', 'ksh', 'rhel9', 'rhel10', 'rhel-common', 'bash', 'zsh']) {
    const text = readFileSync(new URL(`../src/renderer/src/manuals/${name}.md`, import.meta.url), 'utf8')
    assert.equal((text.match(/^```/gm) ?? []).length % 2, 0, `${name}: 코드 블록이 닫히지 않음`)
    const sections = parseManual(text)
    assert.ok(sections.length >= 3, name)
    if (name !== 'rhel-common') assert.equal(sections.at(-1).title, '공식 문서', name)
    for (const s of sections) {
      assert.ok(s.blocks.length, `${name}: 빈 절 ${s.title}`)
      for (const b of s.blocks) if (b.type === 'table') for (const r of b.rows) assert.equal(r.length, b.head.length, `${name}: ${s.title} 표 열 수 ${r}`)
    }
  }
})
