// 원격 데스크톱 화면 위 막대의 설정 패널 — 화면·입력은 바로, 화질·소리는 다시 연결하면 적용.
// 별도 창(rdp.html)도 쓰므로 앱 상태(state.ts)·터미널 코드를 불러오지 않는다.
import type { ReactNode } from 'react'
import { RefreshCw, X } from 'lucide-react'
import type { RdpColorDepth, RdpExperience, RdpOptions } from '@shared/types'
import { RDP_PRESETS, rdpPreset } from '@shared/rdp'

/** 메인 프로세스 RdpViewOptions 와 같은 모양 */
export interface RdpViewOptions {
  scale: 'fit' | 'full' | 'real'
  dpi: number
  unicodeKeyboard: boolean
  clipboard: boolean
  resolution: string
  colorDepth: RdpColorDepth
  audio: 'remote' | 'off'
  experience: RdpExperience
}

export const RESOLUTIONS = ['window', '1024x768', '1280x720', '1366x768', '1600x900', '1920x1080', '2560x1440']
export const resolutionLabel = (r: string): string => (r === 'window' ? '창 크기에 맞춤' : r.replace('x', ' × '))
export const DPIS = [100, 125, 150, 175, 200]
export const COLOR_DEPTHS: RdpColorDepth[] = [32, 24, 16, 15]
export const SCALE_OPTIONS: { value: NonNullable<RdpOptions['scale']>; label: string }[] = [
  { value: 'fit', label: '맞춤' },
  { value: 'full', label: '꽉 채움' },
  { value: 'real', label: '실제 크기' }
]
export const PRESET_LABELS: Record<keyof typeof RDP_PRESETS, string> = { best: '최고 화질', balanced: '균형', fast: '빠르게' }
export const EXPERIENCE_LABELS: Record<keyof RdpExperience, string> = {
  wallpaper: '바탕 화면 배경',
  themes: '시각 스타일(테마)',
  fontSmoothing: '글꼴 다듬기(ClearType)',
  composition: '데스크톱 구성(투명 효과)',
  windowDrag: '끄는 동안 창 내용 표시',
  animations: '메뉴·창 애니메이션',
  cursorShadow: '마우스 포인터 그림자'
}

export function MiniSeg<T extends string | number>(p: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void }): JSX.Element {
  return (
    <div className="seg">
      {p.options.map((o) => <button type="button" key={String(o.value)} className={o.value === p.value ? 'on' : ''} onClick={() => p.onChange(o.value)}>{o.label}</button>)}
    </div>
  )
}

const MiniSwitch = (p: { value: boolean; onChange: (v: boolean) => void; label: string }): JSX.Element => (
  <button type="button" role="switch" aria-checked={p.value} aria-label={p.label} className={`switch ${p.value ? 'on' : ''}`} onClick={() => p.onChange(!p.value)} />
)

interface Applied { colorDepth: number; audio: string; experience: RdpExperience; clipboard: boolean }

