// 서버 편집 → 원격 데스크톱 탭 — OS 가 Windows 인 서버
import { useEffect, useState } from 'react'
import { Check, MonitorUp, Search, ShieldAlert, X, Clock } from 'lucide-react'
import type { CredentialMeta, Host, RdpCheck, RdpOptions } from '@shared/types'
import { RDP_PRESETS, rdpExperience, rdpOptions, rdpPreset } from '@shared/rdp'
import type { RdpColorDepth, RdpExperience } from '@shared/types'
import { COLOR_DEPTHS, DPIS, EXPERIENCE_LABELS, PRESET_LABELS, RESOLUTIONS, SCALE_OPTIONS } from '../rdp/RdpSettings'
import { api } from '../api'
import { Field, Seg, Switch } from './ui'
import { isMac, isWindows } from '../platform'


export function RdpCheckLine({ check, checking }: { check: RdpCheck | null; checking: boolean }): JSX.Element | null {
  if (checking) return <span className="muted" style={{ fontSize: 12 }}>확인 중…</span>
  if (!check) return null
  const icon = check.state === 'ok' ? <Check size={13} /> : check.state === 'timeout' ? <Clock size={13} /> : check.state === 'refused' ? <ShieldAlert size={13} /> : <X size={13} />
  const color = check.state === 'ok' ? 'var(--ok)' : check.state === 'refused' || check.state === 'timeout' ? 'var(--warn)' : 'var(--danger)'
  return (
    <span className="rdp-check" style={{ fontSize: 12.5, color }} title={`${check.route}${check.fingerprint ? `\n인증서 ${check.fingerprint}` : ''}`}>
      {icon} {check.message}{check.security ? ` · ${check.security}` : ''}{check.latencyMs !== undefined ? ` · ${check.latencyMs}ms` : ''}
    </span>
  )
}

