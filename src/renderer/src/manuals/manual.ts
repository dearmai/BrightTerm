import type { ServerEnv } from '@shared/types'

// 매뉴얼 본문은 마크다운의 일부만 쓴다: ## 절, ### 소제목, 문단, - 목록, ``` 코드, | 표 |, 줄 안의 `코드`·**굵게**·[링크](주소)
export type Block =
  | { type: 'h3' | 'p'; text: string }
  | { type: 'code'; text: string }
  | { type: 'ul'; items: string[] }
  | { type: 'table'; head: string[]; rows: string[][] }

export interface ManualSection { title: string; blocks: Block[] }

const cells = (line: string): string[] => line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'))

/** ## 앞의 글(# 제목 포함)은 버린다 */
export function parseManual(text: string): ManualSection[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const sections: ManualSection[] = []
  let cur: ManualSection | null = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.startsWith('## ')) { cur = { title: line.slice(3).trim(), blocks: [] }; sections.push(cur); continue }
    if (!cur || !line.trim()) continue
    if (line.startsWith('```')) {
      const body: string[] = []
      for (i++; i < lines.length && !lines[i].startsWith('```'); i++) body.push(lines[i])
      cur.blocks.push({ type: 'code', text: body.join('\n') })
    } else if (line.startsWith('### ')) {
      cur.blocks.push({ type: 'h3', text: line.slice(4).trim() })
    } else if (line.startsWith('- ')) {
      const items: string[] = []
      for (; i < lines.length && lines[i].startsWith('- '); i++) items.push(lines[i].slice(2).trim())
      i--
      cur.blocks.push({ type: 'ul', items })
    } else if (line.startsWith('|')) {
      const rows: string[][] = []
      for (; i < lines.length && lines[i].startsWith('|'); i++) rows.push(cells(lines[i]))
      i--
      // 둘째 줄은 |---|---| 구분선
      cur.blocks.push({ type: 'table', head: rows[0], rows: rows.slice(2) })
    } else {
      const body: string[] = []
      for (; i < lines.length && lines[i].trim() && !/^(#|```|- |\|)/.test(lines[i]); i++) body.push(lines[i].trim())
      i--
      cur.blocks.push({ type: 'p', text: body.join(' ') })
    }
  }
  return sections
}

export type Inline = { type: 'text' | 'code' | 'bold'; text: string } | { type: 'link'; text: string; url: string }

export function parseInline(text: string): Inline[] {
  const out: Inline[] = []
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\((https?:[^)]+)\)/g
  let at = 0
  for (const m of text.matchAll(re)) {
    if (m.index > at) out.push({ type: 'text', text: text.slice(at, m.index) })
    if (m[1] !== undefined) out.push({ type: 'code', text: m[1] })
    else if (m[2] !== undefined) out.push({ type: 'bold', text: m[2] })
    else out.push({ type: 'link', text: m[3], url: m[4] })
    at = m.index + m[0].length
  }
  if (at < text.length) out.push({ type: 'text', text: text.slice(at) })
  return out
}

const blockText = (b: Block): string => {
  if (b.type === 'ul') return b.items.join(' ')
  if (b.type === 'table') return [...b.head, ...b.rows.flat()].join(' ')
  return b.text
}

/** 절 안의 글에 검색어가 있으면 그 절을 남긴다. 띄어쓴 단어는 모두 들어 있어야 한다 */
export function filterSections(sections: ManualSection[], query: string): ManualSection[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return sections
  return sections.filter((s) => {
    const text = [s.title, ...s.blocks.map(blockText)].join(' ').toLowerCase()
    return words.every((w) => text.includes(w))
  })
}

export type ManualId = 'aix' | 'ksh'

/** 이 서버에 맞는 매뉴얼 — AIX 는 7.2·7.3 만, 쉘은 AIX 가 아니어도 ksh 면 */
export function manualsFor(env: ServerEnv): ManualId[] {
  const out: ManualId[] = []
  if (env.os === 'AIX' && /^7\.[23]$/.test(env.osVersion)) out.push('aix')
  if (/(^|\/)r?ksh(88|93)?$/.test(env.shell)) out.push('ksh')
  return out
}
