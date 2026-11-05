import { useEffect, useMemo, useState } from 'react'
import { Copy } from 'lucide-react'
import type { ServerEnv } from '@shared/types'
import { useApp } from '../state'
import { api } from '../api'
import { MANUALS } from '../manuals'
import { filterSections, manualsFor, parseInline, type Block, type ManualId } from '../manuals/manual'

// 같은 연결이면 서버에 다시 묻지 않는다. 실패는 담지 않아 패널을 다시 열면 또 묻는다
const envCache = new Map<string, ServerEnv | null>()
/** 세션별로 직접 고른 문서 */
const picks = new Map<string, ManualId>()

function Inline({ text }: { text: string }): JSX.Element {
  return <>{parseInline(text).map((p, i) => {
    if (p.type === 'code') return <code key={i}>{p.text}</code>
    if (p.type === 'bold') return <strong key={i}>{p.text}</strong>
    if (p.type === 'link') return <a key={i} href={p.url} onClick={(e) => { e.preventDefault(); void api.app.openExternal(p.url) }}>{p.text}</a>
    return <span key={i}>{p.text}</span>
  })}</>
}

function ManualBlock({ block }: { block: Block }): JSX.Element {
  switch (block.type) {
    case 'h3': return <h4><Inline text={block.text} /></h4>
    case 'p': return <p><Inline text={block.text} /></p>
    case 'ul': return <ul>{block.items.map((it, i) => <li key={i}><Inline text={it} /></li>)}</ul>
    case 'table': return (
      <div className="mn-table">
        <table>
          <thead><tr>{block.head.map((c, i) => <th key={i}><Inline text={c} /></th>)}</tr></thead>
          <tbody>{block.rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}><Inline text={c} /></td>)}</tr>)}</tbody>
        </table>
      </div>
    )
    case 'code': return (
      <div className="mn-code">
        <pre>{block.text}</pre>
        <button className="ibtn sm" title="복사" onClick={async () => { await api.clip.writeText(block.text); useApp.getState().toast('ok', '복사했습니다') }}><Copy size={13} /></button>
      </div>
    )
  }
}

export function ManualPanel(): JSX.Element {
  const session = useApp((s) => s.focusedSession())
  const canAsk = session?.protocol === 'ssh' && session.state === 'connected'
  const key = canAsk ? `${session.id}:${session.connectedAt}` : null
  const [env, setEnv] = useState<ServerEnv | null | undefined>(null)
  const [, setPicked] = useState(0)
  const [query, setQuery] = useState('')

  useEffect(() => {
    if (!key || !session) { setEnv(null); return }
    if (envCache.has(key)) { setEnv(envCache.get(key)); return }
    let stale = false
    setEnv(undefined)
    api.session.env(session.id)
      .then((r) => { if (r) envCache.set(key, r); if (!stale) setEnv(r) })
      .catch(() => { if (!stale) setEnv(null) })
    return () => { stale = true }
  }, [key])

  const matched = env ? manualsFor(env) : []
  const id = (session && picks.get(session.id)) ?? matched[0] ?? MANUALS[0].id
  const manual = MANUALS.find((m) => m.id === id) ?? MANUALS[0]
  const ordered = [...MANUALS].sort((a, b) => Number(matched.includes(b.id)) - Number(matched.includes(a.id)))
  const sections = useMemo(() => filterSections(manual.sections, query), [manual, query])

  const status = !session ? '세션을 선택하면 해당 서버의 OS·쉘에 맞는 문서를 먼저 보여 줍니다.'
    : env === undefined ? '서버의 OS·쉘을 확인하는 중…'
    : env ? `이 서버: ${env.os} ${env.osVersion}${env.shell ? ` · ${env.shell}` : ''}${matched.length ? '' : ' — 이 서버용 매뉴얼은 아직 없습니다'}`
    : session.protocol !== 'ssh' ? `${session.protocol.toUpperCase()} 세션은 OS·쉘을 자동으로 확인할 수 없습니다. 문서를 직접 고르세요.`
    : canAsk ? '서버의 OS·쉘을 확인하지 못했습니다. 문서를 직접 고르세요.'
    : '연결되면 서버의 OS·쉘을 확인합니다.'

  return (
    <div className="manual">
      <div className="mn-head">
        <div className="mn-status muted">{status}</div>
        <select className="select" aria-label="매뉴얼 문서" value={manual.id} onChange={(e) => {
          if (session) picks.set(session.id, e.target.value as ManualId)
          setPicked((n) => n + 1)
          document.querySelector('.mn-body')?.scrollTo(0, 0)
        }}>
          {ordered.map((m) => <option key={m.id} value={m.id}>{m.title}{matched.includes(m.id) ? ' (이 서버)' : ''}</option>)}
        </select>
        <input className="input" placeholder="문서에서 찾기 (예: errpt)" value={query} onChange={(e) => setQuery(e.target.value)} spellCheck={false} />
      </div>
      <div className="mn-body">
        {sections.map((s, i) => (
          <details key={`${manual.id}:${s.title}`} open={query.trim() ? true : i === 0}>
            <summary>{s.title}</summary>
            {s.blocks.map((b, j) => <ManualBlock key={j} block={b} />)}
          </details>
        ))}
        {!sections.length && <div className="empty">"{query}"이(가) 들어 있는 항목이 없습니다.</div>}
      </div>
    </div>
  )
}
