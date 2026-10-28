import { useRef, useState } from 'react'
import { X, Plus, PanelLeft, Settings, Lock, Radio, FolderTree, LayoutGrid } from 'lucide-react'
import { useApp, Tab, tabTitle, dockMenu } from '../state'
import { panes, findPane } from '../layout'
import { api } from '../api'
import { SC, isMac } from '../platform'
import logo from '../assets/logo.png'
import { GitSyncIndicator } from './GitSyncIndicator'

function tabInfo(t: Tab): { title: string; color?: string; state: string; count: number; activity: boolean } {
  const st = useApp.getState()
  const ps = panes(t.root)
  const fp = findPane(t.root, t.focused) ?? ps[0]
  const s = st.sessions[fp.sessionId]
  const states = ps.map((p) => st.sessions[p.sessionId]?.state ?? 'closed')
  const state = states.includes('connected') ? (states.every((x) => x === 'connected') ? 'connected' : 'reconnecting') : states.includes('connecting') || states.includes('reconnecting') ? 'connecting' : states.includes('error') ? 'error' : 'closed'
  return {
    title: tabTitle(t),
    color: t.color ?? fp.color ?? s?.color,
    state,
    count: ps.length,
    activity: ps.some((p) => st.activity[p.sessionId])
  }
}

export function TitleBar(): JSX.Element {
  const { tabs, activeTab, sidebar, vault } = useApp()
  useApp((s) => s.sessions)
  useApp((s) => s.activity)
  const [dragIdx, setDragIdx] = useState<number | null>(null)
  const [overIdx, setOverIdx] = useState<number | null>(null)
  const [overNew, setOverNew] = useState(false)
  const drag = useApp((s) => s.drag)
  // 끌면서 다른 탭 위에 잠시 머무르면 그 탭을 연다 — 그 탭의 패널 옆에 놓을 수 있게
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const st = useApp.getState
  const clearHover = (): void => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    hoverTimer.current = null
  }
  const endDrag = (): void => {
    clearHover()
    setDragIdx(null)
    setOverIdx(null)
    setOverNew(false)
    useApp.setState({ drag: null })
  }

  const menu = (e: React.MouseEvent, t: Tab): void => {
    e.preventDefault()
    const n = panes(t.root).length
    st().showMenu(e, [
      { label: '탭 이름 바꾸기', onClick: async () => { const name = await st().prompt('탭 이름 바꾸기', tabInfo(t).title); if (name !== null) st().updateTab(t.id, { title: name || undefined }) } },
      { label: '탭 색상', colors: { value: t.color, onPick: (c) => st().updateTab(t.id, { color: c }) } },
      { separator: true },
      { label: t.broadcast ? '동시 입력 끄기' : '이 탭의 모든 패널에 동시 입력', shortcut: SC.broadcast, disabled: n < 2, onClick: () => st().updateTab(t.id, { broadcast: !t.broadcast }) },
      { label: '패널을 각각 탭으로 분리', disabled: n < 2, onClick: () => st().splitToTabs(t.id) },
      { label: '모든 탭을 이 창 그리드로 모으기', onClick: () => st().gatherAll() },
      { separator: true },
      ...dockMenu('다른 탭에 패널로 넣기', t.id, (to) => st().mergeTab(t.id, { tabId: to })),
      ...(st().tabs.length > 1 ? [{ separator: true }] : []),
      { label: '다른 탭 모두 닫기', onClick: async () => {
        const others = st().tabs.filter((x) => x.id !== t.id)
        const choice = await st().confirmCloseSessions(others.flatMap((x) => panes(x.root).map((p) => p.sessionId)), '다른 탭 모두 닫기')
        if (!choice) return
        for (const x of others) await st().closeTab(x.id, choice)
      } },
      { label: '탭 닫기', shortcut: isMac ? undefined : SC.closePane, danger: true, onClick: () => st().closeTab(t.id) }
    ])
  }

  return (
    <div className={`titlebar ${api.platform === 'darwin' ? 'mac' : ''}`}>
      <div className="tb-left">
        <div className="logo"><img className="logo-mark" src={logo} alt="" />BrightTerm</div>
        <button className={`ibtn ${sidebar ? 'on' : ''}`} title={`서버 목록 (${SC.sidebar})`} onClick={() => useApp.setState({ sidebar: !sidebar })}><PanelLeft size={16} /></button>
      </div>
      <div className="tabs">
        {tabs.map((t, i) => {
          const info = tabInfo(t)
          return (
            <div
              key={t.id}
              className={`tab ${t.id === activeTab ? 'active' : ''} ${overIdx === i && dragIdx !== i ? (drag?.kind === 'pane' ? 'drop-into' : 'drag-over') : ''}`}
              style={info.color ? { background: t.id === activeTab ? `color-mix(in srgb, ${info.color} 14%, var(--bg-2))` : `color-mix(in srgb, ${info.color} 7%, transparent)` } : undefined}
              onMouseDown={(e) => { if (e.button === 0) st().setActiveTab(t.id) }}
              onAuxClick={(e) => { if (e.button === 1) st().closeTab(t.id) }}
              onContextMenu={(e) => menu(e, t)}
              onDoubleClick={async () => { const name = await st().prompt('탭 이름 바꾸기', info.title); if (name !== null) st().updateTab(t.id, { title: name || undefined }) }}
              draggable
              onDragStart={(e) => {
                setDragIdx(i)
                e.dataTransfer.effectAllowed = 'move'
                e.dataTransfer.setData('application/x-bt-tab', t.id)
                useApp.setState({ drag: { kind: 'tab', tabId: t.id } })
              }}
              onDragEnter={() => {
                clearHover()
                if (st().drag && t.id !== st().activeTab) hoverTimer.current = setTimeout(() => st().setActiveTab(t.id), 600)
              }}
              onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) clearHover() }}
              onDragOver={(e) => { if (!st().drag) return; e.preventDefault(); setOverIdx(i) }}
              onDragEnd={endDrag}
              onDrop={(e) => {
                e.preventDefault()
                const d = st().drag
                // 패널을 탭에 놓으면 그 탭 안으로, 탭을 탭에 놓으면 순서 바꾸기
                if (d?.kind === 'pane') st().movePane(d.paneId, { tabId: t.id })
                else if (dragIdx !== null && dragIdx !== i) st().moveTab(dragIdx, i)
                endDrag()
              }}
              title={info.title}
            >
              {info.color && <span className="tab-color" style={{ background: info.color }} />}
              <span className={`dot ${info.activity && t.id !== activeTab ? 'activity' : info.state}`} />
              <span className="tab-title">{info.title}</span>
              {t.broadcast && <Radio size={12} color="var(--warn)" />}
              {info.count > 1 && <span className="tab-count">{info.count}</span>}
              <span className="tab-close" onMouseDown={(e) => e.stopPropagation()} onClick={() => st().closeTab(t.id)}><X size={13} /></span>
            </div>
          )
        })}
      </div>
      {drag?.kind === 'pane' ? (
        // 제목 줄은 창 끌기 영역이라 놓기가 안 된다 — 패널을 끄는 동안만 놓을 자리를 보인다
        <div className={`tab-drop-new ${overNew ? 'over' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setOverNew(true) }}
          onDragLeave={() => setOverNew(false)}
          onDrop={(e) => { e.preventDefault(); st().movePane(drag.paneId, 'newTab'); endDrag() }}>
          <Plus size={13} />새 탭으로
        </div>
      ) : (
        <button className="ibtn tab-new" title={`새 연결 (${SC.quick})`} onClick={() => useApp.setState({ dialog: { kind: 'quick' } })}><Plus size={16} /></button>
      )}
      <div className="tb-fill" />
      <div className="tb-right">
        <GitSyncIndicator />
        {tabs.length > 1 && <button className="ibtn" title="모든 탭을 그리드로 모으기" onClick={() => st().gatherAll()}><LayoutGrid size={15} /></button>}
        {/* 패널에는 스니펫도 있어 누를 수는 있게 두고, 지금 세션이 SFTP 를 못 쓰면 흐리게 */}
        <button className="ibtn" style={st().focusedSession()?.sftp === 'unavailable' ? { opacity: 0.35 } : undefined} title={st().focusedSession()?.sftp === 'unavailable' ? '이 서버는 파일을 주고받을 수 없습니다 — 패널에서 스니펫은 쓸 수 있습니다' : `SFTP 패널 (${SC.sftp})`} onClick={() => useApp.setState((s) => ({ rightPanel: s.rightPanel ? null : 'sftp' }))}><FolderTree size={15} /></button>
        {vault.unlocked && <button className="ibtn" title="지금 잠그기" onClick={() => api.vault.lock()}><Lock size={15} /></button>}
        <button className="ibtn" title={isMac ? `설정 (${SC.settings})` : '설정'} onClick={() => useApp.setState({ dialog: { kind: 'settings' } })}><Settings size={15} /></button>
      </div>
    </div>
  )
}
