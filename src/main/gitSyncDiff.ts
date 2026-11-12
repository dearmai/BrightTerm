import type { CredentialSecret, GitSyncDifference, GitSyncDiffField } from '@shared/types'
import type { SyncSnapshot } from './gitSyncFormat'

const labels: Record<string, string> = {
  alias: '이름', name: '이름', host: '주소', port: '포트', protocol: '프로토콜', username: '사용자', authType: '인증 방식',
  groupId: '폴더', parentId: '상위 폴더', credentialId: '저장 계정', jumpHostId: '점프 호스트', jump: '직접 입력한 점프 호스트',
  proxy: '프록시', encoding: '문자 인코딩', termType: '터미널 종류', keys: '키 입력 설정', terminalPreset: '터미널 템플릿',
  terminalTheme: '터미널 테마', startupCommand: '자동 실행 명령', keepaliveSec: 'Keepalive 간격(초)', autoReconnect: '자동 재접속',
  reconnectPolicy: '재접속 규칙', mouseReporting: '마우스 입력 전달', persist: '세션 유지', persistMouse: 'tmux 마우스 모드',
  persistName: 'tmux 세션 이름', idleCommandSec: '유휴 방지 간격(초)', idleCommand: '유휴 방지 명령', shellPromptExample: '셸 프롬프트 예시',
  forwards: '포트 포워딩', local: '로컬 셸 설정', serial: '시리얼 설정', color: '색상', env: '환경', tags: '태그',
  os: '서버 OS', rdp: '원격 데스크톱(RDP) 설정', sshConfig: '.ssh/config 동기화', sshConfigName: '.ssh/config Host 이름',
  notes: '메모', sort: '정렬 순서', favorite: '즐겨찾기', body: '스니펫 본문', sendEnter: 'Enter 전송', kind: '계정 종류', updatedAt: '수정 시각'
}
const concealed = new Set(['body', 'startupCommand', 'notes', 'idleCommand', 'shellPromptExample'])
const secretKeys = /password|passphrase|privatekey|token|secret|api.?key|access.?key|authorization|cookie/i
const stable = (v: unknown): string => JSON.stringify(v, (_k, x) => x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.entries(x).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b))) : x) ?? 'undefined'
const same = (a: unknown, b: unknown): boolean => stable(a) === stable(b)

function redact(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1[자격 증명 숨김]@')
  if (Array.isArray(value)) return value.map(redact)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, secretKeys.test(k) ? '(숨김)' : redact(v)]))
  return value
}
function display(value: unknown, field: string, snapshot: SyncSnapshot): string {
  if (value === undefined) {
    if (['mouseReporting', 'persistMouse'].includes(field)) return '미설정 (기본: 켜기)'
    if (['persist', 'favorite'].includes(field)) return '미설정 (기본: 끄기)'
    if (field === 'autoReconnect') return '미설정 (앱 설정 따르기)'
    return '미설정 (기본값 사용)'
  }
  if (value === null || value === '') return '없음'
  if (typeof value === 'boolean') return value ? '켜기' : '끄기'
  if (typeof value === 'string' && ['groupId', 'parentId', 'credentialId', 'jumpHostId'].includes(field)) {
    const list = field === 'credentialId' ? snapshot.vault.items : field === 'jumpHostId' ? snapshot.hosts : snapshot.groups
    const item = list.find((x) => x.id === value)
    return String(redact(`${item ? ('alias' in item ? item.alias : item.name) : '참조 대상 없음'} (${value})`))
  }
  if (field === 'updatedAt' && typeof value === 'number') {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? '유효하지 않은 시각' : date.toISOString()
  }
  const safe = redact(value)
  const text = typeof safe === 'string' ? safe : JSON.stringify(safe, null, 2)
  return text.length > 2400 ? text.slice(0, 2400) + '\n… 긴 값 생략 (2400자까지 표시)' : text
}

