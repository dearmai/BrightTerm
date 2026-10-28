// 서버 종류별 터미널 호환 설정 — 키 입력 코드·터미널 종류·인코딩 템플릿과 키 변환
import type { Encoding, Host, KeyOptions } from './types'

export const DEFAULT_KEYS: KeyOptions = { backspace: 'del', delete: 'vt220', homeEnd: 'xterm', enter: 'CR' }

export interface TerminalPreset {
  id: string
  label: string
  hint: string
  termType: string
  /** 없으면 인코딩은 그대로 둔다 — 같은 OS 도 한글 로캘이 서버마다 다르다 */
  encoding?: Encoding
  keys: KeyOptions
}

const UNIX_KEYS: KeyOptions = { ...DEFAULT_KEYS, backspace: 'ctrl-h', homeEnd: 'vt220' }

/** 서버 편집의 템플릿 — 누르면 터미널 종류·키 입력(과 정해진 경우 인코딩)을 한 번에 채운다.
 *  Ubuntu·Debian·RHEL·Rocky·SUSE·Alpine·FreeBSD·macOS·Windows OpenSSH 는 모두 Linux 값으로 된다. */
export const TERMINAL_PRESETS: TerminalPreset[] = [
  { id: 'linux', label: 'Linux / BSD', hint: 'Ubuntu·Debian·RHEL·Rocky·Alma·SUSE·Alpine·FreeBSD·macOS·Windows OpenSSH — 기본값', termType: 'xterm-256color', encoding: 'utf-8', keys: DEFAULT_KEYS },
  { id: 'linux-euckr', label: '구형 Linux (EUC-KR)', hint: 'RHEL·CentOS 5/6 처럼 LANG=ko_KR.eucKR 로 쓰는 서버', termType: 'xterm', encoding: 'euc-kr', keys: DEFAULT_KEYS },
  { id: 'embedded', label: '임베디드 (BusyBox)', hint: 'OpenWrt·NAS·공유기 등 terminfo 가 없는 BusyBox 셸', termType: 'xterm', keys: { ...DEFAULT_KEYS, homeEnd: 'vt220' } },
  { id: 'aix', label: 'AIX', hint: '백스페이스 ^H, xterm (AIX 에는 xterm-256color 가 없는 경우가 많다). 한글 로캘 IBM-eucKR 은 인코딩을 EUC-KR 로', termType: 'xterm', keys: UNIX_KEYS },
  { id: 'hpux', label: 'HP-UX', hint: '백스페이스 ^H, Home/End ESC[1~. 한글 로캘 ko_KR.eucKR 은 인코딩을 EUC-KR 로', termType: 'xterm', keys: UNIX_KEYS },
  { id: 'solaris', label: 'Solaris', hint: 'Solaris 10 이하에는 xterm-256color 가 없어 xterm', termType: 'xterm', keys: { ...DEFAULT_KEYS, homeEnd: 'vt220' } },
  { id: 'sco', label: 'SCO / UnixWare', hint: '백스페이스 ^H, ansi 터미널', termType: 'ansi', keys: UNIX_KEYS },
  { id: 'network', label: '네트워크 장비', hint: 'Cisco·Juniper·Huawei·HPE 스위치·라우터 — vt100, Delete 는 ^?', termType: 'vt100', keys: { ...DEFAULT_KEYS, delete: 'del' } }
]

export const ENCODINGS: { value: Encoding; label: string }[] = [
  { value: 'utf-8', label: 'UTF-8' },
  { value: 'euc-kr', label: 'EUC-KR (AIX IBM-eucKR · 유닉스 ko_KR)' },
  { value: 'cp949', label: 'CP949 (윈도우 한글 · 구형 장비)' },
  { value: 'euc-jp', label: 'EUC-JP' },
  { value: 'shift_jis', label: 'Shift_JIS' },
  { value: 'gbk', label: 'GBK (중국어 간체)' },
  { value: 'big5', label: 'Big5 (중국어 번체)' },
  { value: 'latin1', label: 'ISO-8859-1 (Latin-1)' },
  { value: 'cp1252', label: 'Windows-1252' }
]

export function hostKeys(h: Pick<Host, 'keys'>): KeyOptions {
  return { ...DEFAULT_KEYS, ...h.keys }
}

/** 지금 설정과 똑같은 템플릿 — 없으면 사용자 지정 */
export function matchPreset(h: Pick<Host, 'termType' | 'encoding' | 'keys' | 'terminalPreset'>): TerminalPreset | undefined {
  const k = hostKeys(h)
  const same = (p: TerminalPreset): boolean => p.termType === h.termType && (!p.encoding || p.encoding === h.encoding) &&
    (Object.keys(p.keys) as (keyof KeyOptions)[]).every((x) => p.keys[x] === k[x])
  const picked = TERMINAL_PRESETS.find((p) => p.id === h.terminalPreset)
  return picked && same(picked) ? picked : TERMINAL_PRESETS.find(same)
}

/** 템플릿을 서버 설정에 적용한다 */
export function applyPreset<H extends Pick<Host, 'termType' | 'encoding' | 'keys' | 'terminalPreset'>>(h: H, p: TerminalPreset): H {
  return { ...h, termType: p.termType, encoding: p.encoding ?? h.encoding, keys: { ...p.keys }, terminalPreset: p.id }
}

/** SSH pty 요청에 넣는 erase 문자 — 백스페이스가 보내는 코드와 서버 stty erase 를 맞춘다 */
export function eraseChar(k: KeyOptions): number {
  return k.backspace === 'ctrl-h' ? 8 : 127
}

/**
 * xterm.js 가 보낸 키 입력을 서버가 기대하는 코드로 바꾼다.
 * 키 하나는 onData 한 번으로 오므로 정확히 일치할 때만 바꾸고, Enter 는 붙여 넣기에도 적용한다.
 * Ctrl+Backspace(^H) 는 PuTTY 처럼 반대 코드를 보낸다.
 */
export function mapKeys(data: string, k: KeyOptions, enter = true): string {
  switch (data) {
    case '\x7f': return k.backspace === 'ctrl-h' ? '\b' : data
    case '\b': return k.backspace === 'ctrl-h' ? '\x7f' : data
    case '\x1b[3~': return k.delete === 'del' ? '\x7f' : data
    case '\x1b[H': case '\x1bOH': return k.homeEnd === 'vt220' ? '\x1b[1~' : data
    case '\x1b[F': case '\x1bOF': return k.homeEnd === 'vt220' ? '\x1b[4~' : data
  }
  if (!enter || k.enter === 'CR' || !data.includes('\r')) return data
  return data.replace(/\r(?!\n)/g, k.enter === 'CRLF' ? '\r\n' : '\n')
}
