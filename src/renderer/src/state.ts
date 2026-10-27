import { create } from 'zustand'
import type { CredentialMeta, Group, Host, SessionInfo, Settings, Snippet, StoreData, Transfer, UiRequest, VaultStatus, AdhocTarget, TmuxPick } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/types'
import { api } from './api'
import { LayoutNode, PaneNode, uid, panes, splitPane, removePane, grid, Dir, findPane, setPaneColor, setPaneTheme, insertNode, type Side } from './layout'

export interface Tab {
  id: string
  root: LayoutNode
  focused: string // pane id
  broadcast: boolean
  title?: string
  /** 사용자가 탭에 직접 지정한 색 — 없으면 포커스된 패널 색을 따른다 */
  color?: string
  zoomed?: string | null
}

/** 패널·탭을 다른 탭으로 옮기는 자리 — paneId 가 없으면 그 탭 전체의 side 끝에 */
export interface DockTarget { tabId: string; paneId?: string; side?: Side }

/** 탭 이름 — 직접 지은 이름이 없으면 포커스된 패널의 서버 이름 */
export function tabTitle(t: Tab): string {
  const p = findPane(t.root, t.focused) ?? panes(t.root)[0]
  return t.title || useApp.getState().sessions[p.sessionId]?.title || '세션'
}

/** 옮겨 갈 수 있는 다른 탭들을 메뉴 항목으로 — 누르면 그 탭의 오른쪽 끝에 붙는다 */
export function dockMenu(heading: string, exceptTabId: string | null, onPick: (tabId: string) => void): MenuItem[] {
  const others = useApp.getState().tabs.filter((t) => t.id !== exceptTabId)
  if (!others.length) return []
  return [{ heading }, ...others.map((t) => ({ label: `${tabTitle(t)}${panes(t.root).length > 1 ? ` (${panes(t.root).length})` : ''}`, onClick: () => onPick(t.id) }))]
}

/** 끌고 있는 탭·패널 — dragover 에서는 dataTransfer 를 읽을 수 없어 상태에 둔다 */
export type DragItem = { kind: 'tab'; tabId: string } | { kind: 'pane'; paneId: string }

export interface MenuItem {
  /** 메뉴 안의 작은 제목 줄(누를 수 없음) */
  heading?: string
  label?: string
  shortcut?: string
  danger?: boolean
  disabled?: boolean
  separator?: boolean
  /** 색 고르기 줄 — value 가 지금 색, undefined 는 자동 */
  colors?: { value?: string; onPick: (c?: string) => void }
  onClick?: () => void
}

export interface ConfirmReq {
  title: string
  message: string
  detail?: string
  okText?: string
  danger?: boolean
  /** 있으면 확인 버튼 옆에 버튼을 하나 더 둔다 — 누르면 'alt' */
  altText?: string
  resolve: (ok: boolean | 'alt') => void
}

/** 닫기 확인 결과 — killTmux: 세션 유지 창의 tmux 세션도 서버에서 끝낸다 */
export interface CloseChoice { killTmux: boolean }

export interface Toast { id: string; kind: 'ok' | 'error' | 'info'; text: string }

type Dialog =
  | { kind: 'host'; host?: Host; groupId?: string | null }
  | { kind: 'group'; group?: Group; parentId?: string | null }
  | { kind: 'settings'; section?: string }
  | { kind: 'import' }
  | { kind: 'sshKey'; hostId: string }
  | { kind: 'quick' }
  | { kind: 'preview'; sessionId: string; path: string }
  | null

interface State {
  loaded: boolean
  groups: Group[]
  hosts: Host[]
  snippets: Snippet[]
  settings: Settings
  creds: CredentialMeta[]
  vault: VaultStatus
  sessions: Record<string, SessionInfo>
  tabs: Tab[]
  activeTab: string | null
  activity: Record<string, boolean>
  transfers: Record<string, Transfer>
  requests: UiRequest[]
  confirmReq: ConfirmReq | null
  /** 끌고 있는 탭·패널 */
  drag: DragItem | null
  promptReq: { title: string; label?: string; value: string; resolve: (v: string | null) => void } | null
  menu: { x: number; y: number; items: MenuItem[] } | null
  toasts: Toast[]
  dialog: Dialog
  sidebar: boolean
  rightPanel: 'sftp' | 'snippets' | null
  filter: string

  init(): Promise<void>
  reloadStore(): Promise<void>
  refreshCreds(): Promise<void>
  save(p: Partial<StoreData>): void
  setSettings(p: Partial<Settings>): void
  upsertHost(h: Host): void
  removeHosts(ids: string[]): void
  upsertGroup(g: Group): void
  removeGroup(id: string): void

