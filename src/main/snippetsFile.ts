// 스니펫 내보내기·가져오기 파일 — 사람이 읽고 고칠 수 있는 JSON. 평문이므로 볼트 비밀은 넣지 않는다(스니펫 본문만).
import type { Snippet } from '@shared/types'

export const MAX_SNIPPET_FILE_BYTES = 16 * 1024 * 1024
/** Git 동기화 파일이 받아들이는 목록 크기와 같다 */
export const MAX_SNIPPETS = 10000

export function serializeSnippets(snippets: Snippet[], now = new Date()): string {
  return JSON.stringify({
    app: 'brightterm',
    type: 'snippets',
    version: 1,
    exportedAt: now.toISOString(),
    snippets: snippets.map(({ name, body, sendEnter }) => ({ name, body, sendEnter }))
  }, null, 2) + '\n'
}

/** 잘못된 항목이 하나라도 있으면 전체를 거부한다. sendEnter 가 없으면 입력만 하고 실행하지 않는다 */
export function parseSnippets(text: string): Omit<Snippet, 'id'>[] {
  let data: { app?: unknown; type?: unknown; version?: unknown; snippets?: unknown }
  try {
    data = JSON.parse(text.replace(/^﻿/, ''))
  } catch {
    throw new Error('JSON 파일을 읽을 수 없습니다')
  }
  if (data?.app !== 'brightterm' || data.type !== 'snippets' || !Array.isArray(data.snippets)) throw new Error('BrightTerm 스니펫 파일이 아닙니다')
  if (data.version !== 1) throw new Error('지원하지 않는 스니펫 파일 버전입니다')
  if (data.snippets.length > MAX_SNIPPETS) throw new Error(`스니펫은 ${MAX_SNIPPETS}개까지 가져올 수 있습니다`)
  return data.snippets.map((s: { name?: unknown; body?: unknown; sendEnter?: unknown }, i: number) => {
    const name = s?.name ?? ''
    const sendEnter = s?.sendEnter ?? false
    if (typeof name !== 'string' || typeof s?.body !== 'string' || !s.body || typeof sendEnter !== 'boolean') {
      throw new Error(`${i + 1}번째 스니펫의 형식이 올바르지 않습니다`)
    }
    return { name, body: s.body, sendEnter }
  })
}

/** 기존 스니펫은 건드리지 않는다. 내용까지 같으면 건너뛰고, 이름만 같으면 "이름 (2)" 로 추가한다 */
export function mergeSnippets(existing: Snippet[], incoming: Omit<Snippet, 'id'>[], newId: () => string = () => crypto.randomUUID()): { snippets: Snippet[]; added: number; skipped: number } {
  const snippets = [...existing]
  let added = 0
  let skipped = 0
  for (const s of incoming) {
    if (snippets.some((x) => x.name === s.name && x.body === s.body && x.sendEnter === s.sendEnter)) {
      skipped++
      continue
    }
    let name = s.name
    for (let n = 2; name && snippets.some((x) => x.name === name); n++) name = `${s.name} (${n})`
    snippets.push({ ...s, id: newId(), name })
    added++
  }
  if (snippets.length > MAX_SNIPPETS) throw new Error(`스니펫은 모두 ${MAX_SNIPPETS}개까지 저장할 수 있습니다`)
  return { snippets, added, skipped }
}
