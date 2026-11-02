import type { Protocol } from '@shared/types'

/**
 * 다른 터미널 프로그램 형식의 실행 인자 — 서버 접근제어(보안) 프로그램이 PuTTY·Xshell·SecureCRT 를 띄우듯 BrightTerm 을 띄운다.
 * 브릿지 실행 파일(bridge/)은 --bt-launch=<형식> --bt-pipe=<파이프> 를 앞에 붙여 원래 인자를 그대로 넘긴다.
 * Electron 없이 도는 순수 함수만 둔다 — 테스트에서 바로 불러 쓴다.
 */
export type LaunchStyle = 'putty' | 'xshell' | 'securecrt'

export interface LaunchArgs {
  style: LaunchStyle
  protocol?: Protocol
  host?: string
  port?: number
  username?: string
  password?: string
  passwordFile?: string
  keyFile?: string
  /** PuTTY -load · SecureCRT /S · Xshell 세션 이름 */
  session?: string
  /** SecureCRT /F 설정 폴더 */
  configDir?: string
  /** Xshell 세션 파일(.xsh) */
  sessionFile?: string
  /** 탭 이름 — Xshell -newtab */
  title?: string
  /** 브릿지의 named pipe — 세션을 닫으면 끊고, 브릿지가 끝나면 세션을 닫는다 */
  pipe?: string
  /** 지원하지 않는 방식(raw, serial, rlogin 등) */
  unsupported?: string
}

/** 접속 대상 일부 — 세션 파일·URL 에서 읽은 값 */
export type LaunchTarget = Pick<LaunchArgs, 'protocol' | 'host' | 'port' | 'username' | 'password'>

const PUTTY_VALUE = new Set(['-l', '-pw', '-pwfile', '-P', '-i', '-load', '-L', '-R', '-D', '-m', '-hostkey', '-sercfg', '-sshlog', '-sshrawlog', '-proxycmd', '-nc', '-loghost', '-sessionlog', '-cert', '-title'])
const CRT_VALUE = new Set(['L', 'PASSWORD', 'P', 'I', 'S', 'F', 'AUTH', 'C', 'M', 'ARG', 'SCRIPT', 'LOG'])
const CRT_FLAGS = new Set([...CRT_VALUE, 'SSH1', 'SSH2', 'TELNET', 'RLOGIN', 'SERIAL', 'RAW', 'TAPI', 'T', 'POS', 'ACCEPTHOSTKEYS', 'NOMENU', 'NOTOOLBAR'])
const XSHELL_VALUE = new Set(['-url', '-newtab', '-tabname', '-folder'])

export function parseLaunchArgs(argv: string[]): LaunchArgs | null {
  let style: LaunchStyle | undefined
  let pipe: string | undefined
  const args: string[] = []
  for (const a of argv) {
    const m = a.match(/^--bt-(launch|pipe)=(.*)$/)
    if (m) {
      if (m[1] === 'pipe') pipe = m[2]
      else if (m[2] === 'putty' || m[2] === 'xshell' || m[2] === 'securecrt') style = m[2]
    } else if (!a.startsWith('--') && !a.startsWith('-psn_') && a !== '.') args.push(a)
  }
  if (!args.length) return pipe ? { style: style ?? 'putty', pipe } : null
  style ??= detectStyle(args)
  const r = style === 'securecrt' ? parseSecureCrt(args) : style === 'xshell' ? parseXshell(args) : parsePutty(args)
  if (pipe) r.pipe = pipe
  return r.host || r.session || r.sessionFile || r.unsupported || r.pipe ? r : null
}

function detectStyle(args: string[]): LaunchStyle {
  if (args.some((a) => /^\/[A-Za-z]/.test(a) && CRT_FLAGS.has(a.slice(1).toUpperCase()))) return 'securecrt'
  if (args.some((a) => a === '-url' || a === '-newtab' || /\.xsh$/i.test(a))) return 'xshell'
  return 'putty'
}

function parsePutty(args: string[]): LaunchArgs {
  const r: LaunchArgs = { style: 'putty' }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    const v = (): string => args[++i] ?? ''
    if (a === '-ssh' || a === '-ssh-connection') r.protocol = 'ssh'
    else if (a === '-telnet') r.protocol = 'telnet'
    else if (a === '-raw' || a === '-rlogin' || a === '-serial' || a === '-supdup') r.unsupported = a.slice(1)
    else if (a === '-l') r.username = v()
    else if (a === '-pw') r.password = v()
    else if (a === '-pwfile') r.passwordFile = v()
    else if (a === '-P') r.port = toPort(v())
    else if (a === '-i') r.keyFile = v()
    else if (a === '-load') r.session = v()
    else if (PUTTY_VALUE.has(a)) v()
    else if (!a.startsWith('-')) applyTarget(r, a)
  }
  return r
}

function parseXshell(args: string[]): LaunchArgs {
  const r: LaunchArgs = { style: 'xshell' }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    const v = (): string => args[++i] ?? ''
    if (a === '-url') applyTarget(r, v())
    else if (a === '-newtab' || a === '-tabname') r.title = v() || undefined
    else if (XSHELL_VALUE.has(a)) v()
    else if (a.startsWith('-')) continue
    else if (/\.xsh$/i.test(a) || /[\\/]/.test(a)) r.sessionFile = a
    else if (/^[a-z0-9+.-]+:\/\//i.test(a)) applyTarget(r, a)
    else r.session = a
  }
  return r
}

