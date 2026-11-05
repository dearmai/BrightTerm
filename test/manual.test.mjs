import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { filterSections, manualsFor, parseInline, parseManual } from '../src/renderer/src/manuals/manual.ts'
import { parseServerEnv, SERVER_ENV_SCRIPT } from '../src/main/serverEnv.ts'

test('uname 결과에서 AIX 버전과 쉘을 읽는다', () => {
  assert.deepEqual(parseServerEnv('Welcome to prod\nBT_OS AIX\nBT_REL 3\nBT_VER 7\nBT_SHELL /usr/bin/ksh\n'), { os: 'AIX', osVersion: '7.3', shell: '/usr/bin/ksh' })
  assert.deepEqual(parseServerEnv('BT_OS Linux\nBT_REL 6.8.0-40\nBT_VER #40-Ubuntu SMP\nBT_SHELL /bin/bash\n'), { os: 'Linux', osVersion: '6.8.0-40', shell: '/bin/bash' })
  assert.equal(parseServerEnv('sh: not found\n'), null)
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
  assert.deepEqual(manualsFor({ os: 'AIX', osVersion: '7.3', shell: '/usr/bin/bash' }), ['aix'])
  assert.deepEqual(manualsFor({ os: 'AIX', osVersion: '7.1', shell: '/usr/bin/csh' }), [])
  assert.deepEqual(manualsFor({ os: 'Linux', osVersion: '7.3', shell: '/bin/ksh' }), ['ksh'])
  assert.deepEqual(manualsFor({ os: 'Linux', osVersion: '6.8', shell: '/bin/bash' }), [])
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
  for (const name of ['aix', 'ksh']) {
    const text = readFileSync(new URL(`../src/renderer/src/manuals/${name}.md`, import.meta.url), 'utf8')
    assert.equal((text.match(/^```/gm) ?? []).length % 2, 0, `${name}: 코드 블록이 닫히지 않음`)
    const sections = parseManual(text)
    assert.ok(sections.length >= 5, name)
    for (const s of sections) {
      assert.ok(s.blocks.length, `${name}: 빈 절 ${s.title}`)
      for (const b of s.blocks) if (b.type === 'table') for (const r of b.rows) assert.equal(r.length, b.head.length, `${name}: ${s.title} 표 열 수 ${r}`)
    }
  }
})
