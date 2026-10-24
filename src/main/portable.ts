import { app } from 'electron'
import { cpSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'

/**
 * Windows 포터블 실행 파일: 설정·볼트·Chromium 프로필을 실행 파일 옆 BrightTerm-data\ 에 둔다 — USB 로 옮겨도 따라간다.
 * electron-builder 포터블 런처가 PORTABLE_EXECUTABLE_DIR 을 넘겨 준다. BRIGHTTERM_DATA 를 직접 주면(테스트) 그쪽이 우선.
 * 다른 모듈보다 먼저 불려야 한다 — index.ts 맨 첫 import.
 */
const exeDir = process.env.PORTABLE_EXECUTABLE_DIR
if (exeDir && !process.env.BRIGHTTERM_DATA) {
  const dir = join(exeDir, 'BrightTerm-data')
  const fresh = !existsSync(dir)
  if (writable(dir)) {
    // 처음 실행이면 지금까지 쓰던 %APPDATA%\BrightTerm\data 를 가져온다 (로그 제외)
    const old = join(app.getPath('userData'), 'data')
    if (fresh && existsSync(old)) {
      try {
        cpSync(old, dir, { recursive: true, filter: (src) => src !== join(old, 'logs') })
      } catch { /* 못 가져와도 빈 설정으로 시작 */ }
    }
    process.env.BRIGHTTERM_DATA = dir
  }
  // 쓸 수 없는 곳(읽기 전용 매체, Program Files 등)이면 설치형처럼 %APPDATA% 를 쓴다
}

function writable(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true })
    const probe = join(dir, '.write-test')
    writeFileSync(probe, '')
    unlinkSync(probe)
    return true
  } catch {
    return false
  }
}
