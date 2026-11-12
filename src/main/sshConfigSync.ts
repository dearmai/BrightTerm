// 서버 목록을 ~/.ssh/brightterm.conf 로 쓰고 ~/.ssh/config 맨 앞에 Include 한 줄을 넣는다 (앱 → 파일 단방향).
// 사용자가 쓴 ~/.ssh/config 내용은 건드리지 않는다. 반영된 서버가 하나도 없으면 앱이 만든 파일과 Include 를 걷어 낸다.
// 자동 동기화(설정, PC 별)를 끄면 이 PC 에서는 서버 편집의 버튼으로 서버별로만 반영한다.
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { SSH_CONFIG_FILE, buildSshConfig, hasInclude, mergeSshHost, sshHostBlock, withInclude, withoutInclude } from '@shared/sshConfig'
import type { Host, SshConfigStatus } from '@shared/types'
import { store } from './store'

/** 테스트는 BRIGHTTERM_SSH_DIR 로 실제 ~/.ssh 대신 임시 폴더를 쓴다 */
export const sshDir = (): string => process.env.BRIGHTTERM_SSH_DIR || join(homedir(), '.ssh')
const paths = (): { dir: string; file: string; config: string } => ({ dir: sshDir(), file: join(sshDir(), SSH_CONFIG_FILE), config: join(sshDir(), 'config') })
const autoSync = (): boolean => store.get().settings.sshConfigAutoSync === true

let lastError: string | undefined
let lastAt: number | undefined
let timer: NodeJS.Timeout | null = null

function writeAtomic(path: string, text: string): void {
  // dotfiles 저장소 등으로 연결한 심볼릭 링크는 링크를 남기고 대상 파일을 바꾼다
  const file = existsSync(path) ? realpathSync(path) : path
  const tmp = `${file}.bt-tmp`
  writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, file)
}

/** 반영된 서버 id — 앱이 쓴 블록의 BrightTerm id 주석 */
function appliedIds(): string[] {
  const { file } = paths()
  if (!existsSync(file)) return []
  return [...readFileSync(file, 'utf8').matchAll(/^ {2}# BrightTerm id: (.+)$/gm)].map((m) => m[1].trim())
}

export function sshConfigStatus(): SshConfigStatus {
  const { file, config } = paths()
  const ids = appliedIds()
  return { count: ids.length, ids, file, config, auto: autoSync(), at: lastAt, error: lastError }
}

/** 파일 내용을 쓰고 Include 를 맞춘다. count 0 이면 앱이 만든 파일과 Include 를 걷어 낸다 */
function write(text: string, count: number): void {
  const { dir, file, config } = paths()
  lastAt = Date.now()
  lastError = undefined
  try {
    if (!count) {
      // 한 번도 쓰지 않았으면 ~/.ssh 를 건드리지 않는다
      if (existsSync(file)) rmSync(file, { force: true })
      if (existsSync(config)) {
        const cur = readFileSync(config, 'utf8')
        if (hasInclude(cur)) writeAtomic(config, withoutInclude(cur))
      }
      return
    }
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    if (!existsSync(file) || readFileSync(file, 'utf8') !== text) writeAtomic(file, text)
    const cur = existsSync(config) ? readFileSync(config, 'utf8') : ''
    if (!hasInclude(cur)) writeAtomic(config, withInclude(cur))
  } catch (e) {
    lastError = (e as Error).message
    console.error('[ssh-config]', e)
  }
}

/** 자동 동기화 — 동기화를 켠 서버 전체로 파일을 다시 쓴다. 설정에서 끄면 아무것도 하지 않는다 */
export function syncSshConfig(): SshConfigStatus {
  if (autoSync()) {
    const { hosts, groups } = store.get()
    const { text, count } = buildSshConfig(hosts, groups)
    write(text, count)
  }
  return sshConfigStatus()
}

/**
 * 수동 반영 — 이 서버 블록만 바꾼다. 동기화를 켰으면 추가·갱신, 껐으면 뺀다. 다른 서버 블록은 그대로.
 * host 는 서버 편집 창의 현재 값(저장 전이어도 된다). Host 이름·ProxyJump 는 저장된 다른 서버와 함께 정한다
 */
export function applySshHost(host: Host): SshConfigStatus {
  const { hosts, groups } = store.get()
  const list = hosts.some((h) => h.id === host.id) ? hosts.map((h) => (h.id === host.id ? host : h)) : [...hosts, host]
  const { file } = paths()
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const { text, count } = mergeSshHost(existing, host.id, sshHostBlock(host.id, list, groups))
  write(text, count)
  return sshConfigStatus()
}

/** 서버·그룹·설정이 바뀌면 잠시 모아서 한 번 쓴다 */
export function scheduleSshConfigSync(delayMs = 300): void {
  if (!autoSync()) return
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => { timer = null; syncSshConfig() }, delayMs)
  timer.unref?.()
}
