// SFTP 서브시스템이 없거나 막힌 서버용 — SSH exec 채널에서 POSIX 셸 명령(cat·ls·mv…)으로 파일을 다룬다.
// AIX·HP-UX 등도 되게 GNU 전용 옵션은 쓰지 않는다. 목록·속성은 perl 이 있으면 정확히, 없으면 ls -la 를 읽는다.
import { createReadStream, createWriteStream, promises as fs } from 'fs'
import { Transform } from 'stream'
import type { Client } from 'ssh2'

export interface RemoteStat {
  mode: number
  size: number
  /** 초 */
  mtime: number
  isDirectory(): boolean
}
export interface RemoteDirEntry { filename: string; attrs: RemoteStat }
export type Progress = (done: number, total: number) => void

/** 원격 파일 동작 — SFTP 와 셸 명령 두 가지로 구현한다 */
export interface RemoteFs {
  /** 'sftp' | 'shell' — 화면 안내용 */
  readonly kind: 'sftp' | 'shell'
  realpath(path: string): Promise<string>
  readdir(path: string): Promise<RemoteDirEntry[]>
  stat(path: string): Promise<RemoteStat>
  lstat(path: string): Promise<RemoteStat>
  mkdir(path: string): Promise<void>
  rmdir(path: string): Promise<void>
  unlink(path: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  chmod(path: string, mode: number): Promise<void>
  readFile(path: string): Promise<Buffer>
  writeFile(path: string, data: Buffer): Promise<void>
  get(remote: string, local: string, step?: Progress): Promise<void>
  put(local: string, remote: string, step?: Progress): Promise<void>
}

export const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`
/** '-' 로 시작하는 이름이 옵션으로 읽히지 않게 — AIX 등은 -- 를 모르는 명령이 있다 */
const arg = (p: string): string => q(p.startsWith('/') || p.startsWith('./') || p === '.' ? p : './' + p)

export const stat = (mode: number, size: number, mtime: number): RemoteStat =>
  ({ mode, size, mtime, isDirectory: () => (mode & 0o170000) === 0o040000 })

const TYPE: Record<string, number> = { d: 0o040000, l: 0o120000, '-': 0o100000, c: 0o020000, b: 0o060000, p: 0o010000, s: 0o140000 }
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** drwxr-sr-x → 모드 숫자 (s/t/S/T 포함) */
export function modeFromPerm(perm: string): number {
  let mode = TYPE[perm[0]] ?? 0o100000
  const bits = [0o400, 0o200, 0o100, 0o040, 0o020, 0o010, 0o004, 0o002, 0o001]
  for (let i = 0; i < 9; i++) {
    const c = perm[i + 1]
    if (c && c !== '-' && !(c === 'S' || c === 'T')) mode |= bits[i]
  }
  if (/[sS]/.test(perm[3] ?? '')) mode |= 0o4000
  if (/[sS]/.test(perm[6] ?? '')) mode |= 0o2000
  if (/[tT]/.test(perm[9] ?? '')) mode |= 0o1000
  return mode
}

/** LC_ALL=C ls -lan 한 줄 → 항목. 시각은 분 단위(올해 파일)거나 날짜만 */
export function parseLsLine(line: string, now = new Date()): RemoteDirEntry | null {
  const m = line.match(/^([-dlcbps][-rwxsStT]{9})[.+@]?\s+\d+\s+\S+\s+\S+\s+(\d+),?\s*(?:\d+\s+)?(\w{3})\s+(\d{1,2})\s+(\d{1,2}:\d{2}|\d{4})\s(.+)$/)
  if (!m) return null
  const [, perm, size, mon, day, timeOrYear, rest] = m
  const month = MONTHS.indexOf(mon)
  let date: Date
  if (timeOrYear.includes(':')) {
    const [h, mi] = timeOrYear.split(':').map(Number)
    date = new Date(now.getFullYear(), month, +day, h, mi)
    if (date.getTime() > now.getTime() + 86400000) date.setFullYear(now.getFullYear() - 1)
  } else date = new Date(+timeOrYear, month, +day)
  const mode = modeFromPerm(perm)
  const name = perm[0] === 'l' ? rest.replace(/ -> .*$/, '') : rest
  return { filename: name, attrs: stat(mode, +size, Math.floor(date.getTime() / 1000)) }
}

/** perl 출력: mode/size/mtime\tname\0 */
function parsePerl(out: Buffer): RemoteDirEntry[] {
  return out.toString('utf8').split('\0').filter(Boolean).map((rec) => {
    const tab = rec.indexOf('\t')
    const [mode, size, mtime] = rec.slice(0, tab).split('/').map(Number)
    return { filename: rec.slice(tab + 1), attrs: stat(mode, size, mtime) }
  })
}

const PERL_LIST = `perl -e 'opendir(D, ".") or exit 1; for $f (readdir D) { @s = lstat($f); print "$s[2]/$s[7]/$s[9]\\t$f\\0" }'`
const PERL_STAT = (fn: 'stat' | 'lstat'): string => `perl -e '@s = ${fn}($ARGV[0]) or exit 1; print "$s[2]/$s[7]/$s[9]\\tx\\0"'`

export class ShellFs implements RemoteFs {
  readonly kind = 'shell' as const
  private perl: Promise<boolean> | null = null
  private client: Client
  constructor(client: Client) { this.client = client }

  /** 명령 하나 — stdin 을 주면 보내고 닫는다. 종료 코드가 0 이 아니면 stderr 로 실패 */
  run(cmd: string, input?: Buffer | NodeJS.ReadableStream, onData?: (d: Buffer) => void): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      this.client.exec(cmd, (err, stream) => {
        if (err) return reject(err)
        const out: Buffer[] = []
        const errOut: Buffer[] = []
        let code: number | null = null
        stream.on('data', (d: Buffer) => (onData ? onData(d) : out.push(d)))
        stream.stderr.on('data', (d: Buffer) => errOut.push(d))
        stream.on('exit', (c: number | null) => { code = c })
        stream.on('close', () => {
          if (code === 0) resolve(Buffer.concat(out))
          else reject(new Error(Buffer.concat(errOut).toString('utf8').trim().split('\n').pop() || `명령 실패 (exit ${code})`))
        })
        if (Buffer.isBuffer(input)) stream.end(input)
        else if (input) (input as NodeJS.ReadableStream).pipe(stream)
        else stream.end()
      })
    })
  }

  private hasPerl(): Promise<boolean> {
    this.perl ??= this.run('command -v perl >/dev/null 2>&1').then(() => true, () => false)
    return this.perl
  }

  async realpath(path: string): Promise<string> {
    const p = arg(path)
    const out = await this.run(`if [ -d ${p} ]; then cd ${p} && pwd -P; else d=$(dirname ${p}) && b=$(basename ${p}) && cd "$d" && printf '%s/%s\\n' "$(pwd -P)" "$b"; fi`)
    return out.toString('utf8').trim().replace(/^\/\//, '/')
  }

  async readdir(path: string): Promise<RemoteDirEntry[]> {
    if (await this.hasPerl()) return parsePerl(await this.run(`cd ${arg(path)} && ${PERL_LIST}`))
    const out = await this.run(`cd ${arg(path)} && LC_ALL=C ls -lan`)
    return out.toString('utf8').split('\n').map((l) => parseLsLine(l)).filter((e): e is RemoteDirEntry => !!e)
  }

  private async statOf(path: string, fn: 'stat' | 'lstat'): Promise<RemoteStat> {
    if (await this.hasPerl()) {
      const [e] = parsePerl(await this.run(`${PERL_STAT(fn)} ${arg(path)}`))
      if (e) return e.attrs
      throw new Error('No such file')
    }
    const out = await this.run(`LC_ALL=C ls -ldn${fn === 'stat' ? 'L' : ''} ${arg(path)}`)
    const e = parseLsLine(out.toString('utf8').trim())
    if (!e) throw new Error('No such file')
    return e.attrs
  }

  stat(path: string): Promise<RemoteStat> { return this.statOf(path, 'stat') }
  lstat(path: string): Promise<RemoteStat> { return this.statOf(path, 'lstat') }
  async mkdir(path: string): Promise<void> { await this.run(`mkdir ${arg(path)}`) }
  async rmdir(path: string): Promise<void> { await this.run(`rmdir ${arg(path)}`) }
  async unlink(path: string): Promise<void> { await this.run(`rm -f ${arg(path)}`) }
  async rename(from: string, to: string): Promise<void> { await this.run(`mv ${arg(from)} ${arg(to)}`) }
  async chmod(path: string, mode: number): Promise<void> { await this.run(`chmod ${(mode & 0o7777).toString(8)} ${arg(path)}`) }
  readFile(path: string): Promise<Buffer> { return this.run(`cat ${arg(path)}`) }
  async writeFile(path: string, data: Buffer): Promise<void> { await this.run(`cat > ${arg(path)}`, data) }

  async get(remote: string, local: string, step?: Progress): Promise<void> {
    const total = (await this.stat(remote).catch(() => null))?.size ?? 0
    const file = createWriteStream(local)
    let done = 0
    try {
      await this.run(`cat ${arg(remote)}`, undefined, (d) => { file.write(d); done += d.length; step?.(done, total) })
    } finally {
      await new Promise((res) => file.end(res))
    }
    if (done < total) throw new Error(`받다가 끊겼습니다 (${done}/${total} 바이트)`)
  }

  async put(local: string, remote: string, step?: Progress): Promise<void> {
    const total = (await fs.stat(local)).size
    let done = 0
    // 채널이 열리기 전에 흘려 버리지 않게 — 진행률은 파이프 중간에서 센다
    const counted = createReadStream(local).pipe(new Transform({
      transform(chunk: Buffer, _enc, cb) { done += chunk.length; step?.(done, total); cb(null, chunk) }
    }))
    await this.run(`cat > ${arg(remote)}`, counted)
  }
}
