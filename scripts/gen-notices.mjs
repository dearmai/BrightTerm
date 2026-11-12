// THIRD_PARTY_NOTICES.txt 생성 — 앱에 실제로 들어가는 제3자 구성요소의 저작권 고지·라이선스 전문.
// 대상: 메인 프로세스 의존성(dependencies 전이 포함) + 렌더러 번들에 들어가는 패키지(RENDERER) + Electron 런타임.
// 빌드 전에 실행한다(npm run notices). 의존성을 바꾸면 다시 생성해 커밋할 것.
// OS 마다 설치되지 않는 선택 의존성(cpu-features 등)은 package-lock.json 으로 찾아 기존 고지의 전문을 유지한다 —
// 어느 OS 에서 생성해도 같은 파일이 나온다. 새 선택 의존성은 그것이 설치되는 OS 에서 처음 생성한다.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'fs'
import { dirname, join, relative, sep } from 'path'

const ROOT = process.cwd()
const RENDERER = ['react', 'react-dom', 'zustand', 'lucide-react', '@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-search', '@xterm/addon-unicode11', '@xterm/addon-web-links', '@xterm/addon-webgl']

const seen = new Map() // dir -> pkg
// 이 PC 에 설치되지 않은 선택 의존성(ssh2 의 cpu-features 등 OS 별 네이티브 모듈) — lock 경로 -> { name, version }
// 설치된 OS 에서만 고지에 들어가면 OS 마다 파일이 달라진다. package-lock.json 기준으로 항상 넣는다.
const absent = new Map()
const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')).packages ?? {}
const lockKey = (dir) => relative(ROOT, dir).split(sep).join('/')

/** npm 해석 순서대로 lock 의 패키지 경로를 찾는다 (from 은 lock 경로, 루트는 '') */
function resolveLock(name, from) {
  let d = from
  for (;;) {
    const key = `${d ? d + '/' : ''}node_modules/${name}`
    if (lock[key]) return key
    if (!d) return null
    const i = d.lastIndexOf('/node_modules/')
    d = i < 0 ? '' : d.slice(0, i)
  }
}

function walkAbsent(name, from) {
  const key = resolveLock(name, from)
  if (!key || absent.has(key)) return
  const meta = lock[key]
  absent.set(key, { name, version: meta.version })
  for (const dep of Object.keys({ ...meta.dependencies, ...meta.optionalDependencies })) {
    const dir = resolveDir(dep, join(ROOT, ...key.split('/')))
    if (dir) walk(dep, join(ROOT, ...key.split('/')))
    else walkAbsent(dep, key)
  }
}

function resolveDir(name, from) {
  let d = from
  for (;;) {
    const p = join(d, 'node_modules', name)
    if (existsSync(join(p, 'package.json'))) return p
    const up = dirname(d)
    if (up === d) return null
    d = up
  }
}

function walk(name, from, deep = true) {
  const dir = resolveDir(name, from)
  if (!dir) { walkAbsent(name, lockKey(from)); return }
  if (seen.has(dir)) return
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  seen.set(dir, pkg)
  if (!deep) return
  for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) walk(dep, dir)
}

const root = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
for (const d of [...Object.keys(root.dependencies), ...RENDERER]) walk(d, ROOT)
// electron 의 npm 의존성(@electron/get 등)은 설치 도구일 뿐 앱에 들어가지 않는다 — 런타임 고지만
walk('electron', ROOT, false)

function licenseText(dir) {
  const f = readdirSync(dir).find((n) => /^(licen[cs]e|copying)(\.|$|-mit)/i.test(n))
  return f ? readFileSync(join(dir, f), 'utf8').trim() : null
}

