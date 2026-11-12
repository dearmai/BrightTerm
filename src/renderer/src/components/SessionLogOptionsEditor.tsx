import { FolderOpen, FolderSearch } from 'lucide-react'
import type { SessionLogOptions } from '@shared/types'
import { normalizeSessionLogOptions } from '@shared/sessionLog'
import { useApp } from '../state'
import { api } from '../api'
import { Field, Seg, Toggle } from './ui'

/** 세션 로그 규칙 — 앱 설정(기본값)과 서버 편집(고급)에서 같이 쓴다 */
export function SessionLogOptionsEditor({ value, onChange }: { value?: SessionLogOptions; onChange: (value: SessionLogOptions) => void }): JSX.Element {
  const o = normalizeSessionLogOptions(value)
  const set = (patch: Partial<SessionLogOptions>): void => onChange(normalizeSessionLogOptions({ ...o, ...patch }))
  const numeric = (key: 'maxSizeMB' | 'maxFiles' | 'retentionDays', label: string, hint: string): JSX.Element => (
    <Field label={label} hint={hint}><input className="input" type="number" aria-label={label} min={0} value={o[key]}
      onChange={(e) => { if (e.target.value !== '') set({ [key]: Number(e.target.value) }) }} /></Field>
  )
  const openDir = (): void => { api.app.openLogs(o.dir).catch((e) => useApp.getState().toast('error', (e as Error).message)) }
  const rotation = [o.maxSizeMB ? `${o.maxSizeMB}MB마다` : '', o.rotateDaily ? '날짜가 바뀌면' : ''].filter(Boolean).join(' 또는 ')
  const keep = [o.maxFiles ? `최근 ${o.maxFiles}개` : '', o.retentionDays ? `${o.retentionDays}일` : ''].filter(Boolean).join(' · ')
  return <div className="session-log-options">
    <Field label="저장 폴더" hint="비우면 데이터 폴더의 logs 폴더에 저장합니다. ~ 는 홈 폴더, 상대 경로는 기본 logs 폴더 아래입니다. 폴더를 쓸 수 없으면 기본 폴더에 저장합니다.">
      <div className="row">
        <input className="input mono" style={{ flex: 1 }} aria-label="저장 폴더" placeholder="기본 폴더 (데이터 폴더/logs)" value={o.dir} onChange={(e) => onChange({ ...o, dir: e.target.value })} onBlur={() => set({})} />
        <button type="button" className="btn sm" onClick={async () => { const d = await api.dialog.chooseDir(); if (d) set({ dir: d }) }}><FolderSearch size={13} />찾기</button>
        <button type="button" className="btn sm" onClick={openDir}><FolderOpen size={13} />열기</button>
      </div>
    </Field>
    <Field label="기록 형식">
      <Seg value={o.format} onChange={(format) => set({ format })} options={[{ value: 'text', label: '텍스트 (색·제어 코드 제거)' }, { value: 'raw', label: '원본 (제어 코드 포함)' }]} />
    </Field>
    <div className="card">
      {o.format === 'text' && <Toggle label="줄마다 시각 기록" desc="각 줄 앞에 [YYYY-MM-DD HH:mm:ss] 를 붙입니다" value={o.timestamp} onChange={(timestamp) => set({ timestamp })} />}
      <Toggle label="날짜가 바뀌면 새 파일" desc="자정이 지난 뒤 첫 출력부터 새 파일에 기록합니다" value={o.rotateDaily} onChange={(rotateDaily) => set({ rotateDaily })} />
      <Toggle label="지난 파일 압축" desc="다 쓴 로그 파일을 gzip(.log.gz)으로 압축해 공간을 줄입니다" value={o.compress} onChange={(compress) => set({ compress })} />
    </div>
    <div className="grid3">
      {numeric('maxSizeMB', '파일 최대 크기 (MB)', '0 = 제한 없음')}
      {numeric('maxFiles', '보관 파일 수', '0 = 제한 없음')}
      {numeric('retentionDays', '보관 기간 (일)', '0 = 제한 없음')}
    </div>
    <div className="hint">
      연결마다 <span className="mono">서버별칭_날짜-시각.log</span> 파일을 만들고{rotation ? `, ${rotation} 다음 파일로 넘깁니다` : ' 파일을 나누지 않습니다'}.
      {' '}{keep ? `서버마다 ${keep}만 남기고 오래된 파일은 지웁니다.` : '오래된 파일을 지우지 않습니다.'} 정리는 로그 파일을 열고 닫을 때 하며, 쓰고 있는 파일은 지우지 않습니다. 변경한 값은 새 연결부터 적용됩니다.
    </div>
  </div>
}
