// node --test test/session-log.test.mjs
// 세션 로그: 규칙 정규화·앱/서버 우선순위·파일 이름·보관 정리·회전·압축을 실제 임시 폴더로 확인한다.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { registerHooks } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_SESSION_LOG_OPTIONS, normalizeSessionLogOptions, resolveSessionLog, logStem, logFileName, logFilePattern,
  filesToPrune, shouldRotate, formatLogChunk
} from '../src/shared/sessionLog.ts'

// 메인 프로세스 모듈의 @shared/* 를 소스 파일로 잇는다
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith('@shared/')) return next(new URL(`../src/shared/${spec.slice(8)}.ts`, import.meta.url).href, ctx)
    return next(spec, ctx)
  }
})
const { SessionLogWriter, resolveLogDir, isForeignPath } = await import('../src/main/sessionLog.ts')

const opts = (o = {}) => normalizeSessionLogOptions({ ...DEFAULT_SESSION_LOG_OPTIONS, ...o })
const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error('timeout')
    await new Promise((r) => setTimeout(r, 20))
  }
}

test('규칙 정규화 — 잘못된 값·백업값은 기본값, 음수는 0, 형식은 text/raw 만', () => {
  assert.deepEqual(normalizeSessionLogOptions(null), DEFAULT_SESSION_LOG_OPTIONS)
  const o = normalizeSessionLogOptions({ dir: '  /var/log/bt  ', format: 'html', maxSizeMB: -5, maxFiles: 3.6, retentionDays: 'x', compress: 1 })
  assert.equal(o.dir, '/var/log/bt')
  assert.equal(o.format, 'text')
  assert.equal(o.maxSizeMB, 0)
  assert.equal(o.maxFiles, 4)
  assert.equal(o.retentionDays, DEFAULT_SESSION_LOG_OPTIONS.retentionDays)
  assert.equal(o.compress, false)
})

test('서버 설정이 앱 설정보다 우선 — 지정하지 않으면 앱 값', () => {
  const app = { sessionLog: false, sessionLogOptions: opts({ maxFiles: 10 }) }
  assert.deepEqual(resolveSessionLog(app, {}), { enabled: false, options: opts({ maxFiles: 10 }) })
  assert.equal(resolveSessionLog(app, { sessionLog: true }).enabled, true)
  assert.equal(resolveSessionLog({ ...app, sessionLog: true }, { sessionLog: false }).enabled, false)
  assert.equal(resolveSessionLog(app, { sessionLogOptions: opts({ maxFiles: 3 }) }).options.maxFiles, 3)
})

test('파일 이름 — 쓸 수 없는 문자 대체, 서버별 패턴은 비슷한 별칭과 섞이지 않는다', () => {
  assert.equal(logStem('db:01/prod?'), 'db_01_prod_')
  assert.equal(logStem('  ...'), 'session')
  const name = logFileName('web', new Date(2026, 10, 12, 9, 8, 7))
  assert.equal(name, 'web_20261112-090807.log')
  assert.equal(logFileName('web', new Date(2026, 10, 12, 9, 8, 7), 2), 'web_20261112-090807.2.log')
  const re = logFilePattern('web')
  for (const n of [name, 'web_20261112-090807.2.log', name + '.gz', name + '.gz.tmp', 'web-20250101-1200.log']) assert.ok(re.test(n), n)
  for (const n of ['web_01_20261112-090807.log', 'web.prod_20261112-090807.log', 'other_20261112-090807.log', 'web_20261112-090807.txt']) assert.ok(!re.test(n), n)
  assert.ok(logFilePattern('a.b').test('a.b_20261112-090807.log'))
  assert.ok(!logFilePattern('a.b').test('aXb_20261112-090807.log'))
})

