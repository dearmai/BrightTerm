// Shared types between main / preload / renderer

export type Env = 'prod' | 'stage' | 'dev' | 'device' | 'none'
export type Protocol = 'ssh' | 'telnet' | 'serial' | 'local'
export type AuthType = 'password' | 'key' | 'agent' | 'ask'

export interface Group {
  id: string
  parentId: string | null
  name: string
  color?: string
  env?: Env
  collapsed?: boolean
  sort: number
}

export interface PortForward {
  id: string
  type: 'L' | 'R'
  bindHost: string
  bindPort: number
  destHost: string
  destPort: number
}

export interface SerialOptions {
  path: string
  baudRate: number
  dataBits: 5 | 6 | 7 | 8
  parity: 'none' | 'even' | 'odd' | 'mark' | 'space'
  stopBits: 1 | 1.5 | 2
  flowControl: 'none' | 'rtscts' | 'xonxoff'
  enterSends: 'CR' | 'LF' | 'CRLF'
  localEcho: boolean
}

/** 서버 설정 안에 직접 적은 점프 호스트(베스천) — 따로 등록하지 않고 쓴다. 비밀은 볼트(credentialId) */
export interface InlineJump {
  host: string
  port: number
  username: string
  authType: AuthType
  credentialId?: string | null
}

/** 서버에 접속할 때 거치는 프록시. 비밀번호는 볼트(credentialId) */
export type ProxyType = 'http' | 'https' | 'socks5' | 'socks4'
export interface ProxyConfig {
  type: ProxyType
  host: string
  port: number
  /** 인증 — 비우면 인증 없이 */
  username?: string
  credentialId?: string | null
  /** HTTPS 프록시의 인증서를 확인하지 않는다(사내 자체 서명 등) */
  insecure?: boolean
}

/** 서버 문자 인코딩 — AIX 의 IBM-eucKR 은 euc-kr, 윈도우 한글은 cp949 */
export type Encoding = 'utf-8' | 'euc-kr' | 'cp949' | 'euc-jp' | 'shift_jis' | 'gbk' | 'big5' | 'latin1' | 'cp1252'

/** 키 입력 코드 — 서버마다 기대하는 값이 다르다 (예: AIX 는 백스페이스가 ^H) */
export interface KeyOptions {
  /** del: ^? (0x7F, 리눅스 기본) / ctrl-h: ^H (0x08, AIX·HP-UX 등) */
  backspace: 'del' | 'ctrl-h'
  /** vt220: ESC[3~ / del: ^? */
  delete: 'vt220' | 'del'
  /** xterm: ESC[H·ESC[F / vt220: ESC[1~·ESC[4~ (PuTTY 기본) */
  homeEnd: 'xterm' | 'vt220'
  /** Enter 키 — SSH·텔넷 (시리얼은 시리얼 설정을 따른다) */
  enter: 'CR' | 'CRLF' | 'LF'
}

/** 로컬 터미널 — 이 PC 의 셸. 빈 값이면 기본 셸 / 홈 폴더 */
export interface LocalOptions {
  shell?: string
  cwd?: string
}

export interface Host {
  id: string
  groupId: string | null
  alias: string
  protocol: Protocol
  host: string
  port: number
  username: string
  authType: AuthType
  credentialId?: string | null
  jumpHostId?: string | null
  /** jumpHostId 대신 이 서버 안에 직접 적은 베스천 */
  jump?: InlineJump | null
  /** 이 PC 에서 서버(점프 호스트를 쓰면 첫 번째 베스천)로 갈 때 거치는 프록시 — SSH·텔넷 */
  proxy?: ProxyConfig | null
  color?: string
  env?: Env
  tags: string[]
  encoding: Encoding
  termType: string
  /** 키 입력 코드 — 없으면 리눅스 기본값(DEFAULT_KEYS) */
  keys?: KeyOptions
  /** 고른 터미널 템플릿 id — 값이 같은 템플릿이 여럿일 때 표시용 */
  terminalPreset?: string
  /** 서버 기본 터미널 테마 — 비우면 앱 설정을 따른다. 서버와 함께 동기화 */
  terminalTheme?: string
  startupCommand?: string
  keepaliveSec: number
  forwards: PortForward[]
  serial?: SerialOptions
  local?: LocalOptions
  /** 세션 유지 — 접속하면 tmux 세션에 붙는다. 앱을 꺼도 안의 프로그램이 계속 돈다 */
  persist?: boolean
  /** tmux 세션 이름(비우면 별칭·폴더에서 만든다) */
  persistName?: string
  /** tmux 마우스 모드 — 지정하지 않으면 켠다 */
  persistMouse?: boolean
  notes?: string
  favorite?: boolean
  lastUsedAt?: number
  sort: number
}

export interface Snippet {
  id: string
  name: string
  body: string
  sendEnter: boolean
}

export interface KnownHost {
  hostPort: string // host:port
  keyType: string
  fingerprint: string // SHA256:base64
  addedAt: number
}

