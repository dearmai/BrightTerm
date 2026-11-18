// make install 이 끝나면 빌드 완료본을 배포 폴더로 복사한다 (Windows).
// 배포 폴더는 .env 의 BRIGHTTERM_DEPLOY_DIR (환경 변수가 있으면 그 값이 먼저). 없으면 경고만 하고 넘어간다.
// 배포 폴더에는 최신 빌드본과 이력 파일만 둔다 — 이 스크립트가 예전에 복사한 파일(이력에 적힌 것)만 지우고,
// 그 폴더의 다른 파일은 건드리지 않는다.
// 빌드본을 서명한 인증서(.cer, 공개 인증서뿐)와 대상 PC 등록 스크립트(install-cert.cmd·.sh)도 함께 둔다.
// 인증서는 지문별 파일(BrightTerm-codesign-<지문 앞 8자>.cer)로 쌓이므로, 빌드 PC 마다 인증서가 달라도 모두 남는다.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import readEnvModule from './read-env.cjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const HISTORY = 'BrightTerm-build-history.log'

const warn = (msg) => console.warn(`\n[deploy] 경고: ${msg}\n`)

const target = readEnvModule.envValue('BRIGHTTERM_DEPLOY_DIR')
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

/** OneDrive 가 반쯤 쓴 파일을 올리지 않게 임시 이름으로 쓴 뒤 바꾼다 */
function replaceFile(dst, write) {
  const tmp = `${dst}.partial`
  write(tmp)
  rmSync(dst, { force: true })
  renameSync(tmp, dst)
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
  replaceFile(dst, (tmp) => copyFileSync(src, tmp))
  entries.push(`${stamp}\tversion=${pkg.version}\tbuild=${buildId}\tcommit=${commit}\tfile=${f}\tsize=${statSync(dst).size}\tsha256=${sha256(dst)}`)
  console.log(`[deploy] 복사: ${dst}`)
}
appendFileSync(historyFile, entries.join('\n') + '\n')
console.log(`[deploy] 이력 기록: ${historyFile}`)

// 서명 인증서 + 등록 스크립트. 실패해도 빌드본 배포는 이미 끝났으므로 경고만 한다.
try {
  const setup = join(target, files[0]).replace(/'/g, "''")
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$c = (Get-AuthenticodeSignature -LiteralPath '${setup}').SignerCertificate; if ($c) { $c.Thumbprint; [Convert]::ToBase64String($c.Export('Cert')) }`],
  { encoding: 'utf8' }).trim().split(/\r?\n/)
  if (out.length < 2 || !/^[0-9A-F]{40}$/i.test(out[0])) {
    warn(`${files[0]} 에 서명이 없어 인증서를 배포하지 않았습니다.`)
  } else {
    const thumb = out[0].toUpperCase()
    const cer = join(target, `BrightTerm-codesign-${thumb.slice(0, 8)}.cer`)
    const der = Buffer.from(out[1], 'base64')
    if (existsSync(cer) && readFileSync(cer).equals(der)) {
      console.log(`[deploy] 인증서 그대로: ${cer} (지문 ${thumb})`)
    } else {
      replaceFile(cer, (tmp) => writeFileSync(tmp, der))
      console.log(`[deploy] 인증서: ${cer} (지문 ${thumb})`)
    }
  }
  for (const f of ['install-cert.cmd', 'install-cert.sh']) {
    const dst = join(target, f)
    replaceFile(dst, (tmp) => copyFileSync(join(root, 'build', 'codesign', f), tmp))
    console.log(`[deploy] 등록 스크립트: ${dst}`)
  }
} catch (e) {
  warn(`인증서·등록 스크립트를 배포하지 못했습니다: ${e.message}`)
}