test('보관 정리 — 기간·개수, 쓰는 파일은 남기고 원본·압축본은 한 개로 센다', () => {
  const day = 86400000
  const now = 100 * day
  const files = [
    { name: 'a_1.log', mtimeMs: now - 1 },
    { name: 'a_2.log', mtimeMs: now - 2 * day },
    { name: 'a_2.log.gz', mtimeMs: now - 2 * day + 5 },
    { name: 'a_3.log.gz', mtimeMs: now - 3 * day },
    { name: 'a_4.log.gz', mtimeMs: now - 40 * day }
  ]
  assert.deepEqual(filesToPrune(files, { maxFiles: 0, retentionDays: 30 }, now).sort(), ['a_4.log.gz'])
  assert.deepEqual(filesToPrune(files, { maxFiles: 2, retentionDays: 0 }, now).sort(), ['a_3.log.gz', 'a_4.log.gz'])
  assert.deepEqual(filesToPrune(files, { maxFiles: 0, retentionDays: 0 }, now), [])
  // 같은 초·같은 수정 시각이면 일련번호가 큰 쪽이 최근
  const same = ['s_20261112-090807.log', 's_20261112-090807.1.log', 's_20261112-090807.10.log', 's_20261112-090807.2.log'].map((name) => ({ name, mtimeMs: now }))
  assert.deepEqual(filesToPrune(same, { maxFiles: 2, retentionDays: 0 }, now).sort(), ['s_20261112-090807.1.log', 's_20261112-090807.log'])
  // 오래된 파일이라도 지금 쓰는 중이면 지우지 않는다
  assert.deepEqual(filesToPrune(files, { maxFiles: 1, retentionDays: 30 }, now, new Set(['a_4.log.gz'])).sort(), ['a_2.log', 'a_2.log.gz', 'a_3.log.gz'])
})

test('회전 판정 — 크기, 날짜, 빈 파일은 넘기지 않음', () => {
  const openedAt = new Date(2026, 10, 12, 23, 59)
  const o = { maxSizeMB: 1, rotateDaily: true }
  assert.equal(shouldRotate(o, { bytes: 0, openedAt }, 5 * 1024 * 1024, openedAt), false)
  assert.equal(shouldRotate(o, { bytes: 1024 * 1024 - 10, openedAt }, 20, openedAt), true)
  assert.equal(shouldRotate(o, { bytes: 10, openedAt }, 20, new Date(2026, 10, 13, 0, 0)), true)
  assert.equal(shouldRotate({ maxSizeMB: 0, rotateDaily: false }, { bytes: 1e12, openedAt }, 20, new Date(2027, 0, 1)), false)
})

test('기록 형식 — 텍스트는 제어 코드 제거·줄 단위 시각, 원본은 그대로', () => {
  const now = new Date(2026, 10, 12, 9, 8, 7)
  const t = { format: 'text', timestamp: true }
  let r = formatLogChunk('\x1b[32mok\x1b[0m\r\nnext', t, true, now)
  assert.equal(r.text, '[2026-11-12 09:08:07] ok\n[2026-11-12 09:08:07] next')
  assert.equal(r.lineStart, false)
  r = formatLogChunk(' line\r\n', t, r.lineStart, now)
  assert.equal(r.text, ' line\n')
  assert.equal(r.lineStart, true)
  assert.equal(formatLogChunk('\x1b[1mA\x1b[0m\r\n', { format: 'text', timestamp: false }, true, now).text, 'A\n')
  assert.equal(formatLogChunk('\x1b[1mA\r\n', { format: 'raw', timestamp: true }, true, now).text, '\x1b[1mA\r\n')
})

test('폴더 해석 — 빈 값은 기본, ~ 는 홈, 상대 경로는 기본 폴더 아래', () => {
  const base = join(tmpdir(), 'bt-base')
  assert.equal(resolveLogDir('', base), base)
  assert.equal(resolveLogDir('sub', base), join(base, 'sub'))
  assert.ok(!resolveLogDir('~/x', base).includes('~'))
  // 동기화된 윈도우 경로는 macOS·Linux 에서 쓰지 않는다
  assert.equal(isForeignPath('D:\\logs', 'linux'), true)
  assert.equal(isForeignPath('\\\\nas\\logs', 'darwin'), true)
  assert.equal(isForeignPath('D:\\logs', 'win32'), false)
  assert.equal(isForeignPath('/var/log/bt', 'linux'), false)
})

