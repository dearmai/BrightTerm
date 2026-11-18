// make install 이 끝나면 빌드 완료본을 배포 폴더로 복사한다 (Windows).
// 배포 폴더는 .env 의 BRIGHTTERM_DEPLOY_DIR (환경 변수가 있으면 그 값이 먼저). 없으면 경고만 하고 넘어간다.
// 배포 폴더에는 최신 빌드본과 이력 파일만 둔다 — 이 스크립트가 예전에 복사한 파일(이력에 적힌 것)만 지우고,
// 그 폴더의 다른 파일은 건드리지 않는다.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const HISTORY = 'BrightTerm-build-history.log'

/** KEY=VALUE 한 줄씩. # 주석, 앞뒤 따옴표 허용 */
function readEnv(file) {
  const out = {}
  if (!existsSync(file)) return out
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!m) continue
    let v = m[2].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    out[m[1]] = v
  }
  return out
}

const warn = (msg) => console.warn(`\n[deploy] 경고: ${msg}\n`)

const env = readEnv(join(root, '.env'))
const target = (process.env.BRIGHTTERM_DEPLOY_DIR ?? env.BRIGHTTERM_DEPLOY_DIR ?? '').trim()
if (!target) {
  warn('BRIGHTTERM_DEPLOY_DIR 이 설정되지 않아 빌드본을 배포 폴더로 복사하지 않았습니다. .env.example 을 참고해 .env 에 경로를 적으세요.')
  process.exit(0)
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const files = [`${pkg.productName}-Setup-${pkg.version}.exe`, `${pkg.productName}-Portable-${pkg.version}.exe`]
const missing = files.filter((f) => !existsSync(join(root, 'dist', f)))
if (missing.length) {
  console.error(`[deploy] 빌드본이 없습니다: ${missing.join(', ')} — 먼저 make build 를 하세요`)
  process.exit(1)
}

mkdirSync(target, { recursive: true })
const historyFile = join(target, HISTORY)

// 이력에 적힌 예전 빌드본 중 이번 파일이 아닌 것만 지운다
const previous = new Set()
if (existsSync(historyFile)) {
  for (const line of readFileSync(historyFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/\tfile=([^\t]+)/g)
    if (m) for (const x of m) previous.add(x.slice('\tfile='.length))
  }
}
for (const old of previous) {
  if (files.includes(old) || old.includes('/') || old.includes('\\') || old === HISTORY) continue
  const p = join(target, old)
  if (existsSync(p)) {
    rmSync(p, { force: true })
    console.log(`[deploy] 예전 빌드본 삭제: ${old}`)
  }
}

const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')
const git = (...args) => { try { return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim() } catch { return '' } }
const commit = git('rev-parse', '--short', 'HEAD') + (git('status', '--porcelain', '--untracked-files=no') ? '+dirty' : '')
let buildId = ''
try { buildId = readFileSync(join(root, '.last-build-id'), 'utf8').trim() } catch { /* */ }

const at = new Date()
const pad = (n) => String(n).padStart(2, '0')
const stamp = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`
const entries = []
for (const f of files) {
  const src = join(root, 'dist', f)
  const dst = join(target, f)
  // 동기화 폴더(OneDrive)가 반쯤 복사된 파일을 올리지 않게 임시 이름으로 복사한 뒤 바꾼다
  const tmp = `${dst}.partial`
  copyFileSync(src, tmp)
  rmSync(dst, { force: true })
  renameSync(tmp, dst)
  entries.push(`${stamp}\tversion=${pkg.version}\tbuild=${buildId}\tcommit=${commit}\tfile=${f}\tsize=${statSync(dst).size}\tsha256=${sha256(dst)}`)
  console.log(`[deploy] 복사: ${dst}`)
}
appendFileSync(historyFile, entries.join('\n') + '\n')
console.log(`[deploy] 이력 기록: ${historyFile}`)