export function RdpOptionsEditor(props: {
  host: Host
  onChange: (o: RdpOptions) => void
  creds: CredentialMeta[]
  password: string
  onPassword: (v: string) => void
  secretInput: (p: { credentialId?: string | null; value: string; onChange: (v: string) => void }) => JSX.Element
  vaultUnlocked: boolean
}): JSX.Element {
  const h = props.host
  const o = rdpOptions(h)
  const set = (p: Partial<RdpOptions>): void => props.onChange({ ...o, ...p })
  const [check, setCheck] = useState<RdpCheck | null>(null)
  const [checking, setChecking] = useState(false)
  const hostCred = props.creds.find((c) => c.id === h.credentialId)
  const ownCred = props.creds.find((c) => c.id === o.credentialId)
  const exp = rdpExperience(o)
  const preset = rdpPreset(o)
  const routed = o.route === 'ssh' || !!h.jump?.host || !!h.jumpHostId || !!h.proxy?.host

  const run = async (): Promise<void> => {
    setChecking(true)
    try {
      setCheck(await api.rdp.check({ ...h, host: h.host.trim(), rdp: o }))
    } catch (e) {
      setCheck({ state: 'error', message: (e as Error).message, route: '', checkedAt: Date.now() })
    } finally {
      setChecking(false)
    }
  }
  // 바로 갈 수 있는 서버는 탭을 열면 바로 확인한다 — 점프 호스트·SSH 터널은 로그인이 필요해 버튼으로만
  useEffect(() => { if (h.host.trim() && !routed) void run() }, [])

  return (
    <>
      <div className="row" style={{ gap: 10, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
        <button className="btn sm" disabled={checking || !h.host.trim()} onClick={() => void run()}><Search size={13} />RDP 허용 상태 확인</button>
        {!check && !checking && <span className="muted" style={{ fontSize: 12 }}>RDP 포트에 연결해 원격 데스크톱이 켜져 있는지, 보안 방식(NLA·TLS)과 인증서를 확인합니다 — 로그인은 하지 않습니다</span>}
        <RdpCheckLine check={check} checking={checking} />
      </div>
      <Field label="연결 방식">
        <Seg value={o.mode} onChange={(v) => set({ mode: v })} options={[
          { value: 'builtin', label: <><MonitorUp size={13} />내장 (BrightTerm 창)</> },
          { value: 'external', label: isWindows ? '외부 앱 (mstsc)' : isMac ? '외부 앱 (Windows App)' : '외부 앱 (.rdp — Remmina 등)' }
        ]} />
      </Field>
      {o.mode === 'builtin' && (
        <Field label="열 곳">
          <Seg value={o.openIn ?? 'tab'} onChange={(v) => set({ openIn: v })} options={[
            { value: 'tab', label: '이 창의 탭' },
            { value: 'window', label: '별도 창' }
          ]} />
        </Field>
      )}
      <div className="muted" style={{ fontSize: 12, marginTop: -6, marginBottom: 10 }}>
        {o.mode === 'builtin'
          ? `${(o.openIn ?? 'tab') === 'tab' ? '이 창의 탭으로' : '별도 창으로'} 엽니다 (IronRDP). NLA(CredSSP)·TLS 서버를 지원하고, 비밀번호는 볼트에서 넣습니다. 서버 인증서는 처음 연결할 때 확인합니다.`
          : `.rdp 파일을 만들어 ${isWindows ? '원격 데스크톱 연결(mstsc)' : isMac ? 'Windows App(Microsoft Remote Desktop)' : '시스템의 .rdp 앱(Remmina 등)'}으로 엽니다. 비밀번호는 넘기지 않으므로 그 앱에서 입력·저장하세요. 점프 호스트·SSH 터널을 거치면 이 PC 의 임시 포트로 이어 줍니다.`}
      </div>
      <div className="grid3">
        <Field label="RDP 포트"><input className="input mono" type="number" value={o.port} onChange={(e) => set({ port: +e.target.value || 3389 })} /></Field>
        <Field label="사용자 이름" hint="비우면 기본 탭의 사용자 이름">
          <input className="input mono" value={o.username ?? ''} onChange={(e) => set({ username: e.target.value || undefined })} placeholder={h.username || 'Administrator'} />
        </Field>
        <Field label="도메인 (선택)"><input className="input mono" value={o.domain ?? ''} onChange={(e) => set({ domain: e.target.value || undefined })} placeholder="CORP" /></Field>
      </div>
      <Field label="RDP 비밀번호">
        <Seg value={o.auth} onChange={(v) => set({ auth: v })} options={[
          { value: 'host', label: '서버 계정과 같게' },
          { value: 'own', label: 'RDP 전용' },
          { value: 'ask', label: '매번 묻기' }
        ]} />
      </Field>
      {o.auth === 'host' && (
        <div className="muted" style={{ fontSize: 12, marginTop: -6, marginBottom: 10 }}>
          {hostCred?.kind === 'password' ? `인증 탭에 저장한 비밀번호(${hostCred.name})를 씁니다.` : '인증 탭에 저장된 비밀번호가 없어 연결할 때 RDP 창에서 묻습니다.'}
        </div>
      )}
      {o.auth === 'own' && (
        <Field label="RDP 전용 비밀번호" hint={ownCred ? '저장된 비밀번호가 있습니다. 바꾸려면 새로 입력하세요.' : props.vaultUnlocked ? '저장하면 볼트에 암호화해 둡니다.' : '볼트가 잠겨 있어 저장할 수 없습니다.'}>
          {props.secretInput({ credentialId: ownCred?.id, value: props.password, onChange: props.onPassword })}
        </Field>
      )}
      {o.auth === 'ask' && <div className="muted" style={{ fontSize: 12, marginTop: -6, marginBottom: 10 }}>연결할 때마다 RDP 창에서 비밀번호를 묻습니다. "볼트에 저장"을 고르면 RDP 전용으로 바뀝니다.</div>}
      <div className="toggle">
        <div className="t-label">
          <span>클립보드 동기화</span>
          <small>이 PC 와 원격 PC 의 클립보드를 양방향으로 맞춥니다(텍스트·이미지). 운영 서버 등에서 복사·붙여넣기를 막으려면 끄세요.{o.mode === 'external' ? ' 외부 앱에는 .rdp 의 redirectclipboard 로 넘깁니다.' : ' 내장 창에 포커스가 있을 때 동기화합니다.'}</small>
        </div>
        <Switch value={o.clipboard} onChange={(v) => set({ clipboard: v })} />
      </div>
      <div className="grid2">
        <Field label="화면 크기">
          <select className="select" value={o.resolution} onChange={(e) => set({ resolution: e.target.value })}>
            {RESOLUTIONS.map((r) => <option key={r} value={r}>{r === 'window' ? '창 크기에 맞춤 (창을 바꾸면 따라감)' : r.replace('x', ' × ')}</option>)}
          </select>
        </Field>
        <Field label="경로" hint={o.route === 'ssh' ? '이 서버에 SSH 로 접속해 127.0.0.1:RDP포트 로 터널을 엽니다 — 3389 가 방화벽에 막혀 있고 SSH 만 열려 있을 때' : h.jump?.host || h.jumpHostId ? '고급 탭의 점프 호스트를 거쳐 갑니다' : h.proxy?.host ? '고급 탭의 프록시를 거쳐 갑니다' : '이 PC 에서 바로 연결합니다'}>
          <Seg value={o.route} onChange={(v) => set({ route: v })} options={[
            { value: 'direct', label: h.jump?.host || h.jumpHostId ? '점프 호스트 경유' : h.proxy?.host ? '프록시 경유' : '직접' },
            ...(h.protocol === 'ssh' ? [{ value: 'ssh' as const, label: 'SSH 터널' }] : [])
          ]} />
        </Field>
      </div>
      <div className="grid2">
        <Field label="화면 맞춤" hint={o.mode === 'external' ? '외부 앱은 앱 설정을 따릅니다' : undefined}>
          <Seg value={o.scale ?? 'fit'} onChange={(v) => set({ scale: v })} options={SCALE_OPTIONS} />
        </Field>
        <Field label="배율" hint="원격 Windows 의 글자·아이콘 크기">
          <select className="select" value={o.dpi ?? 100} onChange={(e) => set({ dpi: +e.target.value === 100 ? undefined : +e.target.value })}>
            {DPIS.map((d) => <option key={d} value={d}>{d}%</option>)}
          </select>
        </Field>
      </div>
      <Field label="화질" hint="느린 회선에서는 효과를 끄거나 색 깊이를 낮추면 빨라집니다. 연결 중에는 RDP 화면 위 설정 버튼에서 바꿀 수 있습니다(다시 연결하면 적용).">
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <Seg value={preset} onChange={(v) => { if (v !== 'custom') set({ colorDepth: RDP_PRESETS[v].colorDepth === 32 ? undefined : RDP_PRESETS[v].colorDepth, experience: v === 'best' ? undefined : RDP_PRESETS[v].experience }) }}
            options={[...(Object.keys(RDP_PRESETS) as (keyof typeof RDP_PRESETS)[]).map((k) => ({ value: k as typeof preset, label: PRESET_LABELS[k] })), ...(preset === 'custom' ? [{ value: 'custom' as const, label: '사용자 지정' }] : [])]} />
          <select className="select" style={{ width: 150 }} aria-label="색 깊이" value={o.colorDepth ?? 32} onChange={(e) => set({ colorDepth: +e.target.value === 32 ? undefined : (+e.target.value as RdpColorDepth) })}>
            {COLOR_DEPTHS.map((d) => <option key={d} value={d}>{d}비트 색</option>)}
          </select>
        </div>
      </Field>
      <div className="rdp-exp-grid">
        {(Object.keys(EXPERIENCE_LABELS) as (keyof RdpExperience)[]).map((k) => (
          <label key={k} className="row" style={{ gap: 6, fontSize: 12.5 }}><input type="checkbox" checked={exp[k]} onChange={(e) => set({ experience: { ...exp, [k]: e.target.checked } })} />{EXPERIENCE_LABELS[k]}</label>
        ))}
      </div>
      <Field label="소리" hint={o.mode === 'builtin' ? '내장 연결은 이 PC 로 소리를 가져오지 못합니다 — 이 PC 에서 들으려면 외부 앱 연결을 쓰세요' : undefined}>
        <Seg value={o.mode === 'builtin' && (o.audio ?? 'local') === 'local' ? 'off' : (o.audio ?? 'local')} onChange={(v) => set({ audio: v })} options={[
          ...(o.mode === 'external' ? [{ value: 'local' as const, label: '이 PC 에서 재생' }] : []),
          { value: 'remote' as const, label: '원격 PC 에서 재생' },
          { value: 'off' as const, label: '재생 안 함' }
        ]} />
      </Field>
      {o.mode === 'builtin' && (
        <div className="toggle">
          <div className="t-label">
            <span>키보드 문자 입력</span>
            <small>키를 스캔 코드 대신 문자로 보냅니다 — 이 PC 와 원격의 자판 배열이 다를 때 켜세요. 단축키는 끈 상태가 더 정확합니다.</small>
          </div>
          <Switch value={!!o.unicodeKeyboard} onChange={(v) => set({ unicodeKeyboard: v || undefined })} />
        </div>
      )}
      <div className="toggle">
        <div className="t-label">
          <span>기본 연결을 RDP 로</span>
          <small>서버 목록에서 더블클릭·Enter·연결 버튼을 누르면 터미널 대신 원격 데스크톱을 엽니다. 터미널은 우클릭 메뉴에서 열 수 있습니다.</small>
        </div>
        <Switch value={!!o.primary} onChange={(v) => set({ primary: v || undefined })} />
      </div>
    </>
  )
}