test('파일 기록 — 크기 회전, 개수 제한 정리, 다른 서버 파일은 그대로', async () => {
  const base = mkdtempSync(join(tmpdir(), 'bt-sessionlog-'))
  try {
    const old = join(base, 'web-20200101-1200.log')
    writeFileSync(old, 'legacy')
    utimesSync(old, new Date(2020, 0, 1), new Date(2020, 0, 1))
    writeFileSync(join(base, 'other_20200101-120000.log'), 'other')
    const notices = []
    const w = SessionLogWriter.open({ stem: 'web', title: 'web (u@h:22)', options: opts({ maxSizeMB: 1, maxFiles: 2, retentionDays: 30, rotateDaily: false }), baseDir: base, onNotice: (m) => notices.push(m) })
    assert.ok(w)
    const chunk = 'x'.repeat(400 * 1024) + '\n'
    for (let i = 0; i < 8; i++) w.write(`\x1b[31m${chunk}`)
    w.close()
    const mine = () => readdirSync(base).filter((n) => n.startsWith('web'))
    await until(() => mine().length === 2)
    assert.deepEqual(mine().map((n) => n.replace(/^web_\d{8}-\d{6}/, '')).sort(), ['.2.log', '.3.log'], '가장 최근 두 파일만 남는다')
    assert.ok(!existsSync(old), '보관 기간이 지난 이전 형식 파일 삭제')
    assert.ok(existsSync(join(base, 'other_20200101-120000.log')), '다른 서버 파일은 그대로')
    const text = readFileSync(join(base, mine().sort().at(-1)), 'utf8')
    assert.match(text, /^=== BrightTerm 세션 로그 · web \(u@h:22\) · .* · \d+번째 파일 ===\n/)
    assert.ok(!text.includes('\x1b'))
    for (const n of mine()) assert.ok(readFileSync(join(base, n)).length <= 1024 * 1024 + 200, n)
    assert.deepEqual(notices, [])
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('압축 — 닫은 파일은 .log.gz 로, 내용 보존', async () => {
  const base = mkdtempSync(join(tmpdir(), 'bt-sessionlog-'))
  try {
    const w = SessionLogWriter.open({ stem: 'gz', title: 'gz', options: opts({ compress: true, timestamp: true }), baseDir: base, onNotice: () => {} })
    w.write('hello\r\nworld\r\n')
    w.close()
    await until(() => readdirSync(base).some((n) => n.endsWith('.log.gz')) && !readdirSync(base).some((n) => n.endsWith('.log') || n.endsWith('.tmp')))
    const gz = readdirSync(base).find((n) => n.endsWith('.log.gz'))
    const text = gunzipSync(readFileSync(join(base, gz))).toString('utf8')
    assert.match(text, /\] hello\n\[.*\] world\n$/)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('서버별 폴더를 만들 수 없으면 기본 폴더에 쓰고 알린다', async () => {
  const base = mkdtempSync(join(tmpdir(), 'bt-sessionlog-'))
  try {
    const blocker = join(base, 'not-a-dir')
    writeFileSync(blocker, '')
    const notices = []
    const w = SessionLogWriter.open({ stem: 'fb', title: 'fb', options: opts({ dir: join(blocker, 'logs') }), baseDir: join(base, 'logs'), onNotice: (m) => notices.push(m) })
    assert.ok(w)
    assert.equal(notices.length, 1)
    assert.match(notices[0], /기본 폴더에 저장/)
    w.write('ok\n')
    w.close()
    await until(() => readdirSync(join(base, 'logs')).length === 1)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('같은 서버를 두 창으로 열어도 서로 쓰는 파일은 지우지 않는다', async () => {
  const base = mkdtempSync(join(tmpdir(), 'bt-sessionlog-'))
  try {
    mkdirSync(base, { recursive: true })
    const o = opts({ maxFiles: 1, retentionDays: 0 })
    const a = SessionLogWriter.open({ stem: 'dup', title: 'dup', options: o, baseDir: base, onNotice: () => {} })
    const b = SessionLogWriter.open({ stem: 'dup', title: 'dup', options: o, baseDir: base, onNotice: () => {} })
    assert.notEqual(a.path, b.path)
    a.write('a\n')
    b.write('b\n')
    await new Promise((r) => setTimeout(r, 200))
    assert.ok(existsSync(a.path) && existsSync(b.path))
    a.close()
    b.close()
  } finally {
    await new Promise((r) => setTimeout(r, 100))
    rmSync(base, { recursive: true, force: true })
  }
})