export function RdpSettingsPanel(props: {
  options: RdpViewOptions
  /** 지금 연결에 쓴 값 — 연결 중이 아니면 null */
  applied: Applied | null
  /** 15비트가 멈춰 대신 쓰는 색 깊이 */
  fallbackDepth?: number
  onChange: (p: Partial<RdpViewOptions>) => void
  onReconnect: () => void
  onClose: () => void
}): JSX.Element {
  const o = props.options
  const a = props.applied
  const preset = rdpPreset(o)
  const pending = !!a && (a.colorDepth !== o.colorDepth || a.audio !== o.audio || (Object.keys(o.experience) as (keyof RdpExperience)[]).some((k) => a.experience[k] !== o.experience[k]) || (!a.clipboard && o.clipboard))
  const row = (label: string, control: ReactNode, hint?: ReactNode): JSX.Element => (
    <div className="rdp-set-row"><span className="rdp-set-label">{label}</span><div className="rdp-set-ctl">{control}{hint && <div className="rdp-set-hint">{hint}</div>}</div></div>
  )
  return (
    <div className="rdp-settings" role="dialog" aria-label="원격 데스크톱 설정" onKeyDown={(e) => { if (e.key === 'Escape') props.onClose() }}>
      <div className="rdp-set-head">
        <b>원격 데스크톱 설정</b>
        <span className="muted">이 서버 설정에 저장됩니다</span>
        <span className="grow" />
        <button className="ibtn" onClick={props.onClose} title="닫기"><X size={14} /></button>
      </div>

      <div className="rdp-set-sec">화면 · 입력 <span className="muted">— 바로 적용</span></div>
      {row('화면 맞춤', <MiniSeg value={o.scale} options={SCALE_OPTIONS} onChange={(v) => props.onChange({ scale: v })} />)}
      {row('해상도', (
        <select className="select" aria-label="해상도" value={o.resolution} onChange={(e) => props.onChange({ resolution: e.target.value })}>
          {RESOLUTIONS.map((r) => <option key={r} value={r}>{resolutionLabel(r)}</option>)}
        </select>
      ))}
      {row('배율', (
        <select className="select" aria-label="배율" value={o.dpi} onChange={(e) => props.onChange({ dpi: +e.target.value })}>
          {DPIS.map((d) => <option key={d} value={d}>{d}%</option>)}
        </select>
      ), '원격 Windows 의 글자·아이콘 크기')}
      {row('키보드 문자 입력', <MiniSwitch label="키보드 문자 입력" value={o.unicodeKeyboard} onChange={(v) => props.onChange({ unicodeKeyboard: v })} />, '자판 배열이 서로 다를 때 켭니다. 단축키는 스캔 코드가 더 정확합니다')}
      {row('클립보드 동기화', <MiniSwitch label="클립보드 동기화" value={o.clipboard} onChange={(v) => props.onChange({ clipboard: v })} />, a && !a.clipboard && o.clipboard ? '꺼진 채로 연결해 다시 연결해야 켜집니다' : undefined)}

      <div className="rdp-set-sec">화질 · 소리 <span className="muted">— 다시 연결하면 적용</span></div>
      {row('화질', (
        <MiniSeg value={preset} options={[...(Object.keys(RDP_PRESETS) as (keyof typeof RDP_PRESETS)[]).map((k) => ({ value: k as typeof preset, label: PRESET_LABELS[k] })), ...(preset === 'custom' ? [{ value: 'custom' as const, label: '사용자 지정' }] : [])]}
          onChange={(v) => { if (v !== 'custom') props.onChange({ colorDepth: RDP_PRESETS[v].colorDepth, experience: RDP_PRESETS[v].experience }) }} />
      ))}
      {row('색 깊이', (
        <select className="select" aria-label="색 깊이" value={o.colorDepth} onChange={(e) => props.onChange({ colorDepth: +e.target.value as RdpColorDepth })}>
          {COLOR_DEPTHS.map((d) => <option key={d} value={d}>{d}비트{d === 32 ? ' (최고)' : d === 16 ? ' (빠름)' : ''}</option>)}
        </select>
      ), props.fallbackDepth ? `15비트 접속이 멈춰 지금은 ${props.fallbackDepth}비트로 접속했습니다` : o.colorDepth === 15 ? '일부 Windows 는 15비트에서 멈춥니다 — 그러면 16비트로 자동 다시 연결합니다' : undefined)}
      <div className="rdp-set-checks">
        {(Object.keys(EXPERIENCE_LABELS) as (keyof RdpExperience)[]).map((k) => (
          <label key={k}><input type="checkbox" checked={o.experience[k]} onChange={(e) => props.onChange({ experience: { ...o.experience, [k]: e.target.checked } })} />{EXPERIENCE_LABELS[k]}</label>
        ))}
      </div>
      {row('소리', <MiniSeg value={o.audio} options={[{ value: 'remote', label: '원격 PC 에서 재생' }, { value: 'off', label: '재생 안 함' }]} onChange={(v) => props.onChange({ audio: v })} />, '내장 연결은 이 PC 로 소리를 가져오지 못합니다 — 필요하면 외부 앱 연결을 쓰세요')}

      {pending && (
        <div className="rdp-set-foot">
          <span>바뀐 화질·소리는 다시 연결해야 적용됩니다.</span>
          <button className="btn sm primary" onClick={props.onReconnect}><RefreshCw size={13} />다시 연결해 적용</button>
        </div>
      )}
    </div>
  )
}