  /** run: 세션 유지 없이 접속해 그 명령만 입력(서버에 tmux 설치 등). tmux 'none': 세션 유지 서버를 일반 접속으로 */
  openHost(hostId: string, where?: 'tab' | Dir, run?: string, tmux?: TmuxPick): Promise<void>
  /** 이미 열린 세션이 있으면 그 탭·패널로 이동(여러 개면 누를 때마다 다음 것). 없으면 false */
  revealHost(hostId: string): boolean
  /** 포커스된 패널의 서버 id — 사이드바 선택 동기화용 */
  focusedHostId(): string | null
  openAdhoc(t: AdhocTarget, where?: 'tab' | Dir): Promise<void>
  openGroupGrid(groupId: string): Promise<void>
  /** choice 가 없으면 서버에 연결된 세션을 닫기 전에 확인한다 */
  closePane(paneId: string, tabId?: string, choice?: CloseChoice): Promise<void>
  closeTab(tabId: string, choice?: CloseChoice): Promise<void>
  /** 서버에 연결된 세션이 있으면 닫을지(세션 유지 창이면 tmux 세션도 끝낼지) 묻는다. 취소하면 null */
  confirmCloseSessions(sessionIds: string[], title: string): Promise<CloseChoice | null>
  focusPane(tabId: string, paneId: string): void
  setActiveTab(id: string): void
  updateTab(id: string, p: Partial<Tab>): void
  setPaneColor(tabId: string, paneId: string, color?: string): void
  setPaneTheme(tabId: string, paneId: string, theme?: string): void
  moveTab(from: number, to: number): void
  gatherAll(): void
  splitToTabs(tabId: string): void
  /** 패널을 다른 탭(같은 탭의 다른 자리도)으로 옮긴다. 'newTab' 이면 자기 탭으로 떼어 낸다. 연결은 그대로 */
  movePane(paneId: string, to: DockTarget | 'newTab'): void
  /** 탭의 패널(배치 전체)을 다른 탭 안으로 넣고 원래 탭은 없앤다 */
  mergeTab(srcTabId: string, to: DockTarget): void
  duplicatePane(where: 'tab' | Dir): Promise<void>

  focusedSession(): SessionInfo | null
  tabOfSession(sessionId: string): Tab | undefined

  confirm(o: Omit<ConfirmReq, 'resolve'>): Promise<boolean>
  prompt(title: string, value?: string, label?: string): Promise<string | null>
  toast(kind: Toast['kind'], text: string): void
  showMenu(e: { clientX: number; clientY: number }, items: MenuItem[]): void
}

const newId = (): string => crypto.randomUUID()

