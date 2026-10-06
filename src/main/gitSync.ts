import { execFile } from 'child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { isAbsolute, join } from 'path'
import { randomUUID } from 'crypto'
import type { GitSyncConfig, GitSyncStatus, StoreData } from '@shared/types'
import { dataDir, readJson, store, writeJsonAtomicSync } from './store'
import { vault, type VaultFile, type VaultSyncEnvelope } from './vault'
import { canonical, digest, parseSnapshot, type SyncSnapshot } from './gitSyncFormat'
import { send } from './ui'

const FILE = 'brightterm.vault.json'
const MAX_BYTES = 16 * 1024 * 1024
const DEFAULT_CONFIG: GitSyncConfig = { enabled: false, remote: '', branch: 'main' }
interface Tracking { config: GitSyncConfig; localDigest?: string; remoteDigest?: string; lastSync?: number }
interface Remote { head?: string; envelope?: VaultSyncEnvelope; hash?: string }
interface Rollback { store: StoreData; vault: VaultFile | null; tracking: Tracking }

function privateJson(path: string, data: unknown): void {
  const tmp = path + '.' + randomUUID() + '.tmp'
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
    renameSync(tmp, path)
  } finally {
    if (existsSync(tmp)) unlinkSync(tmp)
  }
}

function validateRemote(remote: string): void {
  if (!remote || /[\r\n\0]/.test(remote) || remote.startsWith('-')) throw new Error('Git 저장소 주소를 입력하세요')
  if (isAbsolute(remote)) return // local/bare repositories, including offline removable storage
  if (/^(https|ssh):\/\//.test(remote)) {
    const u = new URL(remote)
    if (!u.hostname || u.password || (u.protocol === 'https:' && u.username)) throw new Error('주소에 비밀번호나 토큰을 넣지 마세요. Git 자격 증명 관리자를 사용하세요')
    return
  }
  if (/^[\w.-]+@[\w.-]+:[^\s]+$/.test(remote)) return
  throw new Error('SSH 또는 HTTPS Git 주소, 또는 로컬 저장소의 절대 경로를 사용하세요')
}

export class GitSyncManager {
  private tracking: Tracking = { config: { ...DEFAULT_CONFIG } }
  private current: GitSyncStatus = { config: { ...DEFAULT_CONFIG }, state: 'disabled', message: 'Git 동기화 꺼짐' }
  private root = ''
  private configFile = ''
  private running: Promise<GitSyncStatus> | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private rerun = false
  private applying = false
  private stopped = false
  private conflict: { local: string; remote?: string } | null = null

  init(): void {
    this.root = join(dataDir(), 'git-sync')
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    this.configFile = join(dataDir(), 'git-sync.json')
    this.tracking = readJson<Tracking>(this.configFile) ?? { config: { ...DEFAULT_CONFIG } }
    const journal = join(this.root, 'rollback.json')
    if (existsSync(journal)) {
      this.restore(JSON.parse(readFileSync(journal, 'utf8')) as Rollback)
      this.archiveJournal()
    }
    this.update(this.tracking.config.enabled ? 'idle' : 'disabled', this.tracking.config.enabled ? '동기화 대기' : 'Git 동기화 꺼짐')
    store.onSyncChange = () => this.schedule()
    vault.onSyncChange = () => this.schedule()
  }

  status(): GitSyncStatus { return structuredClone(this.current) }

  async configure(config: GitSyncConfig): Promise<GitSyncStatus> {
    if (this.running) throw new Error('진행 중인 동기화가 끝난 뒤 설정을 변경하세요')
    const next = { enabled: !!config.enabled, remote: config.remote.trim(), branch: config.branch.trim() || 'main' }
    if (next.enabled || next.remote) {
      validateRemote(next.remote)
      if (next.branch.startsWith('-') || /[\r\n\0]/.test(next.branch)) throw new Error('올바른 브랜치 이름이 아닙니다')
      await this.git('', ['check-ref-format', '--branch', next.branch])
    }
    if (this.running) throw new Error('진행 중인 동기화가 끝난 뒤 설정을 변경하세요')
    if (next.remote !== this.tracking.config.remote || next.branch !== this.tracking.config.branch) this.tracking = { config: next }
    else this.tracking.config = next
    this.conflict = null
    this.persist()
    if (this.timer) clearTimeout(this.timer)
    this.update(next.enabled ? 'idle' : 'disabled', next.enabled ? '동기화 대기' : 'Git 동기화 꺼짐')
    this.schedule(0)
    return this.status()
  }

