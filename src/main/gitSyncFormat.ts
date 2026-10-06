import { createHash } from 'crypto'
import type { Group, Host } from '@shared/types'
import { validateVaultFile, type VaultFile, type VaultSyncEnvelope } from './vault'

export interface SyncSnapshot {
  version: 1
  groups: Group[]
  hosts: Host[]
  vault: VaultFile
}

// Stable fingerprints exclude object property ordering and never store plaintext snapshots in Git.
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.entries(value).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}'
  return JSON.stringify(value)
}
export const digest = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex')

export function parseSnapshot(plain: string, envelope: VaultSyncEnvelope): SyncSnapshot {
  const s = JSON.parse(plain) as SyncSnapshot
  validateVaultFile(s?.vault)
  const list = (a: unknown): a is { id: string }[] => Array.isArray(a) && a.length <= 10000 &&
    a.every((x) => x && typeof x.id === 'string' && x.id.length > 0) && new Set(a.map((x) => x.id)).size === a.length
  if (s.version !== 1 || 'osWrapped' in s.vault || !list(s.groups) || !list(s.hosts) ||
    s.groups.some((g) => typeof g.name !== 'string' || !(g.parentId === null || typeof g.parentId === 'string')) ||
    s.hosts.some((h) => typeof h.alias !== 'string' || typeof h.host !== 'string' || typeof h.username !== 'string' ||
      !(h.groupId === null || typeof h.groupId === 'string') || !['ssh', 'telnet', 'serial', 'local'].includes(h.protocol) ||
      !['password', 'key', 'agent', 'ask'].includes(h.authType) || !Number.isInteger(h.port) || h.port < 0 || h.port > 65535 ||
      !Array.isArray(h.tags) || !h.tags.every((t) => typeof t === 'string') || !Array.isArray(h.forwards)) ||
    digest(s.vault.kdf) !== digest(envelope.kdf) || digest(s.vault.wrapped) !== digest(envelope.wrapped)) {
    throw new Error('동기화 파일의 연결 정보 또는 볼트 형식이 올바르지 않습니다')
  }
  // A cyclic folder tree would hang the renderer's ancestry walks.
  const groups = new Map(s.groups.map((g) => [g.id, g]))
  for (const group of s.groups) {
    const seen = new Set<string>()
    let id: string | null = group.id
    while (id) {
      if (seen.has(id) || !groups.has(id)) throw new Error('동기화 폴더 구조가 올바르지 않습니다')
      seen.add(id)
      id = groups.get(id)!.parentId
    }
  }
  if (s.hosts.some((h) => h.groupId && !groups.has(h.groupId))) throw new Error('연결 정보의 폴더를 찾을 수 없습니다')
  return s
}
