import type { SessionLogOptions } from './types'

/** 세션 로그 기본 규칙 — 앱 설정의 기본값이자 서버별 고급 설정의 출발점 */
export const DEFAULT_SESSION_LOG_OPTIONS: SessionLogOptions = {
  dir: '',
  format: 'text',
  timestamp: false,
  maxSizeMB: 10,
  rotateDaily: true,
  maxFiles: 50,
  retentionDays: 30,
  compress: false
}

/** 백업·동기화로 들어온 값에도 범위를 보장한다. 0 은 해당 제한을 쓰지 않는다는 뜻이다. */
export function normalizeSessionLogOptions(input?: Partial<SessionLogOptions> | null): SessionLogOptions {
  const d = DEFAULT_SESSION_LOG_OPTIONS
  const int = (value: unknown, fallback: number, max: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(0, Math.round(value))) : fallback
  const bool = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback)
  return {
    dir: typeof input?.dir === 'string' ? input.dir.trim() : d.dir,
    format: input?.format === 'raw' ? 'raw' : 'text',
    timestamp: bool(input?.timestamp, d.timestamp),
    maxSizeMB: int(input?.maxSizeMB, d.maxSizeMB, 10240),
    rotateDaily: bool(input?.rotateDaily, d.rotateDaily),
    maxFiles: int(input?.maxFiles, d.maxFiles, 100000),
    retentionDays: int(input?.retentionDays, d.retentionDays, 36500),
    compress: bool(input?.compress, d.compress)
  }
}

/** 서버 설정이 있으면 그것, 없으면 앱 설정 (재접속 규칙과 같은 방식) */
export function resolveSessionLog(
  app: { sessionLog: boolean; sessionLogOptions?: Partial<SessionLogOptions> },
  host?: { sessionLog?: boolean; sessionLogOptions?: Partial<SessionLogOptions> }
): { enabled: boolean; options: SessionLogOptions } {
  return {
    enabled: host?.sessionLog ?? app.sessionLog,
    options: normalizeSessionLogOptions(host?.sessionLogOptions ?? app.sessionLogOptions)
  }
}

/** 파일 이름에 쓸 수 없는 문자와 끝의 점·공백을 바꾼다 — 비면 session */
export function logStem(alias: string): string {
  const s = alias.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/[. ]+$/, '').trim()
  return s || 'session'
}

const pad = (n: number, w = 2): string => String(n).padStart(w, '0')

/** 별칭_YYYYMMDD-HHmmss.log — 같은 초에 이미 있으면 .1, .2 … 를 붙인다 */
export function logFileName(stem: string, d: Date, seq = 0): string {
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  return `${stem}_${stamp}${seq ? `.${seq}` : ''}.log`
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** 이 서버의 로그 파일인지 — 새 형식(별칭_날짜-시각[.n].log[.gz]), 이전 형식(별칭-날짜-시분.log), 압축 중 남은 .gz.tmp */
export function logFilePattern(stem: string): RegExp {
  const s = escapeRe(stem)
  return new RegExp(`^(?:${s}_\\d{8}-\\d{6}(?:\\.\\d+)?\\.log(?:\\.gz(?:\\.tmp)?)?|${s}-\\d{8}-\\d{4}\\.log)$`)
}

export interface LogFileEntry { name: string; mtimeMs: number }

/** 수정 시각이 같을 때 만든 순서 — 날짜-시각 다음 일련번호(.1, .2 …, 없으면 0) */
function orderKey(name: string): string {
  const m = /(\d{8}-\d{4,6})(?:\.(\d+))?\.log/.exec(name)
  return m ? `${m[1].padEnd(15, '0')}.${(m[2] ?? '0').padStart(6, '0')}` : name
}

/**
 * 보관 규칙에 따라 지울 파일 — 기간을 넘긴 파일, 그리고 최근 maxFiles 개를 넘는 오래된 파일.
 * 지금 쓰고 있는 파일(keep)은 지우지 않고 개수에는 센다. 압축 중인 .gz.tmp 는 keep 에 넣는다.
 */
export function filesToPrune(files: LogFileEntry[], options: Pick<SessionLogOptions, 'maxFiles' | 'retentionDays'>, now: number, keep: Set<string> = new Set()): string[] {
  // 원본·압축본·압축 중 임시 파일은 한 로그로 묶어 센다
  const groups = new Map<string, { names: string[]; mtimeMs: number; kept: boolean }>()
  for (const f of files) {
    const base = f.name.replace(/\.gz(?:\.tmp)?$/, '')
    const g = groups.get(base) ?? { names: [], mtimeMs: 0, kept: false }
    g.names.push(f.name)
    g.mtimeMs = Math.max(g.mtimeMs, f.mtimeMs)
    g.kept ||= keep.has(f.name)
    groups.set(base, g)
  }
  const sorted = [...groups.entries()].sort(([an, a], [bn, b]) => b.mtimeMs - a.mtimeMs || orderKey(bn).localeCompare(orderKey(an)))
  const limit = options.retentionDays > 0 ? now - options.retentionDays * 86400000 : -Infinity
  const remove: string[] = []
  sorted.forEach(([, g], i) => {
    if (g.kept) return
    if (g.mtimeMs < limit || (options.maxFiles > 0 && i >= options.maxFiles)) remove.push(...g.names)
  })
  return remove
}

/** 이 시각이면 새 파일로 넘어가야 하는지 — 크기 또는 날짜 */
export function shouldRotate(options: Pick<SessionLogOptions, 'maxSizeMB' | 'rotateDaily'>, state: { bytes: number; openedAt: Date }, incoming: number, now: Date): boolean {
  if (state.bytes === 0) return false
  if (options.maxSizeMB > 0 && state.bytes + incoming > options.maxSizeMB * 1024 * 1024) return true
  if (options.rotateDaily && (now.getFullYear() !== state.openedAt.getFullYear() || now.getMonth() !== state.openedAt.getMonth() || now.getDate() !== state.openedAt.getDate())) return true
  return false
}

export function formatLogTime(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[=>78DEHMc]/g

/**
 * 터미널 출력 조각을 로그에 쓸 텍스트로 — text: 제어 문자를 빼고 줄 앞에 시각(선택), raw: 받은 그대로.
 * 조각이 줄 중간에서 끊기므로 lineStart 를 다음 조각으로 넘긴다.
 */
export function formatLogChunk(s: string, options: Pick<SessionLogOptions, 'format' | 'timestamp'>, lineStart: boolean, now: Date): { text: string; lineStart: boolean } {
  if (options.format === 'raw') return { text: s, lineStart }
  const plain = s.replace(ANSI, '').replace(/\r/g, '')
  if (!options.timestamp || !plain) return { text: plain, lineStart: plain ? plain.endsWith('\n') : lineStart }
  const stamp = `[${formatLogTime(now)}] `
  let out = ''
  let start = lineStart
  for (const part of plain.split(/(?<=\n)/)) {
    if (start) out += stamp
    out += part
    start = part.endsWith('\n')
  }
  return { text: out, lineStart: start }
}
