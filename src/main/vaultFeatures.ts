/**
 * 볼트 형식 버전 표시 — 이전 버전 앱이 읽지 못하는 기능(새 계정 종류 등)을 쓸 때만 features·minAppVersion 을 적는다.
 * 그 기능을 모르는 앱은 형식 오류 대신 '업데이트하세요' 를 보여 준다. Android: SyncCrypto.java 의 FEATURES 와 같게 유지.
 * 순수 함수 — 테스트용으로 다른 모듈에 의존하지 않는다.
 */
interface VaultFeatureFields {
  features?: string[]
  minAppVersion?: string
  items?: { kind?: unknown }[]
}

/** 볼트 기능 → 처음 지원한 앱 버전. 새 계정 종류 등 이전 버전이 읽지 못하는 것을 넣으면 여기에 더한다 */
export const VAULT_FEATURES: Record<string, string> = { totp: '1.3.0' }
export const KINDS = ['password', 'key', 'totp']

/** 이 앱이 모르는 기능을 쓰는 볼트 — 형식 오류와 구분해 업데이트를 안내한다 */
export class VaultUpdateRequired extends Error {
  constructor(minAppVersion?: string, features: string[] = []) {
    super(`이 볼트(동기화·백업 데이터)는 BrightTerm ${minAppVersion && /^\d+(\.\d+){0,3}$/.test(minAppVersion) ? `${minAppVersion} 이상` : '최신 버전'}이 필요합니다` +
      `${features.length ? ` (새 기능: ${features.slice(0, 5).join(', ').slice(0, 120)})` : ''}. 앱을 업데이트한 뒤 다시 시도하세요`)
    this.name = 'VaultUpdateRequired'
  }
}

/** 모르는 기능·계정 종류가 있으면 VaultUpdateRequired — 형식 검사보다 먼저 한다 */
export function checkVaultFeatures(v: VaultFeatureFields | null | undefined): void {
  if (!v || typeof v !== 'object') return
  const unknown = Array.isArray(v.features) ? v.features.filter((f) => typeof f !== 'string' || !(f in VAULT_FEATURES)).map(String) : []
  const kinds = Array.isArray(v.items) ? v.items.some((i) => i && typeof i.kind === 'string' && !KINDS.includes(i.kind)) : false
  if (unknown.length || kinds) throw new VaultUpdateRequired(typeof v.minAppVersion === 'string' ? v.minAppVersion : undefined, unknown)
}

const versionNum = (v: string): number[] => v.split('.').map((x) => +x || 0)
const newer = (a: string, b: string): boolean => {
  const x = versionNum(a), y = versionNum(b)
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0)
  return false
}

/** 볼트 내용에 맞게 features·minAppVersion 을 다시 적는다 — 새 기능을 안 쓰면 둘 다 지워 이전 버전과 호환 */
export function stampVaultFeatures(v: VaultFeatureFields & { items: { kind: string }[] }): void {
  const used = Object.keys(VAULT_FEATURES).filter((f) => f === 'totp' && v.items.some((i) => i.kind === 'totp'))
  if (!used.length) { delete v.features; delete v.minAppVersion; return }
  v.features = used
  v.minAppVersion = used.map((f) => VAULT_FEATURES[f]).reduce((a, b) => (newer(b, a) ? b : a))
}