export interface Settings {
  theme: 'dark' | 'light'
  terminalTheme: string
  fontFamily: string
  fontSize: number
  lineHeight: number
  cursorStyle: 'block' | 'bar' | 'underline'
  cursorBlink: boolean
  scrollback: number
  copyOnSelect: boolean
  rightClickPaste: boolean
  ctrlVPaste: boolean
  confirmMultilinePaste: boolean
  /** Shift+Enter → LF(Ctrl+J): Claude Code·Codex CLI 등에서 줄바꿈 */
  shiftEnterNewline: boolean
  /** OSC 52: 서버 프로그램(tmux, vim, Claude Code 등)이 클립보드에 복사 */
  osc52Clipboard: boolean
  guardDangerousOnProd: boolean
  dangerousPatterns: string[]
  autoReconnect: boolean
  autoLockMinutes: number
  uploadDir: string
  uploadCleanupDays: number
  insertPathQuote: boolean
  sessionLog: boolean
  bell: boolean
  sidebarWidth: number
  rightPanelWidth: number
  /** 시작할 때 지난 탭·분할 다시 열기 */
  restoreTabs: boolean
  /** 창 크기·위치 기억 */
  rememberWindow: boolean
  /** 새 버전이 나오면 상태 표시줄에 알림 (GitHub 릴리스 확인) */
  checkUpdates: boolean
}

/** 지금 쓰는 것보다 새 버전 — url 은 GitHub 릴리스 페이지 */
export interface UpdateInfo { version: string; url: string }

export interface GitSyncConfig { enabled: boolean; remote: string; branch: string }
export interface GitSyncStatus {
  config: GitSyncConfig
  state: 'disabled' | 'idle' | 'syncing' | 'synced' | 'locked' | 'conflict' | 'password-required' | 'error'
  message: string
  lastSync?: number
}

/** 앱을 다시 켤 때 복원할 탭·분할 — 창마다 서버 id 또는 로컬 시작 폴더만 기억한다 */
/** plain: 세션 유지 서버를 tmux 없이 일반 접속으로 연 창 */
export type SavedPane = { hostId: string; tmux?: string; plain?: boolean } | { local: { cwd?: string } }

export interface SessionMetrics {
  pingMs: number | null
  uptimeSec: number | null
  cpu: number | null
  memory: number | null
  disk: number | null
}
export type SavedLayout =
  | { type: 'pane'; pane: SavedPane; color?: string; terminalTheme?: string }
  | { type: 'split'; dir: 'row' | 'col'; sizes: number[]; children: SavedLayout[] }
export interface SavedTab { title?: string; color?: string; root: SavedLayout; focused: number; zoomed?: number | null }
export interface SavedWorkspace { tabs: SavedTab[]; active: number; savedAt: number }

export interface StoreData {
  version: number
  groups: Group[]
  hosts: Host[]
  snippets: Snippet[]
  knownHosts: KnownHost[]
  settings: Settings
  workspace?: SavedWorkspace
}

export interface CredentialMeta {
  id: string
  name: string
  kind: 'password' | 'key'
  username?: string
  updatedAt: number
}

export interface CredentialSecret {
  username?: string
  password?: string
  privateKey?: string
  passphrase?: string
}

export interface CredentialInput extends CredentialSecret {
  id?: string
  name: string
  kind: 'password' | 'key'
}

export interface VaultStatus {
  initialized: boolean
  unlocked: boolean
  osUnlockAvailable: boolean
  osUnlockEnabled: boolean
  osUnlockKind?: 'windows' | 'touchid' | 'keychain' | 'linux'
}

export type SessionState = 'connecting' | 'connected' | 'reconnecting' | 'closed' | 'error'

export interface SessionInfo {
  id: string
  hostId: string | null
  title: string
  protocol: Protocol
  target: string // user@host:port or COM3@115200
  color?: string
  env?: Env
  state: SessionState
  connectedAt?: number
  message?: string
  canSftp: boolean
  /** 세션 유지(tmux) 로 연 창 */
  persist?: boolean
  /** 붙은 tmux 세션 이름(SSH) — 재접속·탭 복원 때 같은 세션으로 */
  tmuxSession?: string
  /** tmux 에 붙어 있을 때 지금 마우스 모드 — 붙지 않았으면 없다 */
  tmuxMouse?: boolean
}

/** 세션 유지 창을 열 때 tmux 세션 고르기 — name: 그 세션에, 'auto': 묻지 않고 쉬는 세션에(없으면 새로), 'none': tmux 없이 일반 접속, 없으면 물어본다 */
export type TmuxPick = { name: string } | 'auto' | 'none'

export interface TmuxSessionInfo {
  name: string
  /** 만든 시각 (ms) */
  created: number
  /** 마지막 활동 (ms) */
  activity: number
  /** 붙어 있는 클라이언트 수 — 0 이 아니면 다른 창에서 보고 있다 */
  attached: number
  /** 활성 창에서 돌고 있는 프로그램 */
  command: string
}