export const useApp = create<State>((set, get) => ({
  loaded: false,
  groups: [],
  hosts: [],
  snippets: [],
  settings: DEFAULT_SETTINGS,
  creds: [],
  vault: { initialized: false, unlocked: false, osUnlockAvailable: false, osUnlockEnabled: false },
  sessions: {},
  tabs: [],
  activeTab: null,
  activity: {},
  transfers: {},
  requests: [],
  confirmReq: null,
  drag: null,
  promptReq: null,
  menu: null,
  toasts: [],
  dialog: null,
  sidebar: true,
  rightPanel: null,
  filter: '',

  async init() {
    const [data, vault] = await Promise.all([api.store.get(), api.vault.status()])
    set({ groups: data.groups, hosts: data.hosts, snippets: data.snippets, settings: data.settings, vault, loaded: true })
    await get().refreshCreds()
  },

  async reloadStore() {
    const data = await api.store.get()
    set({ groups: data.groups, hosts: data.hosts, snippets: data.snippets, settings: data.settings })
    await get().refreshCreds()
  },

  async refreshCreds() {
    try {
      set({ creds: await api.cred.list() })
    } catch { /* */ }
  },

  save(p) {
    set(p as Partial<State>)
    api.store.patch(p)
  },

  setSettings(p) {
    const settings = { ...get().settings, ...p }
    get().save({ settings })
  },

  upsertHost(h) {
    const hosts = get().hosts.some((x) => x.id === h.id) ? get().hosts.map((x) => (x.id === h.id ? h : x)) : [...get().hosts, h]
    get().save({ hosts })
  },

  removeHosts(ids) {
    get().save({ hosts: get().hosts.filter((h) => !ids.includes(h.id)) })
  },

  upsertGroup(g) {
    const groups = get().groups.some((x) => x.id === g.id) ? get().groups.map((x) => (x.id === g.id ? g : x)) : [...get().groups, g]
    get().save({ groups })
  },

  removeGroup(id) {
    const { groups, hosts } = get()
    const doomed = new Set<string>([id])
    let changed = true
    while (changed) {
      changed = false
      for (const g of groups) if (g.parentId && doomed.has(g.parentId) && !doomed.has(g.id)) { doomed.add(g.id); changed = true }
    }
    const target = groups.find((g) => g.id === id)?.parentId ?? null
    get().save({
      groups: groups.filter((g) => !doomed.has(g.id)),
      hosts: hosts.map((h) => (h.groupId && doomed.has(h.groupId) ? { ...h, groupId: target } : h))
    })
  },

  async openHost(hostId, where = 'tab', run, tmux) {
    try {
      const info = await api.session.open({ hostId, run, tmux })
      placeSession(info, where)
    } catch (e) {
      get().toast('error', (e as Error).message)
    }
  },

  revealHost(hostId) {
    const s = get()
    const hits: { tab: Tab; pane: PaneNode }[] = []
    for (const tab of s.tabs) for (const pane of panes(tab.root)) if (s.sessions[pane.sessionId]?.hostId === hostId) hits.push({ tab, pane })
    if (!hits.length) return false
    const cur = s.tabs.find((t) => t.id === s.activeTab)
    const at = hits.findIndex((h) => h.tab.id === cur?.id && h.pane.id === cur?.focused)
    // 지금 보고 있는 게 그 서버면 다음 것으로, 아니면 현재 탭 안의 것을 먼저
    const next = at >= 0 ? hits[(at + 1) % hits.length] : hits.find((h) => h.tab.id === cur?.id) ?? hits[0]
    if (next.tab.zoomed && next.tab.zoomed !== next.pane.id) get().updateTab(next.tab.id, { zoomed: next.pane.id })
    get().focusPane(next.tab.id, next.pane.id)
    return true
  },

  focusedHostId() {
    return get().focusedSession()?.hostId ?? null
  },

  async openAdhoc(t, where = 'tab') {
    try {
      const info = await api.session.open({ adhoc: t })
      placeSession(info, where)
    } catch (e) {
      get().toast('error', (e as Error).message)
    }
  },

  async openGroupGrid(groupId) {
    const { hosts, groups } = get()
    const ids = new Set<string>([groupId])
    let changed = true
    while (changed) {
      changed = false
      for (const g of groups) if (g.parentId && ids.has(g.parentId) && !ids.has(g.id)) { ids.add(g.id); changed = true }
    }
    const targets = hosts.filter((h) => h.groupId && ids.has(h.groupId)).sort((a, b) => a.sort - b.sort)
    if (!targets.length) return get().toast('info', '이 폴더에 서버가 없습니다')
    if (targets.length > 16 && !(await get().confirm({ title: '여러 서버 열기', message: `${targets.length}개 서버에 동시에 접속할까요?` }))) return
    const ps: PaneNode[] = []
    for (const h of targets) {
      try {
        // 서버마다 묻지 않고 쉬는 tmux 세션에 붙는다
        const info = await api.session.open({ hostId: h.id, tmux: 'auto' })
        set((s) => ({ sessions: { ...s.sessions, [info.id]: info } }))
        ps.push({ type: 'pane', id: uid(), sessionId: info.id })
      } catch { /* */ }
    }
    if (!ps.length) return
    const tab: Tab = { id: uid(), root: grid(ps), focused: ps[0].id, broadcast: false, title: groups.find((g) => g.id === groupId)?.name }
    set((s) => ({ tabs: [...s.tabs, tab], activeTab: tab.id }))
  },

  async closePane(paneId, tabId, choice) {
    const s = get()
    const tab = s.tabs.find((t) => (tabId ? t.id === tabId : !!findPane(t.root, paneId)))
    if (!tab) return
    const pane = findPane(tab.root, paneId)
    if (!pane) return
    choice ??= (await get().confirmCloseSessions([pane.sessionId], '패널 닫기')) ?? undefined
    if (!choice) return
    api.session.close(pane.sessionId, choice.killTmux)
    const root = removePane(tab.root, paneId)
    set((st) => {
      const sessions = { ...st.sessions }
      delete sessions[pane.sessionId]
      if (!root) {
        const idx = st.tabs.findIndex((t) => t.id === tab.id)
        const tabs = st.tabs.filter((t) => t.id !== tab.id)
        const activeTab = st.activeTab === tab.id ? (tabs[Math.min(idx, tabs.length - 1)]?.id ?? null) : st.activeTab
        return { tabs, activeTab, sessions }
      }
      const focused = tab.focused === paneId ? panes(root)[0].id : tab.focused
      return { tabs: st.tabs.map((t) => (t.id === tab.id ? { ...t, root, focused, zoomed: null } : t)), sessions }
    })
  },

  async closeTab(tabId, choice) {
    const tab = get().tabs.find((t) => t.id === tabId)
    if (!tab) return
    const ps = panes(tab.root)
    choice ??= (await get().confirmCloseSessions(ps.map((p) => p.sessionId), '탭 닫기')) ?? undefined
    if (!choice) return
    for (const p of ps) await get().closePane(p.id, tabId, choice)
  },

  async confirmCloseSessions(sessionIds, title) {
    const live = sessionIds.map((id) => get().sessions[id]).filter((x): x is SessionInfo => !!x && x.state === 'connected' && x.protocol !== 'local')
    if (!live.length) return { killTmux: false }
    const message = live.length === 1 ? `[${live[0].title}] 서버와 연결되어 있습니다. 연결을 끊고 닫을까요?` : `서버 연결 ${live.length}개를 모두 끊고 닫을까요?`
    // 서버의 tmux 세션에 붙은 창은 세션을 남겨 둘지 함께 끝낼지 고른다
    const tmux = live.filter((x) => x.tmuxSession)
    if (!tmux.length) return (await get().confirm({ title, message, okText: '닫기', danger: true })) ? { killTmux: false } : null
    const r = await new Promise<boolean | 'alt'>((resolve) => set({ confirmReq: {
      title,
      message,
      detail: `세션 유지(tmux) ${tmux.map((x) => x.tmuxSession).join(', ')}\n· 유지하고 닫기: 안의 프로그램이 계속 돌고, 다시 열면 그대로 붙습니다.\n· 세션 끝내기: 서버의 tmux 세션과 안의 프로그램까지 모두 끝냅니다.`,
      okText: '유지하고 닫기',
      altText: '세션 끝내기',
      danger: true,
      resolve
    } }))
    return r === false ? null : { killTmux: r === 'alt' }
  },

  focusPane(tabId, paneId) {
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, focused: paneId } : t)), activeTab: tabId }))
    const tab = get().tabs.find((t) => t.id === tabId)
    const p = tab && findPane(tab.root, paneId)
    if (p) set((s) => ({ activity: { ...s.activity, [p.sessionId]: false } }))
  },

  setActiveTab(id) {
    set({ activeTab: id })
    const tab = get().tabs.find((t) => t.id === id)
    if (tab) {
      const act = { ...get().activity }
      for (const p of panes(tab.root)) act[p.sessionId] = false
      set({ activity: act })
    }
  },

  updateTab(id, p) {
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...p } : t)) }))
  },

  setPaneColor(tabId, paneId, color) {
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, root: setPaneColor(t.root, paneId, color) } : t)) }))
  },

  setPaneTheme(tabId, paneId, theme) {
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, root: setPaneTheme(t.root, paneId, theme) } : t)) }))
  },

  moveTab(from, to) {
    set((s) => {
      const tabs = [...s.tabs]
      const [t] = tabs.splice(from, 1)
      tabs.splice(to, 0, t)
      return { tabs }
    })
  },

  gatherAll() {
    const all = get().tabs.flatMap((t) => panes(t.root))
    if (all.length < 2) return
    const tab: Tab = { id: uid(), root: grid(all), focused: all[0].id, broadcast: false, title: '전체 보기' }
    set({ tabs: [tab], activeTab: tab.id })
  },

  splitToTabs(tabId) {
    const tab = get().tabs.find((t) => t.id === tabId)
    if (!tab) return
    const ps = panes(tab.root)
    if (ps.length < 2) return
    const idx = get().tabs.findIndex((t) => t.id === tabId)
    const newTabs: Tab[] = ps.map((p) => ({ id: uid(), root: p, focused: p.id, broadcast: false }))
    set((s) => {
      const tabs = [...s.tabs]
      tabs.splice(idx, 1, ...newTabs)
      return { tabs, activeTab: newTabs[0].id }
    })
  },

  movePane(paneId, to) {
    const s = get()
    const src = s.tabs.find((t) => findPane(t.root, paneId))
    const pane = src && findPane(src.root, paneId)
    if (!src || !pane) return
    if (to === 'newTab' ? src.root.type === 'pane' : to.paneId === paneId) return
    const rest = removePane(src.root, paneId)
    let tabs = s.tabs.flatMap((t) => (t.id !== src.id ? [t] : rest ? [{ ...t, root: rest, focused: t.focused === paneId ? panes(rest)[0].id : t.focused, zoomed: null }] : []))
    let activeTab: string
    if (to === 'newTab') {
      const tab: Tab = { id: uid(), root: pane, focused: pane.id, broadcast: false }
      tabs.splice(s.tabs.findIndex((t) => t.id === src.id) + 1, 0, tab)
      activeTab = tab.id
    } else {
      if (!tabs.some((t) => t.id === to.tabId)) return
      tabs = tabs.map((t) => (t.id === to.tabId ? { ...t, root: insertNode(t.root, to.paneId ?? null, to.side ?? 'right', pane), focused: pane.id, zoomed: null } : t))
      activeTab = to.tabId
    }
    set({ tabs, activeTab })
  },

  mergeTab(srcTabId, to) {
    const s = get()
    const src = s.tabs.find((t) => t.id === srcTabId)
    if (!src || srcTabId === to.tabId || !s.tabs.some((t) => t.id === to.tabId)) return
    const tabs = s.tabs
      .filter((t) => t.id !== srcTabId)
      .map((t) => (t.id === to.tabId ? { ...t, root: insertNode(t.root, to.paneId ?? null, to.side ?? 'right', src.root), focused: src.focused, zoomed: null } : t))
    set({ tabs, activeTab: to.tabId })
  },

  async duplicatePane(where) {
    const info = get().focusedSession()
    if (!info) return
    // 일반 접속으로 연 세션 유지 서버는 복제도 일반 접속으로
    if (info.hostId) return get().openHost(info.hostId, where, undefined, info.persist ? undefined : 'none')
    if (info.protocol === 'local') return get().openAdhoc({ host: '', protocol: 'local', cwd: info.target.replace(/^로컬 · /, '') }, where)
    const m = info.target.match(/^(?:(.+)@)?(.+):(\d+)$/)
    if (m) return get().openAdhoc({ username: m[1], host: m[2], port: +m[3], protocol: info.protocol }, where)
  },

  focusedSession() {
    const s = get()
    const tab = s.tabs.find((t) => t.id === s.activeTab)
    if (!tab) return null
    const p = findPane(tab.root, tab.focused)
    return p ? s.sessions[p.sessionId] ?? null : null
  },

  tabOfSession(sessionId) {
    return get().tabs.find((t) => panes(t.root).some((p) => p.sessionId === sessionId))
  },

  confirm(o) {
    return new Promise((resolve) => set({ confirmReq: { ...o, resolve: (r) => resolve(!!r) } }))
  },

  prompt(title, value = '', label) {
    return new Promise((resolve) => set({ promptReq: { title, value, label, resolve } }))
  },

  toast(kind, text) {
    const id = newId()
    set((s) => ({ toasts: [...s.toasts.slice(-4), { id, kind, text }] }))
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === 'error' ? 6000 : 3500)
  },

  showMenu(e, items) {
    set({ menu: { x: e.clientX, y: e.clientY, items } })
  }
}))

function placeSession(info: SessionInfo, where: 'tab' | Dir): void {
  const st = useApp.getState()
  useApp.setState((s) => ({ sessions: { ...s.sessions, [info.id]: info } }))
  const pane: PaneNode = { type: 'pane', id: uid(), sessionId: info.id }
  const tab = st.tabs.find((t) => t.id === st.activeTab)
  if (where === 'tab' || !tab) {
    const t: Tab = { id: uid(), root: pane, focused: pane.id, broadcast: false }
    useApp.setState((s) => ({ tabs: [...s.tabs, t], activeTab: t.id }))
  } else {
    const root = splitPane(tab.root, tab.focused, where, pane)
    useApp.setState((s) => ({ tabs: s.tabs.map((t) => (t.id === tab.id ? { ...t, root, focused: pane.id, zoomed: null } : t)) }))
  }
}

export function newHost(groupId: string | null = null): Host {
  return {
    id: crypto.randomUUID(),
    groupId,
    alias: '',
    protocol: 'ssh',
    host: '',
    port: 22,
    username: '',
    authType: 'password',
    credentialId: null,
    tags: [],
    encoding: 'utf-8',
    termType: 'xterm-256color',
    keepaliveSec: 30,
    forwards: [],
    sort: Date.now()
  }
}
