import { createReadStream, createWriteStream, existsSync, mkdirSync, promises as fs, type WriteStream } from 'fs'
import { createGzip } from 'zlib'
import { pipeline } from 'stream/promises'
import { homedir } from 'os'
import { basename, dirname, isAbsolute, join, resolve } from 'path'
import type { SessionLogOptions } from '@shared/types'
import { filesToPrune, formatLogChunk, formatLogTime, logFileName, logFilePattern, shouldRotate } from '@shared/sessionLog'

/** 다른 OS 에서 동기화된 절대 경로 — 윈도우의 D:\ 나 \\서버 는 macOS·Linux 에서 상대 경로로 읽혀 엉뚱한 폴더가 된다 */
export const isForeignPath = (dir: string, platform = process.platform): boolean =>
  platform !== 'win32' && /^(?:[A-Za-z]:[\\/]|\\\\)/.test(dir.trim())

/** 설정한 폴더 — 비우면 기본 폴더(base), ~ 는 홈, 상대 경로는 기본 폴더 아래 */
export function resolveLogDir(dir: string, base: string): string {
  const d = dir.trim()
  if (!d) return resolve(base)
  const expanded = d === '~' ? homedir() : /^~[\\/]/.test(d) ? join(homedir(), d.slice(2)) : d
  return isAbsolute(expanded) ? resolve(expanded) : resolve(base, expanded)
}

/** 지금 쓰고 있는 파일과 압축 중인 원본 — 같은 서버를 여러 창으로 열어도 서로의 파일을 지우지 않는다 */
const active = new Set<string>()
const compressing = new Set<string>()

async function compressFile(file: string): Promise<void> {
  if (compressing.has(file)) return
  compressing.add(file)
  const tmp = file + '.gz.tmp'
  try {
    await pipeline(createReadStream(file), createGzip(), createWriteStream(tmp))
    await fs.rename(tmp, file + '.gz')
    await fs.unlink(file)
  } catch {
    await fs.rm(tmp, { force: true }).catch(() => {})
  } finally {
    compressing.delete(file)
  }
}

/** 이 서버의 로그 폴더를 보관 규칙대로 정리하고, 압축을 켰으면 끝난(쓰지 않는) 원본을 압축한다 */
async function prune(dir: string, stem: string, options: SessionLogOptions): Promise<void> {
  const re = logFilePattern(stem)
  let names: string[]
  try { names = (await fs.readdir(dir)).filter((n) => re.test(n)) } catch { return }
  const keep = new Set<string>()
  for (const f of [...active, ...compressing]) {
    if (dirname(f) !== dir) continue
    keep.add(basename(f))
    keep.add(basename(f) + '.gz.tmp')
  }
  const entries = (await Promise.all(names.map(async (name) => {
    try { return { name, mtimeMs: (await fs.stat(join(dir, name))).mtimeMs } } catch { return null }
  }))).filter((e): e is { name: string; mtimeMs: number } => !!e)
  const removed = new Set(filesToPrune(entries, options, Date.now(), keep))
  await Promise.all([...removed].map((n) => fs.unlink(join(dir, n)).catch(() => {})))
  for (const { name } of entries) {
    if (removed.has(name) || keep.has(name)) continue
    // 압축하다 앱이 꺼져 남은 임시 파일
    if (name.endsWith('.gz.tmp')) await fs.unlink(join(dir, name)).catch(() => {})
    else if (options.compress && name.endsWith('.log') && !names.includes(name + '.gz')) await compressFile(join(dir, name))
  }
}

export interface SessionLogTarget {
  /** 파일 이름 앞부분 (logStem) */
  stem: string
  /** 파일 첫 줄에 남길 서버 표시 */
  title: string
  options: SessionLogOptions
  /** 기본 로그 폴더 (데이터 폴더/logs) */
  baseDir: string
  /** 쓰기 실패·폴더 대체 같은 안내 */
  onNotice: (message: string) => void
}

/** 한 연결의 출력 기록 — 크기·날짜에 따라 새 파일로 넘기고, 넘길 때마다 오래된 파일을 정리한다 */
export class SessionLogWriter {
  private stream: WriteStream | null = null
  private file = ''
  private bytes = 0
  private openedAt = new Date()
  private lineStart = true
  private part = 0

