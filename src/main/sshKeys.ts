import { promises as fs } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { Host, LocalPublicKey, TmuxCheck } from '@shared/types'
import { store } from './store'
import { openClient, fingerprint, execSh } from './transports/ssh'
import { TMUX_CHECK_SCRIPT, parseTmuxCheck } from './persist'

const sshDir = (): string => join(homedir(), '.ssh')

/** 한 줄짜리 OpenSSH 공개키 → 종류·본문·주석. 형식이 아니면 null */
function parsePub(text: string): { type: string; blob: string; comment: string } | null {
  const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith('#'))
  const m = line?.match(/^((?:ssh|ecdsa|sk)-[\w@.-]+)\s+([A-Za-z0-9+/]+={0,2})(?:\s+(.*))?$/)
  return m ? { type: m[1], blob: m[2], comment: m[3]?.trim() ?? '' } : null
}

/** ~/.ssh 의 *.pub — 개인 키가 옆에 있는 것을 앞에, ed25519 → ecdsa → rsa 순 */
export async function listPublicKeys(): Promise<LocalPublicKey[]> {
  let names: string[]
  try {
    names = await fs.readdir(sshDir())
  } catch {
    return []
  }
  const keys: LocalPublicKey[] = []
  for (const name of names.filter((n) => n.endsWith('.pub'))) {
    const path = join(sshDir(), name)
    try {
      const k = parsePub(await fs.readFile(path, 'utf8'))
      if (!k) continue
      keys.push({
        name,
        path,
        type: k.type,
        comment: k.comment,
        fingerprint: fingerprint(Buffer.from(k.blob, 'base64')),
        hasPrivate: names.includes(name.slice(0, -4))
      })
    } catch { /* 읽을 수 없는 파일은 건너뛴다 */ }
  }
  const rank = (k: LocalPublicKey): number => (k.hasPrivate ? 0 : 10) + (/ed25519/.test(k.type) ? 0 : /ecdsa/.test(k.type) ? 1 : /rsa/.test(k.type) ? 2 : 3)
  return keys.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
}

const sq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

/**
 * 서버의 ~/.ssh/authorized_keys 에 공개키를 넣는다. 같은 키 본문이 이미 있으면(옵션·주석이 달라도) 손대지 않는다.
 * 로그인 셸이 fish·csh 여도 되도록 스크립트는 sh 표준입력으로 보낸다.
 */
function installScript(type: string, blob: string, comment: string): string {
  const line = [type, blob, comment.replace(/[\r\n]/g, ' ')].filter(Boolean).join(' ')
  return [
    'umask 077',
    'cd || exit 1',
    'mkdir -p .ssh || exit 1',
    'f=.ssh/authorized_keys',
    `if [ -f "$f" ] && awk -v k=${sq(blob)} '{for(i=1;i<=NF;i++) if($i==k){f=1;exit}} END{exit !f}' "$f"; then echo BT_EXISTS; exit 0; fi`,
    // 끝에 줄바꿈이 없는 파일에 붙이면 마지막 키와 한 줄로 합쳐진다
    'if [ -s "$f" ] && [ -n "$(tail -c 1 "$f")" ]; then echo >> "$f"; fi',
    `printf '%s\\n' ${sq(line)} >> "$f" || exit 1`,
    'command -v restorecon >/dev/null 2>&1 && restorecon -F .ssh "$f" >/dev/null 2>&1',
    'echo BT_ADDED'
  ].join('\n') + '\n'
}

export async function installPublicKey(hostId: string, pubPath: string): Promise<'added' | 'exists'> {
  const host = store.get().hosts.find((h) => h.id === hostId)
  if (!host) throw new Error('서버를 찾을 수 없습니다')
  if (host.protocol !== 'ssh') throw new Error('SSH 서버에만 키를 등록할 수 있습니다')
  const k = parsePub(await fs.readFile(pubPath, 'utf8'))
  if (!k) throw new Error('OpenSSH 공개키 형식이 아닙니다')

  const { client, chain } = await openClient(host, { title: host.alias, cols: 80, rows: 24 })
  try {
    const out = await execSh(client, installScript(k.type, k.blob, k.comment))
    if (out.includes('BT_EXISTS')) return 'exists'
    if (out.includes('BT_ADDED')) return 'added'
    throw new Error(`서버에서 등록하지 못했습니다${out.trim() ? `: ${out.trim().slice(0, 300)}` : ' (sh 를 실행할 수 없는 서버일 수 있습니다)'}`)
  } finally {
    client.end()
    for (const c of chain.reverse()) try { c.end() } catch { /* */ }
  }
}

/** 세션 유지용 서버 확인 — 편집 중인(저장 전일 수 있는) 서버 설정으로 접속해 tmux 와 설치 방법을 본다 */
export async function checkTmux(host: Host): Promise<TmuxCheck> {
  if (host.protocol !== 'ssh' || !host.host) throw new Error('SSH 서버 주소를 먼저 입력하세요')
  const { client, chain } = await openClient(host, { title: host.alias || host.host, cols: 80, rows: 24 })
  try {
    return parseTmuxCheck(await execSh(client, TMUX_CHECK_SCRIPT))
  } finally {
    client.end()
    for (const c of chain.reverse()) try { c.end() } catch { /* */ }
  }
}
