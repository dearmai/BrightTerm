import { useState } from 'react'
import { ArrowDown, ArrowUp, Plus, X } from 'lucide-react'
import { useApp } from '../state'
import { Field, HelpTip, Toggle } from './ui'
import { TOTP_PURPOSE_LABELS, type HostTotp } from '@shared/types'

/**
 * 서버 편집: OTP 프롬프트에 쓸 TOTP 고르기 (여러 개면 위에서부터 차례로).
 * SSH 는 keyboard-interactive + (선택) 터미널 프롬프트, 텔넷(terminalOnly)은 터미널 프롬프트만
 */
export function HostTotpEditor(props: { value?: HostTotp; onChange: (v: HostTotp) => void; terminalOnly?: boolean }): JSX.Element {
  const totps = useApp((s) => s.totps)
  const templates = useApp((s) => s.settings.totpPrompts) ?? []
  const v: HostTotp = props.value ?? { enabled: false, items: [] }
  const [pick, setPick] = useState('')
  const set = (p: Partial<HostTotp>): void => props.onChange({ ...v, ...p })
  const setItem = (n: number, p: Partial<HostTotp['items'][number]>): void => set({ items: v.items.map((x, i) => (i === n ? { ...x, ...p } : x)) })
  const terminal = props.terminalOnly || !!v.terminal
  const move = (n: number, d: -1 | 1): void => {
    const items = [...v.items]
    ;[items[n], items[n + d]] = [items[n + d], items[n]]
    set({ items })
  }
  const free = totps
    .filter((t) => !v.items.some((x) => x.id === t.id))
    .sort((a, b) => Number(b.totp?.purpose === 'server') - Number(a.totp?.purpose === 'server') || a.name.localeCompare(b.name))
  const label = (id: string): string => {
    const t = totps.find((x) => x.id === id)
    return t ? `${t.name}${t.totp?.issuer ? ` (${t.totp.issuer})` : ''}` : '삭제된 TOTP'
  }

  return (
    <>
      <h3>TOTP 인증</h3>
      <div className="card">
        <Toggle label={<>TOTP 인증 사용
          <HelpTip title="TOTP 인증">
            {props.terminalOnly ? (
              <span>로그인 뒤 터미널에 OTP 프롬프트가 나오면 아래 TOTP 의 코드를 입력합니다 (접속하고 2분 동안).</span>
            ) : <>
              <span>SSH keyboard-interactive 로 OTP 를 물으면 아래 TOTP 의 코드를 자동으로 입력합니다. 비밀번호와 OTP 를 함께 묻는 서버도 됩니다.</span>
              <span>코드가 거부되거나 볼트가 잠겨 있으면 직접 입력하도록 묻습니다.</span>
            </>}
            <span>TOTP 는 설정 → TOTP 인증에서 등록합니다.</span>
          </HelpTip></>} desc="OTP 프롬프트에 TOTP 코드 자동 입력"
          value={v.enabled} onChange={(enabled) => set({ enabled })} />
        {v.enabled && !props.terminalOnly && (
          <Toggle label={<>터미널 프롬프트에도 입력
            <HelpTip title="터미널 OTP 프롬프트">
              <span>SSH 로그인은 끝났는데 그 뒤 터미널에 OTP 를 묻는 경우(베스천 메뉴, 셸의 2단계 인증 스크립트 등)에 씁니다.</span>
              <span>접속하고 2분 동안, 출력이 멈춘 마지막 줄이 <code>:</code>·<code>?</code>·<code>&gt;</code> 등으로 끝나고 OTP 프롬프트와 맞으면 코드를 입력합니다.</span>
              <span>코드만 넣으면 바로 확인하는 프롬프트는 TOTP 오른쪽의 <b>Enter</b> 를 끄세요.</span>
            </HelpTip></>} desc="로그인 뒤 터미널에 나오는 OTP 프롬프트"
            value={!!v.terminal} onChange={(t) => set({ terminal: t })} />
        )}
      </div>
      {v.enabled && (
        <Field label={<>사용할 TOTP
          <HelpTip title="사용할 TOTP">
            <span>OTP 프롬프트가 여러 번 나오면 위에서부터 차례로 하나씩 씁니다.</span>
            <span>오른쪽 칸에 프롬프트 예시를 적은 TOTP 는 그 프롬프트에만 씁니다 (예: <code>Company OTP</code>, <code>*</code>는 아무 글자).</span>
            <span>비워 두면 설정 → TOTP 인증의 OTP 프롬프트 템플릿으로 알아봅니다.</span>
          </HelpTip></>}>
          {v.items.length === 0 && <div className="muted" style={{ marginBottom: 6 }}>아직 고른 TOTP 가 없습니다</div>}
          {v.items.map((it, n) => (
            <div key={it.id} className="totp-host-item">
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} className={totps.some((t) => t.id === it.id) ? '' : 'muted'}>{n + 1}. {label(it.id)}</span>
              <input className="input mono" list="totp-prompt-templates" value={it.prompt ?? ''} placeholder="비우면 앱 템플릿" title="이 TOTP 를 쓸 프롬프트 예시 — 비우면 설정의 OTP 프롬프트 템플릿으로 인식" onChange={(e) => setItem(n, { prompt: e.target.value })} />
              {terminal ? (
                <label className="totp-enter" title="터미널 프롬프트에 코드를 넣은 뒤 Enter 도 보냅니다 — 자릿수가 차면 바로 확인하는 프롬프트는 끄세요">
                  <input type="checkbox" checked={it.enter !== false} onChange={(e) => setItem(n, { enter: e.target.checked })} />Enter
                </label>
              ) : <span />}
              <button type="button" className="ibtn sm" title="위로" disabled={n === 0} onClick={() => move(n, -1)}><ArrowUp size={13} /></button>
              <button type="button" className="ibtn sm" title="아래로" disabled={n === v.items.length - 1} onClick={() => move(n, 1)}><ArrowDown size={13} /></button>
              <button type="button" className="ibtn sm" title="빼기" onClick={() => set({ items: v.items.filter((_x, i) => i !== n) })}><X size={13} /></button>
            </div>
          ))}
          <datalist id="totp-prompt-templates">{templates.filter(Boolean).map((t) => <option key={t} value={t} />)}</datalist>
          {totps.length === 0 ? (
            <div className="notice warn">등록된 TOTP 가 없습니다. 설정 → TOTP 인증에서 먼저 등록하세요.</div>
          ) : free.length > 0 && (
            <div className="row">
              <select className="select grow" value={pick} onChange={(e) => setPick(e.target.value)}>
                <option value="">TOTP 선택…</option>
                {free.map((t) => <option key={t.id} value={t.id}>{t.name}{t.totp?.issuer ? ` (${t.totp.issuer})` : ''} · {TOTP_PURPOSE_LABELS[t.totp?.purpose ?? 'server']}</option>)}
              </select>
              <button type="button" className="btn sm" disabled={!pick} onClick={() => { set({ items: [...v.items, { id: pick }] }); setPick('') }}><Plus size={13} />추가</button>
            </div>
          )}
        </Field>
      )}
    </>
  )
}