/** 서버 확인 결과 — tmux 유무와, 없을 때 터미널에 넣어 줄 설치 명령 */
export interface TmuxCheck {
  installed: boolean
  version?: string
  os?: string
  /** 배포판에 맞는 설치 명령. 알 수 없으면 없음 */
  installCommand?: string
  /** root 도 아니고 sudo 도 없을 때 */
  needsAdmin?: boolean
}

export interface AdhocTarget {
  host: string
  /** protocol 'local' 일 때 시작 폴더 */
  cwd?: string
  port?: number
  username?: string
  protocol?: Protocol
}

export interface SftpEntry {
  name: string
  path: string
  isDir: boolean
  isLink: boolean
  size: number
  mtime: number
  mode: number
  perm: string
}

export interface Transfer {
  id: string
  sessionId: string
  name: string
  direction: 'up' | 'down'
  bytes: number
  total: number
  state: 'queued' | 'running' | 'done' | 'error' | 'canceled'
  error?: string
  remotePath: string
  localPath?: string
}

export type UiRequest =
  | { reqId: string; kind: 'hostkey'; sessionTitle: string; hostPort: string; keyType: string; fingerprint: string; changed: boolean; oldFingerprint?: string }
  | { reqId: string; kind: 'password'; sessionTitle: string; prompt: string; username: string; allowSave: boolean; failed?: boolean }
  | { reqId: string; kind: 'keyboard'; sessionTitle: string; name: string; instructions: string; prompts: { prompt: string; echo: boolean }[] }
  | { reqId: string; kind: 'passphrase'; sessionTitle: string }
  | { reqId: string; kind: 'username'; sessionTitle: string }
  | { reqId: string; kind: 'tmux'; sessionTitle: string; sessions: TmuxSessionInfo[] }

export interface ImportCandidate {
  source: 'putty' | 'ssh-config' | 'aws'
  name: string
  host: Partial<Host>
  keyFile?: string
  /** 점프 호스트의 주소 — 같이 가져오는 후보나 이미 있는 서버 중 host 가 같은 것으로 잇는다 */
  jumpVia?: string
  note?: string
}

/** 이 PC 의 ~/.ssh/*.pub — 서버에 등록할 키 후보 */
export interface LocalPublicKey {
  name: string
  path: string
  type: string
  comment: string
  fingerprint: string
  /** 같은 이름의 개인 키 파일이 옆에 있다 */
  hasPrivate: boolean
}

export interface ClipboardInfo {
  type: 'image' | 'files' | 'text' | 'empty'
  text?: string
  files?: string[]
  imageSize?: { width: number; height: number }
}

export const LINUX_FONT_FAMILY = "'D2Coding ligature', 'D2Coding', 'DejaVu Sans Mono', 'Noto Sans Mono', 'Noto Sans CJK KR', monospace"

export const MAC_FONT_FAMILY = "'D2Coding ligature', 'D2Coding', Menlo, 'Apple SD Gothic Neo', monospace"

export const DEFAULT_SETTINGS: Settings = {
  theme: 'dark',
  terminalTheme: 'BrightTerm Dark',
  fontFamily: "'D2Coding ligature', 'D2Coding', 'Cascadia Mono', Consolas, 'Malgun Gothic', monospace",
  fontSize: 14,
  lineHeight: 1.15,
  cursorStyle: 'block',
  cursorBlink: true,
  scrollback: 10000,
  copyOnSelect: true,
  rightClickPaste: true,
  ctrlVPaste: true,
  confirmMultilinePaste: true,
  shiftEnterNewline: true,
  osc52Clipboard: true,
  guardDangerousOnProd: true,
  dangerousPatterns: ['rm\\s+-[a-zA-Z]*r[a-zA-Z]*f', 'rm\\s+-[a-zA-Z]*f[a-zA-Z]*r', '\\breboot\\b', '\\bshutdown\\b', '\\bhalt\\b', '\\bpoweroff\\b', 'mkfs', 'dd\\s+if=', '\\bDROP\\s+(TABLE|DATABASE)\\b', '\\bTRUNCATE\\b', 'systemctl\\s+(stop|restart)'],
  autoReconnect: true,
  autoLockMinutes: 15,
  uploadDir: '~/.brightterm/uploads',
  uploadCleanupDays: 7,
  insertPathQuote: true,
  sessionLog: false,
  bell: false,
  sidebarWidth: 260,
  rightPanelWidth: 340,
  restoreTabs: true,
  rememberWindow: true,
  checkUpdates: true
}

export const ENV_COLORS: Record<Env, string> = {
  prod: '#ef4444',
  stage: '#f59e0b',
  dev: '#22c55e',
  device: '#3b82f6',
  none: '#64748b'
}

export const ENV_LABELS: Record<Env, string> = {
  prod: '운영',
  stage: '스테이징',
  dev: '개발',
  device: '장비',
  none: '일반'
}

export const PALETTE = ['#ef4444', '#f97316', '#f59e0b', '#eab308', '#22c55e', '#10b981', '#14b8a6', '#06b6d4', '#3b82f6', '#6366f1', '#8b5cf6', '#d946ef', '#ec4899', '#64748b']
