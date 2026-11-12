import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight, ChevronDown, Folder, FolderOpen, Search, Plus, FolderPlus, Download, Star, Terminal, SquareTerminal, Cpu, Radio, Clock, SplitSquareHorizontal, Play, KeyRound, Layers, ArrowLeftRight, MonitorUp } from 'lucide-react'
import { useApp, newHost } from '../state'
import { ENV_COLORS, ENV_LABELS, type Group, type Host, type SessionForward } from '@shared/types'
import { panes } from '../layout'
import { isMac, modKey } from '../platform'
import { focusSession } from '../terms'
import { rdpCapable, rdpOptions } from '@shared/rdp'
import { forwardHealthLabel, forwardHealthStatus, overallForwardHealth } from '../forwardStatus'

export function hostColor(h: Host, groups: Group[]): string | undefined {
  if (h.color) return h.color
  if (h.env && h.env !== 'none') return ENV_COLORS[h.env]
  let gid = h.groupId
  while (gid) {
    const g = groups.find((x) => x.id === gid)
    if (!g) break
    if (g.color) return g.color
    if (g.env && g.env !== 'none') return ENV_COLORS[g.env]
    gid = g.parentId
  }
  return undefined
}

/** Windows 서버 — 마지막 RDP 허용 상태 확인 결과를 색으로 */
function RdpBadge({ hostId, primary }: { hostId: string; primary: boolean }): JSX.Element {
  const check = useApp((s) => s.rdpChecks[hostId])
  const state = check?.state
  const title = check ? `RDP: ${check.message}${check.security ? ` · ${check.security}` : ''}\n${check.route} · ${new Date(check.checkedAt).toLocaleTimeString()}` : `원격 데스크톱(RDP) 서버${primary ? ' — 더블클릭하면 RDP 로 엽니다' : ''}\n우클릭 → RDP 허용 상태 확인`
  return <span className={`n-rdp ${state ? `rdp-${state}` : ''}`} title={title} role="img" aria-label={title}><MonitorUp size={11} /></span>
}

export function ProtoIcon({ p, size = 14 }: { p: Host['protocol']; size?: number }): JSX.Element {
  if (p === 'serial') return <Cpu size={size} />
  if (p === 'telnet') return <Radio size={size} />
  if (p === 'local') return <SquareTerminal size={size} />
  return <Terminal size={size} />
}

/** 목록·툴팁에 쓰는 접속 대상 한 줄 */
export function hostTarget(h: Host, withPort = false): string {
  if (h.protocol === 'serial') return h.serial?.path ?? ''
  if (h.protocol === 'local') return `로컬 · ${h.local?.cwd?.trim() || '~'}`
  return `${h.username ? h.username + '@' : ''}${h.host}${withPort ? ':' + h.port : ''}`
}

/** 비밀번호로 로그인하는 SSH 서버 — 공개키 등록 버튼을 보여준다 */
const loginsWithPassword = (h: Host): boolean => h.protocol === 'ssh' && (h.authType === 'password' || h.authType === 'ask')

function matches(h: Host, q: string, groups: Group[]): boolean {
  if (!q) return true
  const g = groups.find((x) => x.id === h.groupId)?.name ?? ''
  const hay = `${h.alias} ${h.host} ${h.username} ${h.tags.join(' ')} ${g} ${h.notes ?? ''}`.toLowerCase()
  return q.toLowerCase().split(/\s+/).every((t) => hay.includes(t))
}