/** Only safe comparison rows leave the main process. Secret maps are temporary and never part of the result. */
export function compareSnapshots(local: SyncSnapshot, remote: SyncSnapshot | null,
  localSecrets: Record<string, CredentialSecret>, remoteSecrets: Record<string, CredentialSecret>): GitSyncDifference[] {
  const out: GitSyncDifference[] = []
  const compareList = (category: GitSyncDifference['category'], left: { id: string }[], right: { id: string }[]): void => {
    const lmap = new Map(left.map((x) => [x.id, x])), rmap = new Map(right.map((x) => [x.id, x]))
    for (const id of new Set([...lmap.keys(), ...rmap.keys()])) {
      const l = lmap.get(id) as Record<string, unknown> | undefined
      const r = rmap.get(id) as Record<string, unknown> | undefined
      const fields: GitSyncDiffField[] = []
      const present = new Set([...Object.keys(l ?? {}), ...Object.keys(r ?? {})])
      const keys = new Set([...Object.keys(labels).filter((key) => present.has(key)), ...present])
      for (const key of keys) {
        if (['id', 'iv', 'ct', 'tag', 'osWrapped'].includes(key) || same(l?.[key], r?.[key])) continue
        const known = !!labels[key] && !secretKeys.test(key)
        fields.push({ label: labels[key] ?? '기타 저장 필드',
          local: !l ? '항목 없음' : known ? display(l[key], key, local) : '표시하지 않음',
          remote: !r ? '항목 없음' : known ? display(r[key], key, remote!) : '표시하지 않음', concealed: concealed.has(key) })
      }
      if (category === 'credentials') {
        const a = Object.hasOwn(localSecrets, id) ? localSecrets[id] : undefined
        const b = Object.hasOwn(remoteSecrets, id) ? remoteSecrets[id] : undefined
        if (!same(a?.username, b?.username) && same(l?.username, r?.username)) {
          fields.push({ label: '계정 내부 사용자', local: display(a?.username, 'username', local), remote: remote ? display(b?.username, 'username', remote) : '항목 없음' })
        }
        for (const [key, label] of [['password', '비밀번호'], ['privateKey', '개인 키'], ['passphrase', '키 암호']] as const) {
          if (same(a?.[key], b?.[key])) continue
          const presence = (v: string | undefined): string => v === undefined ? '없음' : '값 있음 (내용 숨김)'
          fields.push({ label: `${label} — 값이 다름`, local: presence(a?.[key]), remote: presence(b?.[key]) })
        }
        if (l && r && !same([l.iv, l.ct, l.tag], [r.iv, r.ct, r.tag]) && same(a, b)) {
          fields.push({ label: '암호화 표현', local: '표현 다름 · 실제 계정 값 같음', remote: '표현 다름 · 실제 계정 값 같음' })
        }
        if (l && r && !same(a, b) && !fields.length) fields.push({ label: '기타 계정 내용', local: '값이 다름 (숨김)', remote: '값이 다름 (숨김)' })
      }
      if (fields.length || !l || !r) {
        const name = String((r?.alias ?? r?.name ?? l?.alias ?? l?.name) || id)
        out.push({ category, id, name: String(redact(name)).slice(0, 240), kind: !l ? 'remote-only' : !r ? 'local-only' : 'changed', fields })
      }
    }
    if (same([...lmap.keys()].sort(), [...rmap.keys()].sort()) && !same(left.map((x) => x.id), right.map((x) => x.id))) {
      out.push({ category, id: '$order', name: '항목 나열 순서', kind: 'changed', fields: [{ label: '저장 순서', local: '순서가 다름', remote: '순서가 다름' }] })
    }
  }
  compareList('hosts', local.hosts, remote?.hosts ?? [])
  compareList('groups', local.groups, remote?.groups ?? [])
  if (!remote || remote.snippets !== undefined) compareList('snippets', local.snippets ?? [], remote?.snippets ?? [])
  compareList('credentials', local.vault.items, remote?.vault.items ?? [])
  if (remote) {
    const fields: GitSyncDiffField[] = []
    for (const [label, a, b] of [
      ['마스터 비밀번호 잠금 정보', [local.vault.kdf, local.vault.wrapped], [remote.vault.kdf, remote.vault.wrapped]],
      ['복구 코드 잠금 정보', [local.vault.recoveryKdf, local.vault.recoveryWrapped], [remote.vault.recoveryKdf, remote.vault.recoveryWrapped]]
    ]) if (!same(a, b)) fields.push({ label: label as string, local: '서로 다름 (값 숨김)', remote: '서로 다름 (값 숨김)' })
    if (fields.length) out.push({ category: 'vault', id: '$vault', name: '볼트 잠금·암호화 정보', kind: 'changed', fields })
  }
  return out
}