const SEP = '='.repeat(78)
/** 기존 고지 파일의 항목별 라이선스·전문 — 이 PC 에 없는 선택 의존성에 쓴다 */
function previousNotices() {
  const file = join(ROOT, 'THIRD_PARTY_NOTICES.txt')
  const blocks = new Map()
  if (!existsSync(file)) return blocks
  // 라이선스 원문의 줄바꿈(CRLF 등)은 패키지 파일 그대로 둔다 — 설치된 OS 에서 만든 결과와 같아야 한다
  const lines = readFileSync(file, 'utf8').split('\n')
  const sepAt = (i) => lines[i]?.replace(/\r$/, '') === SEP
  for (let i = 0; i + 2 < lines.length; i++) {
    if (!sepAt(i) || !sepAt(i + 2)) continue
    const m = lines[i + 1].replace(/\r$/, '').match(/^(\S+) (\S+) — (.*)$/)
    if (!m) continue
    let end = i + 3
    while (end < lines.length && !sepAt(end)) end++
    blocks.set(`${m[1]}@${m[2]}`, { license: m[3], text: lines.slice(i + 3, end).join('\n').trim() })
    i = end - 1
  }
  return blocks
}
const previous = previousNotices()

const installed = [...seen.entries()]
  .map(([dir, pkg]) => ({ dir, name: pkg.name, version: pkg.version, license: typeof pkg.license === 'string' ? pkg.license : pkg.license?.type ?? pkg.licenses?.map?.((l) => l.type ?? l).join(' OR ') ?? '(package.json 표기 없음 — 아래 전문 참고)' }))
const have = new Set(installed.map((e) => `${e.name}@${e.version}`))
const unavailable = []
const fromLock = [...absent.values()].filter((a) => !have.has(`${a.name}@${a.version}`) && have.add(`${a.name}@${a.version}`)).map((a) => {
  const p = previous.get(`${a.name}@${a.version}`)
  if (!p) unavailable.push(`${a.name}@${a.version}`)
  return { dir: null, name: a.name, version: a.version, license: p?.license, text: p?.text }
})
if (unavailable.length) {
  console.error(`이 PC 에 설치되지 않았고 기존 고지에도 없는 선택 의존성: ${unavailable.join(', ')}\n해당 패키지가 설치되는 OS(예: macOS·Linux)에서 npm ci 후 npm run notices 로 생성하세요.`)
  process.exit(1)
}
const entries = [...installed, ...fromLock]
  .filter((e) => !['@types/', 'electron-'].some((p) => e.name.startsWith(p)) || e.name === 'electron')
  .sort((a, b) => a.name.localeCompare(b.name))

const out = [
  'BrightTerm — 제3자 구성요소 고지 (Third-Party Notices)',
  '',
  'BrightTerm 자체 코드의 이용조건은 LICENSE 를 보세요. 아래 구성요소에는 각각의 라이선스가 적용되며,',
  'BrightTerm 의 라이선스가 이 구성요소들의 권리를 바꾸지 않습니다.',
  'Electron 에 포함된 Chromium 및 그 구성요소의 고지는 함께 동봉한 LICENSES.chromium.html 에 있습니다.',
  '',
  `구성요소 ${entries.length}개`,
  ...entries.map((e) => `  - ${e.name} ${e.version} (${e.license})`),
  ''
]
const missing = []
for (const e of entries) {
  const text = e.dir ? licenseText(e.dir) : e.text
  if (!text) missing.push(e.name)
  out.push(SEP, `${e.name} ${e.version} — ${e.license}`, SEP, text ?? `(라이선스 파일이 패키지에 없습니다. package.json 표기: ${e.license})`, '')
}
writeFileSync(join(ROOT, 'THIRD_PARTY_NOTICES.txt'), out.join('\n'))
console.log(`THIRD_PARTY_NOTICES.txt: ${entries.length} packages${fromLock.length ? ` (이 PC 에 없는 선택 의존성 ${fromLock.map((e) => e.name).join(', ')} 은 기존 고지 유지)` : ''}${missing.length ? `, 라이선스 파일 없음: ${missing.join(', ')}` : ''}`)
const licenses = {}
for (const e of entries) licenses[e.license] = (licenses[e.license] ?? 0) + 1
console.log(licenses)
