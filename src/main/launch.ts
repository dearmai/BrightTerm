import { app } from 'electron'
import { promises as fs } from 'fs'
import { connect, Socket } from 'net'
import { join, isAbsolute } from 'path'
import { randomUUID } from 'crypto'
import type { AdhocTarget, CredentialSecret, LaunchItem } from '@shared/types'
import { parseLaunchArgs, parseXsh, parseCrtSession, decodeSessionFile, type LaunchArgs, type LaunchTarget } from './launchArgs'
import { scanPutty } from './importers'
import { store } from './store'
import { send } from './ui'

/** 세션을 열 때 넘겨받는 것 — 비밀번호·키는 렌더러를 거치지 않는다 */
export interface LaunchClaim {
  secret?: CredentialSecret
  /** 브릿지 파이프 — 닫으면 브릿지가 끝난다 */
  bridge?: Socket
}

const pending: LaunchItem[] = []
const claims = new Map<string, LaunchClaim>()

/** 실행 인자(첫 실행·두 번째 실행)를 접속 요청으로 — 렌더러가 launch:take 로 가져가 탭을 연다 */
export async function handleLaunch(argv: string[]): Promise<void> {
  const a = parseLaunchArgs(argv)
  if (!a) return
  const id = randomUUID()
  const bridge = a.pipe ? connectBridge(a.pipe, id) : undefined
  // 인자 없이 브릿지만 실행했다(바로가기 등) — 창만 앞으로 가져오고 브릿지는 끝낸다
  if (!a.host && !a.session && !a.sessionFile && !a.unsupported) return void bridge?.destroy()
  try {
    const { item, secret } = await resolve(a, id)
    claims.set(id, { secret, bridge })
    pending.push(item)
  } catch (e) {
    bridge?.destroy()
    pending.push({ id, error: `외부 실행 인자로 접속하지 못했습니다: ${(e as Error).message}` })
  }
  send('launch:pending')
}

export function takeLaunches(): LaunchItem[] {
  return pending.splice(0)
}

export function claimLaunch(id: string): LaunchClaim | undefined {
  const c = claims.get(id)
  claims.delete(id)
  return c
}

/** 브릿지가 기다리는 named pipe 에 붙는다 — 세션을 열기 전에 브릿지가 끝나면 그 요청은 버린다 */
function connectBridge(pipe: string, id: string): Socket {
  const sock = connect(pipe)
  sock.on('error', () => sock.destroy())
  sock.on('data', () => { /* 브릿지는 보내지 않는다 */ })
  sock.on('close', () => {
    if (claims.delete(id)) {
      const i = pending.findIndex((p) => p.id === id)
      if (i >= 0) pending.splice(i, 1)
    }
  })
  return sock
}

async function resolve(a: LaunchArgs, id: string): Promise<{ item: LaunchItem; secret?: CredentialSecret }> {
  if (a.unsupported) throw new Error(`${a.unsupported} 방식은 지원하지 않습니다 (SSH·텔넷만)`)
  const secret: CredentialSecret = {}
  if (a.password) secret.password = a.password
  else if (a.passwordFile) secret.password = (await fs.readFile(a.passwordFile, 'utf8')).split(/\r?\n/)[0]
  if (a.keyFile) secret.privateKey = await fs.readFile(a.keyFile, 'utf8')
  const hasSecret = !!(secret.password || secret.privateKey)

  let base: LaunchTarget = {}
  const name = a.session?.trim()
  if (name && !a.host) {
    // BrightTerm 에 같은 이름의 서버가 있으면 그 설정(볼트 비밀번호·점프 호스트 등)으로 연다
    const saved = store.get().hosts.find((h) => h.alias === name && (h.protocol === 'ssh' || h.protocol === 'telnet'))
    if (saved && !a.username && !a.port) return { item: { id, hostId: saved.id }, secret: hasSecret ? secret : undefined }
    base = (await foreignSession(a, name)) ?? (saved ? { protocol: saved.protocol, host: saved.host, port: saved.port, username: saved.username } : {})
  }
  if (a.sessionFile) base = parseXsh(decodeSessionFile(await fs.readFile(a.sessionFile)))

  const host = a.host ?? base.host ?? (a.style === 'xshell' && name ? name : undefined)
  if (!host) throw new Error(name ? `세션 '${name}' 을(를) 찾을 수 없습니다` : '서버 주소가 없습니다')
  secret.password ??= base.password
  const target: AdhocTarget = {
    host,
    protocol: a.protocol ?? base.protocol ?? 'ssh',
    port: a.port ?? base.port,
    username: a.username ?? base.username,
    title: a.title ?? (name || undefined)
  }
  return { item: { id, target }, secret: secret.password || secret.privateKey ? secret : undefined }
}

/** 원래 프로그램에 저장된 세션 — 보안 프로그램이 임시 세션을 써 두고 이름으로 부르는 경우 */
async function foreignSession(a: LaunchArgs, name: string): Promise<LaunchTarget | undefined> {
  if (a.style === 'putty') {
    const c = (await scanPutty()).find((x) => x.name === name)
    if (!c || (c.host.protocol !== 'ssh' && c.host.protocol !== 'telnet')) return undefined
    return { protocol: c.host.protocol, host: c.host.host, port: c.host.port, username: c.host.username || undefined }
  }
  const file = a.style === 'securecrt'
    ? join(a.configDir || join(app.getPath('appData'), 'VanDyke', 'Config'), 'Sessions', `${name}.ini`)
    : await xshellSessionFile(name)
  if (!file) return undefined
  try {
    const buf = await fs.readFile(file)
    return a.style === 'securecrt' ? parseCrtSession(decodeSessionFile(buf)) : parseXsh(decodeSessionFile(buf))
  } catch {
    return undefined
  }
}

/** 문서\NetSarang Computer\<버전>\Xshell\Sessions\<이름>.xsh — 새 버전부터 찾는다 */
async function xshellSessionFile(name: string): Promise<string | undefined> {
  if (isAbsolute(name)) return name
  const root = join(app.getPath('documents'), 'NetSarang Computer')
  const versions = await fs.readdir(root).catch(() => [] as string[])
  for (const v of versions.sort((x, y) => Number(y) - Number(x))) {
    const f = join(root, v, 'Xshell', 'Sessions', `${name}.xsh`)
    if (await fs.stat(f).then(() => true, () => false)) return f
  }
  return undefined
}
