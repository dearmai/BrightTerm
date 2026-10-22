export type Dir = 'row' | 'col'
/** color: 사용자가 이 패널에 직접 지정한 색 — 서버/폴더 색보다 우선 */
export interface PaneNode { type: 'pane'; id: string; sessionId: string; color?: string }
export interface SplitNode { type: 'split'; id: string; dir: Dir; children: LayoutNode[]; sizes: number[] }
export type LayoutNode = PaneNode | SplitNode

export const uid = (): string => Math.random().toString(36).slice(2, 10)

export function panes(n: LayoutNode): PaneNode[] {
  return n.type === 'pane' ? [n] : n.children.flatMap(panes)
}

export function findPane(n: LayoutNode, id: string): PaneNode | undefined {
  return panes(n).find((p) => p.id === id)
}

/** Split `targetId` pane, placing `newPane` after it in direction dir. */
export function splitPane(root: LayoutNode, targetId: string, dir: Dir, newPane: PaneNode): LayoutNode {
  const rec = (n: LayoutNode): LayoutNode => {
    if (n.type === 'pane') {
      if (n.id !== targetId) return n
      return { type: 'split', id: uid(), dir, children: [n, newPane], sizes: [50, 50] }
    }
    // if the target is a direct child and this split has same dir, insert as sibling
    const idx = n.children.findIndex((c) => c.type === 'pane' && c.id === targetId)
    if (idx >= 0 && n.dir === dir) {
      const children = [...n.children]
      children.splice(idx + 1, 0, newPane)
      const each = 100 / children.length
      return { ...n, children, sizes: children.map(() => each) }
    }
    return { ...n, children: n.children.map(rec) }
  }
  return rec(root)
}

export type Side = 'left' | 'right' | 'top' | 'bottom'

/**
 * 패널(또는 다른 탭의 배치 전체) node 를 targetId 패널의 side 쪽에 넣는다 — 대상 패널의 자리를 반씩 나눈다.
 * targetId 가 없거나 못 찾으면 탭 전체의 그쪽 끝에 붙인다.
 */
export function insertNode(root: LayoutNode, targetId: string | null, side: Side, node: LayoutNode): LayoutNode {
  const dir: Dir = side === 'left' || side === 'right' ? 'row' : 'col'
  const before = side === 'left' || side === 'top'
  const pair = (a: LayoutNode): LayoutNode => ({ type: 'split', id: uid(), dir, children: before ? [node, a] : [a, node], sizes: [50, 50] })
  if (!targetId || !findPane(root, targetId)) {
    if (root.type === 'split' && root.dir === dir) {
      const each = 100 / (root.children.length + 1)
      const scale = (100 - each) / 100
      const sizes = root.sizes.map((s) => s * scale)
      return { ...root, children: before ? [node, ...root.children] : [...root.children, node], sizes: before ? [each, ...sizes] : [...sizes, each] }
    }
    return pair(root)
  }
  const rec = (n: LayoutNode): LayoutNode => {
    if (n.type === 'pane') return n.id === targetId ? pair(n) : n
    const idx = n.children.findIndex((c) => c.type === 'pane' && c.id === targetId)
    if (idx >= 0 && n.dir === dir) {
      const half = n.sizes[idx] / 2
      const children = [...n.children]
      const sizes = [...n.sizes]
      children.splice(before ? idx : idx + 1, 0, node)
      sizes.splice(idx, 1, half, half)
      return { ...n, children, sizes }
    }
    return { ...n, children: n.children.map(rec) }
  }
  return rec(root)
}

/** Remove a pane; collapses splits with a single child. Returns null when tree becomes empty. */
export function removePane(root: LayoutNode, paneId: string): LayoutNode | null {
  const rec = (n: LayoutNode): LayoutNode | null => {
    if (n.type === 'pane') return n.id === paneId ? null : n
    const kept: LayoutNode[] = []
    const sizes: number[] = []
    n.children.forEach((c, i) => {
      const r = rec(c)
      if (r) { kept.push(r); sizes.push(n.sizes[i]) }
    })
    if (!kept.length) return null
    if (kept.length === 1) return kept[0]
    const total = sizes.reduce((a, b) => a + b, 0)
    return { ...n, children: kept, sizes: sizes.map((s) => (s / total) * 100) }
  }
  return rec(root)
}

export function setPaneColor(root: LayoutNode, paneId: string, color?: string): LayoutNode {
  if (root.type === 'pane') return root.id === paneId ? { ...root, color } : root
  return { ...root, children: root.children.map((c) => setPaneColor(c, paneId, color)) }
}

export function setSizes(root: LayoutNode, splitId: string, sizes: number[]): LayoutNode {
  if (root.type === 'pane') return root
  if (root.id === splitId) return { ...root, sizes }
  return { ...root, children: root.children.map((c) => setSizes(c, splitId, sizes)) }
}

/** Build a balanced grid from a list of panes. */
export function grid(ps: PaneNode[]): LayoutNode {
  if (ps.length === 1) return ps[0]
  const cols = Math.ceil(Math.sqrt(ps.length))
  const rows: LayoutNode[] = []
  for (let i = 0; i < ps.length; i += cols) {
    const slice = ps.slice(i, i + cols)
    rows.push(slice.length === 1 ? slice[0] : { type: 'split', id: uid(), dir: 'row', children: slice, sizes: slice.map(() => 100 / slice.length) })
  }
  if (rows.length === 1) return rows[0]
  return { type: 'split', id: uid(), dir: 'col', children: rows, sizes: rows.map(() => 100 / rows.length) }
}

/** Neighbour pane in a direction based on DOM rects. */
export function neighbour(paneIds: string[], current: string, dir: 'left' | 'right' | 'up' | 'down'): string | null {
  const rect = (id: string): DOMRect | undefined => document.querySelector(`[data-pane="${id}"]`)?.getBoundingClientRect()
  const cur = rect(current)
  if (!cur) return null
  const cx = cur.left + cur.width / 2
  const cy = cur.top + cur.height / 2
  let best: string | null = null
  let bestD = Infinity
  for (const id of paneIds) {
    if (id === current) continue
    const r = rect(id)
    if (!r) continue
    const x = r.left + r.width / 2
    const y = r.top + r.height / 2
    const ok = dir === 'left' ? x < cx - 5 : dir === 'right' ? x > cx + 5 : dir === 'up' ? y < cy - 5 : y > cy + 5
    if (!ok) continue
    const d = Math.hypot(x - cx, y - cy)
    if (d < bestD) { bestD = d; best = id }
  }
  return best
}