  schedule(delay = 900): void {
    if (this.applying || this.stopped || !this.tracking.config.enabled) return
    if (this.running) { this.rerun = true; return }
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => { this.timer = null; void this.sync() }, delay)
  }

  sync(choice?: 'local' | 'remote', password?: string): Promise<GitSyncStatus> {
    if (this.running) return this.running
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (!this.tracking.config.enabled || this.stopped) return Promise.resolve(this.status())
    const expected = this.conflict
    if (choice && !expected) return Promise.reject(new Error('먼저 지금 동기화를 눌러 원격 상태를 확인하세요'))
    this.running = this.perform(choice, password, expected).catch((e: Error) => {
      this.update('error', e.message)
      // Local edits and the last accepted fingerprints survive network failures and restarts.
      this.timer = setTimeout(() => { this.timer = null; void this.sync() }, 30000)
    }).then(() => this.status()).finally(() => {
      this.running = null
      if (this.rerun) { this.rerun = false; this.schedule() }
    })
    return this.running
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
  }

  private update(state: GitSyncStatus['state'], message: string): void {
    this.current = { config: { ...this.tracking.config }, state, message, lastSync: this.tracking.lastSync }
    send('git-sync:changed', this.status())
  }
  private persist(): void { privateJson(this.configFile, this.tracking) }
  private snapshot(): SyncSnapshot | null {
    const portable = vault.exportPortable()
    if (!portable) return null
    return { version: 1, vault: portable,
      groups: store.get().groups.map(({ collapsed: _local, ...g }) => structuredClone(g)),
      hosts: store.get().hosts.map(({ lastUsedAt: _local, ...h }) => structuredClone(h)) }
  }
  private block(state: 'conflict' | 'password-required', message: string, local: string, remote?: string): void {
    this.conflict = { local, remote }
    this.update(state, message)
  }
  private accepted(localDigest: string, remoteDigest: string): void {
    this.tracking = { ...this.tracking, localDigest, remoteDigest, lastSync: Date.now() }
    this.persist()
    this.conflict = null
    this.update('synced', '동기화 완료')
  }

  private async perform(choice?: 'local' | 'remote', password?: string, expected?: { local: string; remote?: string } | null): Promise<void> {
    this.update('syncing', 'Git 저장소 동기화 중…')
    const repo = await this.repository()
    const remote = await this.fetch(repo)
    const local = this.snapshot()
    if (!local) { this.update('locked', '볼트를 설정한 뒤 동기화할 수 있습니다'); return }
    const localHash = digest(local)
    if (choice && (expected?.local !== localHash || expected?.remote !== remote.hash)) {
      this.block('conflict', '확인하는 동안 데이터가 바뀌었습니다. 사용할 쪽을 다시 선택하세요', localHash, remote.hash)
      return
    }
    if (!choice && localHash === this.tracking.localDigest && remote.hash === this.tracking.remoteDigest && remote.hash) {
      this.accepted(localHash, remote.hash)
      return
    }
    const localChanged = localHash !== this.tracking.localDigest
    const remoteChanged = remote.hash !== this.tracking.remoteDigest
    if (!choice && remote.envelope && (localChanged || !this.tracking.localDigest)) {
      // Equivalent edits (or an interrupted successful push) should converge without conflict.
      if (vault.isUnlocked()) {
        let key: Buffer | undefined
        try {
          const decoded = vault.decryptSync(remote.envelope)
          key = decoded.key
          if (digest(parseSnapshot(decoded.plain, remote.envelope)) === localHash) {
            this.accepted(localHash, remote.hash!)
            return
          }
        } catch { /* choosing remote can supply its password */ }
        finally { key?.fill(0) }
      }
      if (remoteChanged || !this.tracking.localDigest) {
        this.block('conflict', '로컬과 원격 데이터가 다릅니다. 자동 덮어쓰기를 중단했습니다', localHash, remote.hash)
        return
      }
    }
    if (!choice && !remote.envelope && this.tracking.remoteDigest) {
      this.block('conflict', '원격 동기화 파일 또는 브랜치가 삭제되었습니다. 로컬 내용을 다시 올릴지 선택하세요', localHash)
      return
    }
    if (choice === 'remote' || (!choice && remoteChanged && remote.envelope)) {
      if (!remote.envelope) throw new Error('가져올 원격 동기화 파일이 없습니다')
      if (!vault.isUnlocked() && !password) { this.update('locked', '원격 변경을 받았습니다. 볼트 잠금 해제 후 적용합니다'); return }
      let decoded: { plain: string; key: Buffer }
      try { decoded = vault.decryptSync(remote.envelope, password) }
      catch (e) { this.block('password-required', (e as Error).message, localHash, remote.hash); return }
      try {
        const snapshot = parseSnapshot(decoded.plain, remote.envelope)
        this.apply(snapshot, decoded.key, remote.hash!)
      } finally { decoded.key.fill(0) }
      return
    }
    if (!vault.isUnlocked()) { this.update('locked', '볼트 잠금 해제 후 변경 내용을 올립니다'); return }
    const envelope = vault.encryptSync(canonical(local))
    const encoded = JSON.stringify(envelope, null, 2) + '\n'
    if (Buffer.byteLength(encoded) > MAX_BYTES) throw new Error('동기화 데이터가 16MB를 넘습니다')
    await this.push(repo, remote.head, encoded)
    this.accepted(localHash, digest(envelope))
  }

  private archiveJournal(): void {
    const backups = join(this.root, 'backups')
    mkdirSync(backups, { recursive: true, mode: 0o700 })
    renameSync(join(this.root, 'rollback.json'), join(backups, `${Date.now()}-${randomUUID()}.json`))
  }
  private restore(before: Rollback): void {
    writeJsonAtomicSync(join(dataDir(), 'store.json'), before.store)
    if (before.vault) writeJsonAtomicSync(join(dataDir(), 'vault.json'), before.vault)
    else if (existsSync(join(dataDir(), 'vault.json'))) unlinkSync(join(dataDir(), 'vault.json'))
    store.load()
    vault.lock()
    vault.init()
    this.tracking = before.tracking
    this.persist()
    send('store:changed')
  }
  private apply(snapshot: SyncSnapshot, key: Buffer, remoteHash: string): void {
    const before: Rollback = { store: structuredClone(store.get()), vault: structuredClone(vault.exportRaw()), tracking: structuredClone(this.tracking) }
    privateJson(join(this.root, 'rollback.json'), before)
    this.applying = true
    try {
      const collapsed = new Map(store.get().groups.map((g) => [g.id, g.collapsed]))
      const lastUsed = new Map(store.get().hosts.map((h) => [h.id, h.lastUsedAt]))
      vault.applySync(snapshot.vault, key)
      store.patch({ groups: snapshot.groups.map((g) => ({ ...g, collapsed: collapsed.get(g.id) })),
        hosts: snapshot.hosts.map((h) => ({ ...h, lastUsedAt: lastUsed.get(h.id) })) })
      store.flush()
      this.accepted(digest(snapshot), remoteHash)
      this.archiveJournal()
      send('store:changed')
    } catch (e) {
      this.restore(before)
      throw e
    } finally { this.applying = false }
  }

  private git(repo: string, args: string[], input?: string, extraEnv: NodeJS.ProcessEnv = {}): Promise<string> {
    const env = { ...process.env }
    for (const name of Object.keys(env)) {
      if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|CONFIG_COUNT|CONFIG_PARAMETERS|CONFIG_KEY_\d+|CONFIG_VALUE_\d+)$/.test(name)) delete env[name]
    }
    return new Promise((resolve, reject) => {
      const child = execFile('git', ['-c', `core.hooksPath=${join(this.root, 'no-hooks')}`, '-c', 'core.fsmonitor=false',
        '-c', 'fetch.recurseSubmodules=false', '-c', 'submodule.recurse=false',
        '-c', 'credential.interactive=false', '-c', 'commit.gpgsign=false', '-c', 'user.name=BrightTerm',
        '-c', 'user.email=sync@brightterm.local', ...(repo ? ['--git-dir', repo] : []), ...args], {
        timeout: 30000, maxBuffer: MAX_BYTES + 1024 * 1024, windowsHide: true,
        env: { ...env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', SSH_ASKPASS_REQUIRE: 'never',
          GIT_AUTHOR_NAME: 'BrightTerm', GIT_COMMITTER_NAME: 'BrightTerm', GIT_AUTHOR_EMAIL: 'sync@brightterm.local', GIT_COMMITTER_EMAIL: 'sync@brightterm.local',
          GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -oBatchMode=yes -oConnectTimeout=15', ...extraEnv }
      }, (error, stdout) => {
        if (error) reject(new Error((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'Git 실행 파일을 찾을 수 없습니다. Git을 설치하세요' :
          `Git ${args[0]} 실패: 네트워크·저장소 권한·SSH 키 또는 Git 자격 증명을 확인한 뒤 다시 시도하세요`))
        else resolve(stdout.trim())
      })
      child.stdin?.on('error', () => {})
      child.stdin?.end(input ?? '')
    })
  }
  private async repository(): Promise<string> {
    validateRemote(this.tracking.config.remote)
    await this.git('', ['check-ref-format', '--branch', this.tracking.config.branch])
    const repo = join(this.root, digest({ remote: this.tracking.config.remote, branch: this.tracking.config.branch }))
    if (!existsSync(join(repo, 'HEAD'))) {
      await this.git('', ['init', '--bare', repo])
    }
    // Also repairs an initialization interrupted between `init` and setting the remote.
    await this.git(repo, ['config', 'remote.origin.url', this.tracking.config.remote])
    return repo
  }
  private async fetch(repo: string): Promise<Remote> {
    const branch = this.tracking.config.branch
    const refs = await this.git(repo, ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`])
    if (!refs) return {}
    await this.git(repo, ['fetch', '--no-tags', 'origin', `+refs/heads/${branch}:refs/remotes/origin/brightterm`])
    const head = await this.git(repo, ['rev-parse', 'refs/remotes/origin/brightterm'])
    const entry = await this.git(repo, ['ls-tree', head, '--', FILE])
    if (!entry) return { head }
    if (!entry.startsWith('100644 blob ')) throw new Error('동기화 파일은 일반 JSON 파일이어야 합니다')
    const size = Number(await this.git(repo, ['cat-file', '-s', `${head}:${FILE}`]))
    if (size > MAX_BYTES) throw new Error('원격 동기화 파일이 16MB를 넘습니다')
    const envelope = JSON.parse(await this.git(repo, ['show', `${head}:${FILE}`])) as VaultSyncEnvelope
    if (envelope?.format !== 'brightterm-git-v1') throw new Error('지원하지 않는 Git 동기화 파일입니다')
    return { head, envelope, hash: digest(envelope) }
  }
  private async push(repo: string, head: string | undefined, encoded: string): Promise<void> {
    const index = join(this.root, `index-${randomUUID()}`)
    const env = { GIT_INDEX_FILE: index }
    try {
      await this.git(repo, head ? ['read-tree', head] : ['read-tree', '--empty'], undefined, env)
      const blob = await this.git(repo, ['hash-object', '-w', '--stdin'], encoded)
      await this.git(repo, ['update-index', '--add', '--cacheinfo', `100644,${blob},${FILE}`], undefined, env)
      const tree = await this.git(repo, ['write-tree'], undefined, env)
      const commit = await this.git(repo, ['commit-tree', tree, ...(head ? ['-p', head] : [])], 'Sync encrypted BrightTerm vault and connections\n')
      // Fast-forward only: a racing writer is never overwritten. The next fetch detects the conflict.
      await this.git(repo, ['push', '--porcelain', 'origin', `${commit}:refs/heads/${this.tracking.config.branch}`])
      await this.git(repo, ['update-ref', 'refs/heads/brightterm', commit])
    } finally {
      if (existsSync(index)) unlinkSync(index)
      if (existsSync(index + '.lock')) unlinkSync(index + '.lock')
    }
  }
}

export const gitSync = new GitSyncManager()
