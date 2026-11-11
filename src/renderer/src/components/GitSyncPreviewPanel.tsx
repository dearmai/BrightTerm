import { useState } from 'react'
import type { GitSyncDifference, GitSyncPreview } from '@shared/types'

const categories = { hosts: '서버', groups: '폴더', snippets: '스니펫', credentials: '계정', vault: '볼트 정보' }
const kinds = { 'local-only': '로컬에만 있음', 'remote-only': '원격에만 있음', changed: '값이 다름' }

export function GitSyncPreviewPanel({ preview }: { preview: GitSyncPreview }): JSX.Element {
  const [category, setCategory] = useState<'all' | GitSyncDifference['category']>('all')
  const [visible, setVisible] = useState(50)
  const filtered = preview.differences.filter((d) => category === 'all' || d.category === category)
  return <div className="git-sync-preview">
    <h4>차이 미리보기</h4>
    <div className="muted">조회: {new Date(preview.createdAt).toLocaleString()} · 선택은 전체 데이터에 적용됩니다.</div>
    <div className="git-diff-notes">{preview.notes.map((note) => <p key={note}>{note}</p>)}</div>
    <div className="git-diff-filters" aria-label="비교 항목 종류">
      {(['all', ...Object.keys(categories)] as const).map((key) => {
        const count = key === 'all' ? preview.differences.length : preview.differences.filter((d) => d.category === key).length
        const label = key === 'all' ? '전체' : categories[key as keyof typeof categories]
        return <button className={`btn sm ${category === key ? 'primary' : ''}`} key={key}
          aria-pressed={category === key} onClick={() => { setCategory(key as typeof category); setVisible(50) }}>{label} {count}</button>
      })}
    </div>
    {filtered.length === 0 && <p className="muted">이 종류에서 다른 항목이 없습니다.</p>}
    {filtered.slice(0, visible).map((item) => <details className="git-diff-item" key={`${item.category}:${item.id}`}>
      <summary><span className="muted">{categories[item.category]}</span> <strong>{item.name}</strong><span className={`git-diff-kind ${item.kind}`}>{kinds[item.kind]}</span></summary>
      <div className="git-diff-table-wrap"><table className="git-diff-table">
        <thead><tr><th>설정</th><th>이 PC (로컬)</th><th>원격</th></tr></thead>
        <tbody>{item.fields.map((field, i) => <tr key={i}><th>{field.label}</th>{[field.local, field.remote].map((value, side) => <td key={side}>
          {field.concealed ? <details><summary>내용 보기</summary><pre>{value}</pre></details> : <pre>{value}</pre>}
        </td>)}</tr>)}</tbody>
      </table></div>
    </details>)}
    {filtered.length > visible && <button className="btn sm" onClick={() => setVisible((n) => n + 50)}>50개 더 보기 ({visible}/{filtered.length})</button>}
  </div>
}