function parseSecureCrt(args: string[]): LaunchArgs {
  const r: LaunchArgs = { style: 'securecrt' }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    const v = (): string => args[++i] ?? ''
    if (!/^\/[A-Za-z]/.test(a)) {
      // /TELNET host port — 주소 뒤의 숫자는 포트
      if (r.host && /^\d+$/.test(a)) r.port ??= toPort(a)
      else applyTarget(r, a)
      continue
    }
    const f = a.slice(1).toUpperCase()
    if (f === 'SSH2' || f === 'SSH1') r.protocol = 'ssh'
    else if (f === 'TELNET') r.protocol = 'telnet'
    else if (f === 'RLOGIN' || f === 'SERIAL' || f === 'RAW' || f === 'TAPI') r.unsupported = f.toLowerCase()
    else if (f === 'L') r.username = v()
    else if (f === 'PASSWORD') r.password = v()
    else if (f === 'P') r.port = toPort(v())
    else if (f === 'I') r.keyFile = v()
    else if (f === 'S') r.session = v()
    else if (f === 'F') r.configDir = v()
    else if (f === 'POS') i += 2
    else if (CRT_VALUE.has(f)) v()
  }
  return r
}

/** [user@]host[:port] 또는 ssh://user:pw@host:port — 앞에서 이미 정한 값(-l, -P 등)은 덮지 않는다 */
function applyTarget(r: LaunchArgs, s: string): void {
  const t = parseTarget(s)
  if (!t.host) return
  r.host = t.host
  for (const k of ['protocol', 'port', 'username', 'password'] as const) {
    if (r[k] === undefined && t[k] !== undefined) Object.assign(r, { [k]: t[k] })
  }
}

export function parseTarget(s: string): LaunchTarget {
  const url = s.match(/^([a-z0-9+.-]+):\/\/(.*)$/i)
  if (url) {
    const scheme = url[1].toLowerCase()
    const protocol: Protocol | undefined = scheme === 'telnet' ? 'telnet' : /^(ssh|ssh2|sftp)$/.test(scheme) ? 'ssh' : undefined
    if (!protocol) return {}
    try {
      const u = new URL(`ssh://${url[2]}`)
      return {
        protocol,
        host: u.hostname.replace(/^\[(.*)\]$/, '$1') || undefined,
        port: toPort(u.port),
        username: u.username ? decodeURIComponent(u.username) : undefined,
        password: u.password ? decodeURIComponent(u.password) : undefined
      }
    } catch {
      return {}
    }
  }
  const at = s.lastIndexOf('@')
  const username = at > 0 ? s.slice(0, at) : undefined
  let host = at >= 0 ? s.slice(at + 1) : s
  let port: number | undefined
  const hp = host.match(/^\[(.+)\](?::(\d+))?$/) || host.match(/^([^:]+):(\d+)$/)
  if (hp) {
    host = hp[1]
    port = toPort(hp[2])
  }
  return { host: host || undefined, port, username }
}

function toPort(s: string | undefined): number | undefined {
  const n = Number(s)
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : undefined
}

/** Xshell .xsh (INI) — [CONNECTION] Host·Port·Protocol, [CONNECTION:AUTHENTICATION] UserName. 비밀번호는 암호화돼 있어 쓰지 않는다 */
export function parseXsh(text: string): LaunchTarget {
  const ini = parseIni(text)
  const c = ini.get('CONNECTION') ?? {}
  const auth = ini.get('CONNECTION:AUTHENTICATION') ?? {}
  const proto = (c.Protocol ?? 'SSH').toUpperCase()
  return {
    protocol: proto === 'TELNET' ? 'telnet' : proto === 'SSH' ? 'ssh' : undefined,
    host: c.Host || undefined,
    port: toPort(c.Port),
    username: auth.UserName || undefined
  }
}

/** SecureCRT 세션 .ini — S:"Hostname"=…, D:"[SSH2] Port"=00000016(16진수) */
export function parseCrtSession(text: string): LaunchTarget {
  const v: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([SD]):"(.+?)"=(.*)$/)
    if (m) v[m[2]] = m[1] === 'D' ? String(parseInt(m[3], 16)) : m[3]
  }
  const proto = (v['Protocol Name'] ?? 'SSH2').toUpperCase()
  const protocol: Protocol | undefined = proto.startsWith('SSH') ? 'ssh' : proto === 'TELNET' ? 'telnet' : undefined
  return {
    protocol,
    host: v.Hostname || undefined,
    port: toPort(protocol === 'telnet' ? v.Port : v['[SSH2] Port'] ?? v.Port),
    username: v.Username || undefined
  }
}

function parseIni(text: string): Map<string, Record<string, string>> {
  const map = new Map<string, Record<string, string>>()
  let cur: Record<string, string> = {}
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim()
    const sec = line.match(/^\[(.+)\]$/)
    if (sec) {
      cur = {}
      map.set(sec[1], cur)
      continue
    }
    const kv = line.match(/^([^=;#]+?)\s*=\s*(.*)$/)
    if (kv) cur[kv[1]] = kv[2]
  }
  return map
}

/** 세션 파일 바이트 — Xshell 6 이후는 UTF-16LE(BOM) 로 저장한다 */
export function decodeSessionFile(buf: Uint8Array): string {
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2))
  return new TextDecoder('utf-8').decode(buf)
}
