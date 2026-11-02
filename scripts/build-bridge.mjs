// 보안 프로그램 연동 브릿지 빌드 — bridge/main.go 를 Windows 실행 파일로 만들어 PuTTY·Xshell·SecureCRT 이름으로 복사한다.
// 결과: build/bridge/{putty,Xshell,SecureCRT}.exe → 설치 폴더의 bridge\ (electron-builder win.extraFiles)
// Go 가 필요하다(어느 OS 에서든 교차 빌드). dist:win 전에 실행된다.
import { execFileSync } from 'child_process'
import { copyFileSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'

const ROOT = process.cwd()
const OUT = join(ROOT, 'build', 'bridge')
const NAMES = ['putty.exe', 'Xshell.exe', 'SecureCRT.exe']

try {
  execFileSync('go', ['version'], { stdio: 'ignore' })
} catch {
  console.error('build-bridge: Go 가 없습니다 — https://go.dev/dl/ 에서 설치한 뒤 다시 실행하세요')
  process.exit(1)
}

rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })
const bin = join(OUT, 'BrightTermBridge.exe')
execFileSync('go', ['build', '-trimpath', '-ldflags', '-s -w -H windowsgui', '-o', bin, '.'], {
  cwd: join(ROOT, 'bridge'),
  stdio: 'inherit',
  env: { ...process.env, GOOS: 'windows', GOARCH: 'amd64', CGO_ENABLED: '0' }
})
for (const n of NAMES) copyFileSync(bin, join(OUT, n))
rmSync(bin)
console.log(`build-bridge: ${NAMES.join(', ')} → ${OUT}`)
