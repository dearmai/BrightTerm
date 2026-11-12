// macOS 시스템 단축키(⌘Tab 앱 전환, ⌘Space Spotlight, ⌃Space 입력 소스, Mission Control …) 잠시 끄기.
// 원격 데스크톱 화면에 포커스가 있고 그 창이 앞에 있는 동안만 끈다 — 키가 앱으로 와서 그대로 원격(Windows)으로 간다.
// Moonlight·Parallels 처럼 SkyLight 의 CGSSetGlobalHotKeyOperatingMode 를 쓴다(비공개 API, 권한 필요 없음).
// 이 연결(프로세스)에만 걸리고 프로세스가 끝나면 macOS 가 되돌린다. koffi 가 없거나 실패하면 false — 전역 단축키로 대신한다.

const CGS_HOTKEY_ENABLE = 0
const CGS_HOTKEY_DISABLE = 1

interface Cgs {
  conn: () => number
  set: (conn: number, mode: number) => number
}

let cgs: Cgs | null | undefined
let disabled = false

function load(): Cgs | null {
  if (cgs !== undefined) return cgs
  cgs = null
  if (process.platform !== 'darwin') return cgs
  try {
    // Windows·Linux 패키지에는 koffi 를 넣지 않는다 — macOS 에서만 불러온다
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require('koffi') as { load(path: string): { func(sig: string): (...a: number[]) => number } }
    const lib = koffi.load('/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices')
    cgs = { conn: lib.func('int _CGSDefaultConnection()') as () => number, set: lib.func('int CGSSetGlobalHotKeyOperatingMode(int, int)') as (c: number, m: number) => number }
  } catch (e) {
    console.warn('[rdp] macOS 시스템 단축키를 끌 수 없습니다:', (e as Error).message)
  }
  return cgs
}

/** 시스템 단축키를 끄거나(true) 되돌린다(false). 끄기에 성공했으면 true */
export function setSystemHotkeysDisabled(off: boolean): boolean {
  if (off === disabled) return disabled
  const c = load()
  if (!c) return false
  try {
    const err = c.set(c.conn(), off ? CGS_HOTKEY_DISABLE : CGS_HOTKEY_ENABLE)
    if (err !== 0) return false
    disabled = off
    return disabled
  } catch {
    return false
  }
}

export const systemHotkeysDisabled = (): boolean => disabled