  private readonly dir: string
  private readonly t: SessionLogTarget

  private constructor(dir: string, t: SessionLogTarget) {
    this.dir = dir
    this.t = t
  }

  /** 열지 못하면 null — 서버별 폴더를 만들 수 없으면(다른 OS 경로가 동기화된 경우 등) 기본 폴더에 쓴다 */
  static open(t: SessionLogTarget): SessionLogWriter | null {
    const base = resolve(t.baseDir)
    const foreign = isForeignPath(t.options.dir)
    const wanted = foreign ? t.options.dir.trim() : resolveLogDir(t.options.dir, base)
    for (const dir of wanted === base ? [wanted] : foreign ? [base] : [wanted, base]) {
      try {
        mkdirSync(dir, { recursive: true })
        const w = new SessionLogWriter(dir, t)
        w.openNext(new Date())
        if (dir !== wanted) t.onNotice(`로그 폴더(${wanted})를 쓸 수 없어 기본 폴더에 저장합니다`)
        return w
      } catch (e) {
        if (dir === base) t.onNotice(`세션 로그를 열지 못했습니다: ${(e as Error).message}`)
      }
    }
    return null
  }

  get path(): string {
    return this.file
  }

  private openNext(now: Date): void {
    let seq = 0
    let name = logFileName(this.t.stem, now)
    // 파일은 스트림이 비동기로 만든다 — 같은 초에 연 다른 창·직전 회전 파일은 active 로 피한다
    const taken = (n: string): boolean => active.has(join(this.dir, n)) || compressing.has(join(this.dir, n)) || existsSync(join(this.dir, n)) || existsSync(join(this.dir, n + '.gz'))
    while (taken(name)) name = logFileName(this.t.stem, now, ++seq)
    const file = join(this.dir, name)
    const stream = createWriteStream(file, { flags: 'wx' })
    stream.on('error', (e) => this.fail(stream, file, e))
    this.stream = stream
    this.file = file
    active.add(file)
    this.bytes = 0
    this.openedAt = now
    this.lineStart = true
    this.part++
    this.put(`=== BrightTerm 세션 로그 · ${this.t.title} · ${formatLogTime(now)}${this.part > 1 ? ` · ${this.part}번째 파일` : ''} ===\n`)
    void prune(this.dir, this.t.stem, this.t.options)
  }

  private put(text: string): void {
    const buf = Buffer.from(text, 'utf8')
    this.bytes += buf.length
    this.stream?.write(buf)
  }

  /** 터미널에 보낸 출력 조각 */
  write(s: string): void {
    if (!this.stream || !s) return
    const now = new Date()
    let out = formatLogChunk(s, this.t.options, this.lineStart, now)
    if (!out.text) return
    if (shouldRotate(this.t.options, { bytes: this.bytes, openedAt: this.openedAt }, Buffer.byteLength(out.text), now)) {
      this.finish()
      try {
        this.openNext(now)
      } catch (e) {
        this.t.onNotice(`새 로그 파일을 열지 못해 기록을 멈춥니다: ${(e as Error).message}`)
        return
      }
      out = formatLogChunk(s, this.t.options, true, now)
    }
    this.lineStart = out.lineStart
    this.put(out.text)
  }

  private fail(stream: WriteStream, file: string, e: Error): void {
    active.delete(file)
    if (this.stream !== stream) return
    this.stream = null
    stream.destroy()
    this.t.onNotice(`세션 로그를 쓰지 못해 기록을 멈춥니다: ${e.message}`)
  }

  /** 지금 파일을 닫는다 — 압축을 켰으면 다 쓴 뒤 압축 */
  private finish(): void {
    const stream = this.stream
    const file = this.file
    this.stream = null
    if (!stream) return
    stream.end(() => {
      active.delete(file)
      // 닫은 파일도 개수에 들어가므로 압축 뒤 한 번 더 정리한다
      void (this.t.options.compress ? compressFile(file) : Promise.resolve()).then(() => prune(this.dir, this.t.stem, this.t.options))
    })
  }

  close(): void {
    this.finish()
  }
}