export function Sidebar(): JSX.Element {
  const { groups, hosts, filter, tabs, sessions, settings } = useApp()
  const [selected, setSelected] = useState<string | null>(null)
  const treeRef = useRef<HTMLDivElement>(null)
  const [cursor, setCursor] = useState<string | null>(null)
  const [dropOn, setDropOn] = useState<string | null>(null)
  const [width, setWidth] = useState(settings.sidebarWidth)
  const dragging = useRef(false)

  const liveCount = useMemo(() => {
    const m: Record<string, number> = {}
    for (const t of tabs) for (const p of panes(t.root)) {
      const s = sessions[p.sessionId]
      if (s?.hostId && s.state === 'connected') m[s.hostId] = (m[s.hostId] ?? 0) + 1
    }
    return m
  }, [tabs, sessions])
  const hostForwards = useMemo(() => {
    const byHost: Record<string, Map<string, SessionForward>> = {}
    for (const session of Object.values(sessions)) {
      if (!session.hostId || session.state !== 'connected' || !session.forwards?.length) continue
      const rules = byHost[session.hostId] ??= new Map()
      for (const forward of session.forwards) {
        const key = JSON.stringify([forward.type, forward.bindHost, forward.bindPort, forward.destHost, forward.destPort])
        const previous = rules.get(key)
        if (!previous || (forward.checkedAt ?? 0) >= (previous.checkedAt ?? 0)) rules.set(key, forward)
      }
    }
    return Object.fromEntries(Object.entries(byHost).map(([id, rules]) => [id, [...rules.values()]]))
  }, [sessions])
  // 끊긴 것까지 포함해 패널이 하나라도 있는 서버 — 더블클릭 때 새로 열지 판단
  const openIds = useMemo(() => new Set(tabs.flatMap((t) => panes(t.root).map((p) => sessions[p.sessionId]?.hostId).filter(Boolean))), [tabs, sessions])

  // 패널을 옮기면 사이드바 선택도 따라간다
  const focusedHost = useApp((s) => {
    const tab = s.tabs.find((t) => t.id === s.activeTab)
    const p = tab && panes(tab.root).find((x) => x.id === tab.focused)
    return (p && s.sessions[p.sessionId]?.hostId) ?? null
  })
  useEffect(() => {
    if (!focusedHost) return
    setSelected(focusedHost)
    setCursor(`sb-host-${focusedHost}`)
    document.querySelector(`.sidebar [data-host="${focusedHost}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [focusedHost])

  const q = filter.trim()
  const visibleHosts = hosts.filter((h) => matches(h, q, groups))
  const favorites = hosts.filter((h) => h.favorite)
  const recent = [...hosts].filter((h) => h.lastUsedAt).sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0)).slice(0, 5)

  const st = useApp.getState
  const moveHost = (hostId: string, groupId: string | null): void => {
    const h = hosts.find((x) => x.id === hostId)
    if (h && h.groupId !== groupId) st().upsertHost({ ...h, groupId })
  }
  const moveGroup = (gid: string, parentId: string | null): void => {
    if (gid === parentId) return
    // prevent cycles
    let p = parentId
    while (p) {
      if (p === gid) return
      p = groups.find((g) => g.id === p)?.parentId ?? null
    }
    const g = groups.find((x) => x.id === gid)
    if (g) st().upsertGroup({ ...g, parentId })
  }

  const hostMenu = (e: React.MouseEvent, h: Host): void => {
    e.preventDefault()
    setSelected(h.id)
    const rdp = rdpCapable(h)
    const primary = rdp && !!h.rdp?.primary
    st().showMenu(e, [
      ...(rdp ? [
        { label: '원격 데스크톱(RDP) 연결', shortcut: primary ? 'Enter' : undefined, onClick: () => void st().openRdp(h.id) },
        ...(rdpOptions(h).mode === 'builtin' ? [{ label: rdpOptions(h).openIn === 'window' ? '원격 데스크톱을 탭으로 열기' : '원격 데스크톱을 별도 창으로 열기', onClick: () => void st().openRdp(h.id, rdpOptions(h).openIn === 'window' ? 'tab' as const : 'window' as const) }] : []),
        { label: 'RDP 허용 상태 확인', onClick: () => void st().checkRdp(h.id) }
      ] : []),
      { label: rdp ? '터미널로 연결' : '새 탭에서 연결', shortcut: primary ? undefined : 'Enter', onClick: () => st().openHost(h.id, 'tab', undefined, undefined, true) },
      { label: '오른쪽으로 분할해 연결', onClick: () => st().openHost(h.id, 'row') },
      { label: '아래로 분할해 연결', onClick: () => st().openHost(h.id, 'col') },
      ...(h.persist && (h.protocol === 'ssh' || h.protocol === 'local') ? [{ label: '세션 유지 없이 연결 (일반 접속)', onClick: () => st().openHost(h.id, 'tab', undefined, 'none') }] : []),
      { separator: true },
      { label: '편집', shortcut: 'F2', onClick: () => useApp.setState({ dialog: { kind: 'host', host: h } }) },
      { label: '복제', onClick: () => st().upsertHost({ ...structuredClone(h), id: crypto.randomUUID(), alias: h.alias + ' (복사본)', lastUsedAt: undefined }) },
      { label: h.favorite ? '즐겨찾기 해제' : '즐겨찾기', onClick: () => st().upsertHost({ ...h, favorite: !h.favorite }) },
      ...(loginsWithPassword(h) ? [{ label: 'SSH 키 등록…', onClick: () => useApp.setState({ dialog: { kind: 'sshKey', hostId: h.id } }) }] : []),
      { label: '주소 복사', onClick: () => navigator.clipboard.writeText(`${h.username ? h.username + '@' : ''}${h.host}`) },
      { separator: true },
      { label: '삭제', danger: true, onClick: async () => { if (await st().confirm({ title: '서버 삭제', message: `"${h.alias}"을(를) 삭제할까요?`, okText: '삭제', danger: true })) st().removeHosts([h.id]) } }
    ])
  }

  const groupMenu = (e: React.MouseEvent, g: Group): void => {
    e.preventDefault()
    e.stopPropagation()
    st().showMenu(e, [
      { label: '폴더 전체를 그리드로 열기', onClick: () => st().openGroupGrid(g.id) },
      { separator: true },
      { label: '이 폴더에 새 서버', onClick: () => useApp.setState({ dialog: { kind: 'host', groupId: g.id } }) },
      { label: '하위 폴더 만들기', onClick: () => useApp.setState({ dialog: { kind: 'group', parentId: g.id } }) },
      { label: '폴더 편집 (이름·색·환경)', onClick: () => useApp.setState({ dialog: { kind: 'group', group: g } }) },
      { separator: true },
      { label: '폴더 삭제 (서버는 상위로 이동)', danger: true, onClick: async () => { if (await st().confirm({ title: '폴더 삭제', message: `"${g.name}" 폴더를 삭제할까요? 안의 서버는 상위 폴더로 옮겨집니다.`, okText: '삭제', danger: true })) st().removeGroup(g.id) } }
    ])
  }

  // Keep focus on the container because nested row components remount on updates.
  const rows = (): HTMLElement[] => Array.from(treeRef.current?.querySelectorAll<HTMLElement>('[data-nav]') ?? [])
  const selectRow = (row: HTMLElement | undefined): void => {
    if (!row) return
    setCursor(row.id)
    setSelected(row.dataset.server ?? null)
    treeRef.current?.focus({ preventScroll: true })
    row.scrollIntoView({ block: 'nearest' })
  }
  useEffect(() => {
    const items = rows()
    if (!items.some((row) => row.id === cursor)) {
      setCursor((items.find((row) => row.dataset.server === selected) ?? items[0])?.id ?? null)
    }
  })

  const onKey = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.target !== e.currentTarget || e.nativeEvent.isComposing || st().menu || st().dialog || st().confirmReq) return
    const items = rows()
    const index = items.findIndex((row) => row.id === cursor)
    const row = items[index]
    const plain = !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey
    if (plain && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
      e.preventDefault()
      e.stopPropagation()
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1
        : index < 0 ? (e.key === 'ArrowDown' ? 0 : items.length - 1)
        : Math.max(0, Math.min(items.length - 1, index + (e.key === 'ArrowDown' ? 1 : -1)))
      selectRow(items[next])
      return
    }
    if (plain && e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      document.getElementById('sidebar-search')?.focus()
      return
    }
    const g = groups.find((g) => g.id === row?.dataset.group)
    if (plain && ['ArrowLeft', 'ArrowRight', 'Enter', ' '].includes(e.key) && g) {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Enter' || e.key === ' ') { if (!e.repeat) st().upsertGroup({ ...g, collapsed: !g.collapsed }) }
      else if (e.key === 'ArrowRight') {
        if (g.collapsed && !q) st().upsertGroup({ ...g, collapsed: false })
        else if (items[index + 1]?.dataset.parent === g.id) selectRow(items[index + 1])
      } else if (!g.collapsed && !q) st().upsertGroup({ ...g, collapsed: true })
      else selectRow(items.find((item) => item.dataset.group === g.parentId))
      return
    }
    if (plain && e.key === 'ArrowLeft' && row?.dataset.parent) {
      e.preventDefault()
      e.stopPropagation()
      selectRow(items.find((item) => item.dataset.group === row.dataset.parent))
      return
    }
    const h = hosts.find((h) => h.id === row?.dataset.server)
    if (!h || e.altKey || !['Enter', 'F2', 'Delete'].includes(e.key)) return
    if (e.key !== 'Enter' && !plain) return
    e.preventDefault()
    e.stopPropagation()
    if (e.repeat) return
    if (e.key === 'Enter') st().openHost(h.id, modKey(e) ? 'row' : e.shiftKey ? 'col' : 'tab')
    if (e.key === 'F2') useApp.setState({ dialog: { kind: 'host', host: h } })
    if (e.key === 'Delete') {
      st().confirm({ title: '서버 삭제', message: `"${h.alias}"을(를) 삭제할까요?`, okText: '삭제', danger: true }).then((ok) => ok && st().removeHosts([h.id]))
    }
  }

  const HostNode = ({ h, depth, section }: { h: Host; depth: number; section?: string }): JSX.Element => {
    const navId = `sb-${section ?? 'host'}-${h.id}`
    const color = hostColor(h, groups)
    const live = liveCount[h.id]
    const forwards = hostForwards[h.id] ?? []
    const health = overallForwardHealth(forwards)
    const forwardTitle = `포트 포워딩 ${forwardHealthLabel[health]} ${forwards.length}개\n` + forwards.map((f) => `${f.type} ${f.bindHost || '127.0.0.1'}:${f.bindPort} → ${f.destHost}:${f.destPort} · ${forwardHealthLabel[forwardHealthStatus(f)]}${f.error || f.healthError ? ` (${f.error || f.healthError})` : ''}`).join('\n')
    return (
      <div
        id={navId}
        data-nav
        data-server={h.id}
        data-parent={section ? undefined : h.groupId ?? undefined}
        role="treeitem"
        aria-level={depth + 1}
        aria-selected={cursor === navId}
        aria-label={h.alias || h.host}
        className={`node ${selected === h.id && !section ? 'selected' : ''} ${cursor === navId ? 'keyboard-cursor' : ''}`}
        style={{ paddingLeft: 6 + depth * 14 }}
        draggable={!section}
        onDragStart={(e) => e.dataTransfer.setData('bt/host', h.id)}
        data-host={section ? undefined : h.id}
        onClick={(e) => {
          selectRow(e.currentTarget)
          // 이미 그 창이 선택돼 있으면 상태가 안 바뀌어 포커스가 사이드바에 남는다 — 키 입력(특히 Enter=새로 열기)이 새지 않게 터미널로 직접 옮긴다
          if (st().revealHost(h.id)) requestAnimationFrame(() => { const id = st().focusedSession()?.id; if (id) focusSession(id) })
        }}
        onDoubleClick={() => { if (!openIds.has(h.id)) st().openHost(h.id) }}
        onContextMenu={(e) => hostMenu(e, h)}
        title={`${h.alias}\n${hostTarget(h, true)}${h.notes ? '\n' + h.notes : ''}`}
      >
        <span className="chev" />
        <span className="color-bar" style={{ background: color ?? 'transparent' }} />
        <span className="proto"><ProtoIcon p={h.protocol} size={13} /></span>
        <span className="n-label">{h.alias || h.host}</span>
        {h.persist && (h.protocol === 'ssh' || h.protocol === 'local') && <span className="n-persist" title="세션 유지(tmux) — 창을 닫아도 안의 프로그램이 계속 돕니다"><Layers size={11} /></span>}
        {rdpCapable(h) && <RdpBadge hostId={h.id} primary={!!h.rdp?.primary} />}
        <span className="n-sub">{h.protocol === 'serial' ? h.serial?.path : h.protocol === 'local' ? h.local?.cwd?.trim() || '~' : h.host}</span>
        {live ? <span className="n-live"><span className="dot connected" style={{ width: 6, height: 6 }} />{live > 1 ? live : ''}</span> : null}
        {!!forwards.length && <span className={`n-forward forward-health forward-${health}`} role="img" aria-label={`포트 포워딩 ${forwardHealthLabel[health]} ${forwards.length}개`} title={forwardTitle}>
          <ArrowLeftRight size={13} aria-hidden="true" />
        </span>}
        <span className="n-hover">
          {loginsWithPassword(h) && <button className="ibtn sm" title="SSH 키 등록" onClick={(e) => { e.stopPropagation(); useApp.setState({ dialog: { kind: 'sshKey', hostId: h.id } }) }}><KeyRound size={13} /></button>}
          <button className="ibtn sm" title="분할로 연결" onClick={(e) => { e.stopPropagation(); st().openHost(h.id, 'row') }}><SplitSquareHorizontal size={13} /></button>
          {rdpCapable(h) && <button className="ibtn sm" title="원격 데스크톱(RDP) 연결" onClick={(e) => { e.stopPropagation(); void st().openRdp(h.id) }}><MonitorUp size={13} /></button>}
          <button className="ibtn sm" title={h.rdp?.primary && rdpCapable(h) ? '원격 데스크톱(RDP) 연결' : '연결'} onClick={(e) => { e.stopPropagation(); st().openHost(h.id) }}><Play size={13} /></button>
        </span>
      </div>
    )
  }

  const countIn = (gid: string): number => {
    const sub = groups.filter((g) => g.parentId === gid)
    return visibleHosts.filter((h) => h.groupId === gid).length + sub.reduce((a, g) => a + countIn(g.id), 0)
  }

  const GroupNode = ({ g, depth }: { g: Group; depth: number }): JSX.Element | null => {
    const n = countIn(g.id)
    if (q && n === 0) return null
    const open = q ? true : !g.collapsed
    const color = g.color ?? (g.env && g.env !== 'none' ? ENV_COLORS[g.env] : undefined)
    const children = groups.filter((x) => x.parentId === g.id).sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name))
    const hs = visibleHosts.filter((h) => h.groupId === g.id).sort((a, b) => a.sort - b.sort || a.alias.localeCompare(b.alias))
    return (
      <>
        <div
          id={`sb-group-${g.id}`}
          data-nav
          data-group={g.id}
          data-parent={g.parentId ?? undefined}
          role="treeitem"
          aria-level={depth + 1}
          aria-expanded={open}
          aria-selected={cursor === `sb-group-${g.id}`}
          aria-label={g.name}
          className={`node ${dropOn === g.id ? 'drop' : ''} ${cursor === `sb-group-${g.id}` ? 'keyboard-cursor' : ''}`}
          style={{ paddingLeft: 6 + depth * 14 }}
          draggable
          onDragStart={(e) => e.dataTransfer.setData('bt/group', g.id)}
          onDragOver={(e) => { e.preventDefault(); setDropOn(g.id) }}
          onDragLeave={() => setDropOn(null)}
          onDrop={(e) => {
            e.preventDefault()
            e.stopPropagation()
            setDropOn(null)
            const hid = e.dataTransfer.getData('bt/host')
            const gid = e.dataTransfer.getData('bt/group')
            if (hid) moveHost(hid, g.id)
            if (gid) moveGroup(gid, g.id)
          }}
          onClick={(e) => { selectRow(e.currentTarget); st().upsertGroup({ ...g, collapsed: !g.collapsed }) }}
          onDoubleClick={(e) => e.preventDefault()}
          onContextMenu={(e) => groupMenu(e, g)}
        >
          <span className="chev">{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</span>
          <span style={{ color: color ?? 'var(--text-3)', display: 'grid' }}>{open ? <FolderOpen size={14} /> : <Folder size={14} />}</span>
          <span className="n-label" style={{ fontWeight: 600 }}>{g.name}</span>
          {g.env && g.env !== 'none' && <span className="pill" style={{ background: ENV_COLORS[g.env] + '26', color: ENV_COLORS[g.env] }}>{ENV_LABELS[g.env]}</span>}
          <span className="n-count">{n}</span>
          <span className="n-hover">
            <button className="ibtn sm" title="폴더 전체 그리드로 열기" onClick={(e) => { e.stopPropagation(); st().openGroupGrid(g.id) }}><Play size={13} /></button>
          </span>
        </div>
        {open && children.map((c) => <GroupNode key={c.id} g={c} depth={depth + 1} />)}
        {open && hs.map((h) => <HostNode key={h.id} h={h} depth={depth + 1} />)}
      </>
    )
  }

  const roots = groups.filter((g) => !g.parentId).sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name))
  const loose = visibleHosts.filter((h) => !h.groupId || !groups.some((g) => g.id === h.groupId)).sort((a, b) => a.sort - b.sort || a.alias.localeCompare(b.alias))

  const startResize = (e: React.MouseEvent): void => {
    dragging.current = true
    const x0 = e.clientX
    const w0 = width
    const move = (ev: MouseEvent): void => setWidth(Math.max(200, Math.min(520, w0 + ev.clientX - x0)))
    const up = (ev: MouseEvent): void => {
      dragging.current = false
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      st().setSettings({ sidebarWidth: Math.max(200, Math.min(520, w0 + ev.clientX - x0)) })
      window.dispatchEvent(new Event('resize'))
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  return (
    <aside className="sidebar" style={{ width }}>
      <div className="sb-head">
        <div className="search">
          <Search size={15} />
          <input id="sidebar-search" className="input" aria-label="서버 검색" placeholder="서버 검색" value={filter} onChange={(e) => useApp.setState({ filter: e.target.value })}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault()
                e.stopPropagation()
                const items = rows()
                selectRow(e.key === 'ArrowDown' ? items[0] : items[items.length - 1])
              }
              if (e.key === 'Enter') {
                e.preventDefault()
                e.stopPropagation()
                if (e.repeat) return
                const first = rows().find((row) => row.dataset.server)
                if (first?.dataset.server) st().openHost(first.dataset.server, modKey(e) ? 'row' : e.shiftKey ? 'col' : 'tab')
              }
              if (e.key === 'Escape') { e.preventDefault(); useApp.setState({ filter: '' }) }
            }} />
        </div>
        <div className="sb-actions">
          <button className="btn" onClick={() => useApp.setState({ dialog: { kind: 'host', host: undefined, groupId: null } })}><Plus size={14} />서버</button>
          <button className="btn" onClick={() => useApp.setState({ dialog: { kind: 'group', parentId: null } })}><FolderPlus size={14} />폴더</button>
          <button className="btn" onClick={() => useApp.setState({ dialog: { kind: 'import' } })} title={isMac ? 'SSH config / PuTTY 세션 가져오기' : 'PuTTY / SSH config 가져오기'}><Download size={14} />가져오기</button>
        </div>
      </div>
      <div
        className="tree"
        ref={treeRef}
        role="tree"
        aria-label="서버 목록"
        aria-activedescendant={cursor ?? undefined}
        tabIndex={0}
        onKeyDown={onKey}
        onFocus={(e) => {
          if (e.target === e.currentTarget) selectRow(rows().find((row) => row.id === cursor) ?? rows()[0])
        }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          const hid = e.dataTransfer.getData('bt/host')
          const gid = e.dataTransfer.getData('bt/group')
          if (hid) moveHost(hid, null)
          if (gid) moveGroup(gid, null)
        }}
      >
        {!q && favorites.length > 0 && (
          <>
            <div className="sec-title"><Star size={11} /> 즐겨찾기</div>
            {favorites.map((h) => <HostNode key={'f' + h.id} h={h} depth={0} section="fav" />)}
          </>
        )}
        {!q && recent.length > 0 && hosts.length > 6 && (
          <>
            <div className="sec-title"><Clock size={11} /> 최근 접속</div>
            {recent.map((h) => <HostNode key={'r' + h.id} h={h} depth={0} section="recent" />)}
          </>
        )}
        <div className="sec-title">서버 {hosts.length > 0 && <span style={{ fontWeight: 500 }}>· {hosts.length}</span>}</div>
        {roots.map((g) => <GroupNode key={g.id} g={g} depth={0} />)}
        {loose.map((h) => <HostNode key={h.id} h={h} depth={0} />)}
        {hosts.length === 0 && (
          <div className="empty">
            아직 저장된 서버가 없습니다.<br />
            <b>+ 서버</b>로 추가하거나<br /><b>가져오기</b>로 {isMac ? '~/.ssh/config' : 'PuTTY 세션'}을 불러오세요.
          </div>
        )}
        {hosts.length > 0 && q && visibleHosts.length === 0 && <div className="empty">"{q}"와 일치하는 서버가 없습니다</div>}
      </div>
      <div className={`sb-resize ${dragging.current ? 'drag' : ''}`} onMouseDown={startResize} />
    </aside>
  )
}

export { newHost }
