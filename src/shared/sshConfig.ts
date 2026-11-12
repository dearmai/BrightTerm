// 서버 목록 → OpenSSH 설정(~/.ssh/brightterm.conf). ~/.ssh/config 에는 맨 앞에 Include 한 줄만 넣는다.
// - 서버마다 sshConfig 를 켠 SSH 서버만 넣는다 (기본 끔)
// - 별칭·그룹·태그·환경·메모 등 OpenSSH 옵션이 없는 정보는 주석으로 남긴다
// - 비밀번호·개인 키는 볼트에만 있다. 파일에 쓰지 않는다
import type { Group, Host } from './types'

export const SSH_CONFIG_FILE = 'brightterm.conf'
/** ~/.ssh/config 에 넣는 표시 줄 — 이 줄과 바로 다음 Include 줄만 앱이 관리한다 */
export const INCLUDE_MARKER = '# BrightTerm: 아래 Include 는 BrightTerm 이 관리합니다 (서버 편집 → 고급 → .ssh/config 동기화)'
export const INCLUDE_LINE = `Include ${SSH_CONFIG_FILE}`

/** Host 이름으로 쓸 수 없는 글자: 공백·와일드카드·부정·쉼표·따옴표·주석 */
const BAD_NAME = /[\s\x00-\x1f\x7f*?!,"'#=]/
const BAD_RUN = /[\s\x00-\x1f\x7f*?!,"'#=]+/g

export function validSshName(name: string): boolean {
  return !!name && name.length <= 100 && !BAD_NAME.test(name)
}

/**
 * 별칭에서 만든 기본 Host 이름 — 쓸 수 있는 글자로만 되어 있으면 별칭 그대로 쓴다.
 * 쓸 수 없는 글자(공백·* ? ! , " ' # = 등)만 - 로 바꾸고, ssh 옵션으로 읽히지 않게 앞의 - 는 뺀다
 */
export function defaultSshName(h: Pick<Host, 'id' | 'alias' | 'host'>): string {
  const clean = (s: string): string => s.trim().replace(BAD_RUN, '-').replace(/^-+|-+$/g, '').slice(0, 100)
  return clean(h.alias) || clean(h.host) || `bt-${h.id.slice(0, 8)}`
}

export const isSshConfigTarget = (h: Host): boolean => h.protocol === 'ssh' && !!h.sshConfig && !!h.host.trim()

/** 동기화 대상 서버의 Host 이름 — 직접 정한 이름이 우선, 겹치면 -2, -3 … */
export function sshNames(hosts: Host[]): Map<string, string> {
  const names = new Map<string, string>()
  const taken = new Set<string>()
  const targets = hosts.filter(isSshConfigTarget)
  // 직접 정한 이름을 먼저 차지한다
  const ordered = [...targets.filter((h) => validSshName(h.sshConfigName?.trim() ?? '')), ...targets.filter((h) => !validSshName(h.sshConfigName?.trim() ?? ''))]
  for (const h of ordered) {
    const base = validSshName(h.sshConfigName?.trim() ?? '') ? h.sshConfigName!.trim() : defaultSshName(h)
    let name = base
    for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${base}-${i}`
    taken.add(name.toLowerCase())
    names.set(h.id, name)
  }
  return names
}

/** 주석 한 줄 — 줄바꿈·제어 문자는 공백으로 */
const oneLine = (s: string): string => s.replace(/[\x00-\x1f\x7f]+/g, ' ').trim()
/** 공백이나 # 이 있으면 따옴표로 */
const val = (s: string): string => (/[\s#"]/.test(s) ? `"${s.replace(/"/g, '')}"` : s)
const hostPort = (host: string, port: number): string => (host.includes(':') ? `[${host}]` : host) + (port && port !== 22 ? `:${port}` : '')

function groupPath(groups: Group[], id: string | null): string {
  const names: string[] = []
  const seen = new Set<string>()
  for (let g = groups.find((x) => x.id === id); g && !seen.has(g.id); g = groups.find((x) => x.id === g!.parentId)) {
    seen.add(g.id)
    names.unshift(g.name)
  }
  return names.join(' / ')
}

const AUTH: Record<Host['authType'], string> = {
  password: '비밀번호 (BrightTerm 볼트에 저장 — 이 파일에는 쓰지 않음)',
  key: '개인 키 (BrightTerm 볼트에 저장 — ssh 로 접속하려면 ssh-agent 나 IdentityFile 을 따로 지정)',
  agent: 'SSH 에이전트',
  ask: '접속할 때마다 입력'
}

export interface SshConfigResult {
  text: string
  count: number
  names: Map<string, string>
}

const HEADER = [
  '# BrightTerm 이 자동으로 만드는 파일입니다. 직접 고치면 다음 동기화 때 덮어씁니다.',
  '# 서버 편집 → 고급 → ".ssh/config 동기화" 를 켠 SSH 서버만 들어갑니다. 비밀번호·개인 키는 기록하지 않습니다.',
  `# ~/.ssh/config 맨 앞의 "${INCLUDE_LINE}" 로 읽힙니다.`,
  ''
]
const ID_NOTE = '  # BrightTerm id: '

/** ~/.ssh/brightterm.conf 내용. 동기화 대상이 없으면 count 0 */
export function buildSshConfig(hosts: Host[], groups: Group[]): SshConfigResult {
  const names = sshNames(hosts)
  const targets = hosts.filter((h) => names.has(h.id)).sort((a, b) => names.get(a.id)!.localeCompare(names.get(b.id)!))
  const out = [...HEADER]
  for (const h of targets) out.push(...hostBlock(h, hosts, groups, names))
  return { text: out.join('\n'), count: targets.length, names }
}

/** 서버 하나의 Host 블록(끝의 빈 줄 포함). 대상이 아니면 null */
export function sshHostBlock(id: string, hosts: Host[], groups: Group[]): { name: string; text: string } | null {
  const names = sshNames(hosts)
  const h = hosts.find((x) => x.id === id)
  if (!h || !names.has(id)) return null
  return { name: names.get(id)!, text: hostBlock(h, hosts, groups, names).join('\n') }
}

/** 기존 brightterm.conf 의 Host 블록 — 앱이 쓴 블록은 BrightTerm id 주석으로 서버를 안다 */
function splitBlocks(text: string): { id: string | null; name: string; text: string }[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const blocks: { id: string | null; name: string; lines: string[] }[] = []
  for (const line of lines) {
    if (/^Host\s/.test(line)) blocks.push({ id: null, name: line.slice(5).trim(), lines: [line] })
    else if (blocks.length) {
      const b = blocks[blocks.length - 1]
      if (line.startsWith(ID_NOTE)) b.id = line.slice(ID_NOTE.length).trim()
      b.lines.push(line)
    }
  }
  return blocks.map((b) => {
    while (b.lines.length && b.lines[b.lines.length - 1] === '') b.lines.pop()
    return { id: b.id, name: b.name, text: [...b.lines, ''].join('\n') }
  })
}

/**
 * 수동 반영 — 기존 파일에서 이 서버 블록만 바꾼다(없으면 끝에 추가, block 이 null 이면 뺀다).
 * 다른 서버 블록은 그대로 둔다. 같은 Host 이름을 쓰던 다른 블록이 있으면 함께 뺀다(ssh 는 앞의 것만 쓴다)
 */
export function mergeSshHost(existing: string, id: string, block: { name: string; text: string } | null): { text: string; count: number } {
  const blocks = splitBlocks(existing).filter((b) => b.id !== id && !(block && b.name.toLowerCase() === block.name.toLowerCase()))
  const old = splitBlocks(existing).findIndex((b) => b.id === id)
  if (block) blocks.splice(old < 0 ? blocks.length : Math.min(old, blocks.length), 0, { id, name: block.name, text: block.text })
  return { text: [...HEADER, ...blocks.map((b) => b.text)].join('\n'), count: blocks.length }
}

function hostBlock(h: Host, hosts: Host[], groups: Group[], names: Map<string, string>): string[] {
  const byId = new Map(hosts.map((x) => [x.id, x]))
  const out: string[] = []
  {
    const name = names.get(h.id)!
    const note = (k: string, v: string | undefined): void => { if (v && oneLine(v)) out.push(`  # ${k}: ${oneLine(v)}`) }
    out.push(`Host ${name}`)
    note('BrightTerm 별칭', h.alias)
    note('그룹', groupPath(groups, h.groupId))
    note('태그', h.tags.join(', '))
    note('환경', h.env)
    note('인증', AUTH[h.authType])
    if (h.encoding && h.encoding !== 'utf-8') note('문자 인코딩', `${h.encoding} (ssh 에는 해당 옵션 없음 — 터미널에서 맞추세요)`)
    if (h.proxy?.host) note('프록시', `${h.proxy.type} ${hostPort(h.proxy.host, h.proxy.port)} (ssh 설정에는 반영하지 않음)`)
    if (h.startupCommand?.trim()) note('접속 후 실행 명령', `${h.startupCommand.split(/\r?\n/).filter((l) => l.trim()).length}줄 (반영하지 않음)`)
    for (const line of (h.notes ?? '').split(/\r?\n/).filter((l) => oneLine(l))) note('메모', line)
    note('BrightTerm id', h.id)
    out.push(`  HostName ${val(h.host.trim())}`, `  Port ${h.port || 22}`)
    if (h.username.trim()) out.push(`  User ${val(h.username.trim())}`)
    const jumpHost = h.jumpHostId ? byId.get(h.jumpHostId) : undefined
    if (jumpHost) {
      const jn = names.get(jumpHost.id)
      if (jn) out.push(`  ProxyJump ${jn}`)
      else {
        out.push(`  ProxyJump ${jumpHost.username ? jumpHost.username + '@' : ''}${hostPort(jumpHost.host, jumpHost.port)}`)
        if (jumpHost.jumpHostId || jumpHost.jump?.host) note('점프 호스트', `${jumpHost.alias} 의 상위 점프 호스트는 반영되지 않음 — 그 서버도 동기화를 켜면 함께 반영됩니다`)
      }
    } else if (h.jump?.host) {
      out.push(`  ProxyJump ${h.jump.username ? h.jump.username + '@' : ''}${hostPort(h.jump.host, h.jump.port)}`)
    }
    if (h.keepaliveSec > 0) out.push(`  ServerAliveInterval ${h.keepaliveSec}`)
    for (const f of h.forwards ?? []) {
      const bind = f.bindHost ? `${f.bindHost.includes(':') ? `[${f.bindHost}]` : f.bindHost}:${f.bindPort}` : `${f.bindPort}`
      const dest = `${f.destHost.includes(':') ? `[${f.destHost}]` : f.destHost}:${f.destPort}`
      out.push(`  ${f.type === 'R' ? 'RemoteForward' : 'LocalForward'} ${bind} ${dest}`)
    }
    out.push('')
  }
  return out
}

/** ~/.ssh/config 맨 앞에 관리용 Include 를 넣는다 (이미 있으면 그대로). 줄바꿈은 기존 파일을 따른다 */
export function withInclude(config: string): string {
  if (hasInclude(config)) return config
  const eol = config.includes('\r\n') ? '\r\n' : '\n'
  return `${INCLUDE_MARKER}${eol}${INCLUDE_LINE}${eol}${config ? eol + config : ''}`
}

export function hasInclude(config: string): boolean {
  return config.split(/\r?\n/).some((l, i, all) => l === INCLUDE_MARKER && all[i + 1]?.trim() === INCLUDE_LINE)
}

/** 앱이 넣은 표시 줄과 Include 줄(그리고 뒤의 빈 줄 하나)만 뺀다 */
export function withoutInclude(config: string): string {
  const eol = config.includes('\r\n') ? '\r\n' : '\n'
  const lines = config.split(/\r?\n/)
  const i = lines.findIndex((l, k) => l === INCLUDE_MARKER && lines[k + 1]?.trim() === INCLUDE_LINE)
  if (i < 0) return config
  lines.splice(i, lines[i + 2] === '' ? 3 : 2)
  return lines.join(eol)
}
