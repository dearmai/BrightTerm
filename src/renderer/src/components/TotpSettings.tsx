import { useEffect, useMemo, useState } from 'react'
import { Copy, Pencil, Plus, Trash2 } from 'lucide-react'
import { useApp } from '../state'
import { api } from '../api'
import { Field, HelpTip, Seg } from './ui'
import { DEFAULT_SETTINGS, TOTP_PURPOSE_LABELS, type CredentialMeta, type TotpAlgorithm, type TotpCode, type TotpMeta, type TotpPurpose } from '@shared/types'
import { TOTP_DEFAULT_META, isTotpPrompt, isValidBase32, parseOtpauth } from '@shared/totp'

interface Draft {
  id?: string
  name: string
  secret: string
  purpose: TotpPurpose
  issuer: string
  account: string
  digits: TotpMeta['digits']
  period: number
  algorithm: TotpAlgorithm
  note: string
}

const emptyDraft = (purpose: TotpPurpose = 'server'): Draft => ({
  name: '', secret: '', purpose, issuer: '', account: '', note: '',
  digits: TOTP_DEFAULT_META.digits, period: TOTP_DEFAULT_META.period, algorithm: TOTP_DEFAULT_META.algorithm
})

const draftOf = (c: CredentialMeta): Draft => ({
  id: c.id, name: c.name, secret: '', purpose: c.totp?.purpose ?? 'server', issuer: c.totp?.issuer ?? '', account: c.totp?.account ?? '',
  digits: c.totp?.digits ?? 6, period: c.totp?.period ?? 30, algorithm: c.totp?.algorithm ?? 'SHA1', note: c.totp?.note ?? ''
})

/** 설정 → TOTP 인증 — 볼트에 TOTP 를 등록·관리하고, OTP 프롬프트 템플릿을 고친다 */
export function TotpSettings(): JSX.Element {
  const { totps, hosts, vault, settings } = useApp()
  const st = useApp.getState
  const [codes, setCodes] = useState<Record<string, TotpCode>>({})
  const [filter, setFilter] = useState<TotpPurpose | 'all'>('all')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)
  const [probe, setProbe] = useState('')

  // 코드는 메인에서 계산한다 — 비밀키는 화면으로 오지 않는다
  useEffect(() => {
    if (!vault.unlocked || !totps.length) { setCodes({}); return }
    let live = true
    const load = (): void => { api.totp.codes().then((l) => { if (live) setCodes(Object.fromEntries(l.map((c) => [c.id, c]))) }).catch(() => {}) }
    load()
    const t = setInterval(load, 1000)
    return () => { live = false; clearInterval(t) }
  }, [vault.unlocked, totps])

  const shown = useMemo(() => totps.filter((t) => filter === 'all' || (t.totp?.purpose ?? 'server') === filter), [totps, filter])
  const usedBy = (id: string): string[] => hosts.filter((h) => h.totp?.items.some((x) => x.id === id)).map((h) => h.alias || h.host)

  const secretState = (s: string): '' | 'uri' | 'ok' | 'bad' => {
    const v = s.trim()
    if (!v) return ''
    if (/^otpauth:/i.test(v)) { try { return parseOtpauth(v) ? 'uri' : 'bad' } catch { return 'bad' } }
    return isValidBase32(v) ? 'ok' : 'bad'
  }

  const fillFromUri = (d: Draft, value: string): Draft => {
    if (!/^otpauth:/i.test(value.trim())) return { ...d, secret: value }
    try {
      const p = parseOtpauth(value)
      if (!p) return { ...d, secret: value }
      return {
        ...d, secret: value,
        name: d.name || p.issuer || p.label || '',
        issuer: d.issuer || p.issuer || '',
        account: d.account || p.account || '',
        digits: (p.digits as Draft['digits']) ?? d.digits,
        period: p.period ?? d.period,
        algorithm: (p.algorithm as TotpAlgorithm) ?? d.algorithm
      }
    } catch { return { ...d, secret: value } }
  }

  const save = async (): Promise<void> => {
    if (!draft) return
    setBusy(true)
    try {
      await api.totp.save({
        id: draft.id, name: draft.name, secret: draft.secret.trim() || undefined, purpose: draft.purpose,
        issuer: draft.issuer, account: draft.account, note: draft.note, digits: draft.digits, period: draft.period, algorithm: draft.algorithm
      })
      await st().refreshCreds()
      st().toast('ok', draft.id ? 'TOTP 를 수정했습니다' : 'TOTP 를 등록했습니다')
      setDraft(null)
    } catch (e) {
      st().toast('error', (e as Error).message)
    } finally { setBusy(false) }
  }

  const remove = async (c: CredentialMeta): Promise<void> => {
    const used = usedBy(c.id)
    if (!(await st().confirm({
      title: 'TOTP 삭제', danger: true, okText: '삭제',
      message: `"${c.name}" TOTP 를 볼트에서 삭제할까요? 비밀키는 되살릴 수 없습니다.${used.length ? ` ${used.length}개 서버의 TOTP 인증 목록에서도 빠집니다.` : ''}`
    }))) return
    await api.cred.remove(c.id)
    if (used.length) {
      st().save({ hosts: st().hosts.map((h) => (h.totp?.items.some((x) => x.id === c.id) ? { ...h, totp: { ...h.totp, items: h.totp.items.filter((x) => x.id !== c.id) } } : h)) })
    }
    await st().refreshCreds()
    if (draft?.id === c.id) setDraft(null)
  }

  const copy = async (c: CredentialMeta): Promise<void> => {
    const code = codes[c.id]?.code
    if (!code) return
    await api.clip.writeText(code)
    st().toast('ok', `"${c.name}" 코드를 복사했습니다`)
  }

  const sState = draft ? secretState(draft.secret) : ''
  const prompts = settings.totpPrompts ?? DEFAULT_SETTINGS.totpPrompts

  return (
    <>
      {!vault.unlocked && <div className="notice warn">볼트가 잠겨 있어 코드를 볼 수 없고 TOTP 를 등록·수정할 수 없습니다.</div>}

      <div className="row">
        <h3 className="grow" style={{ margin: 0 }}>TOTP 목록 ({totps.length})
          <HelpTip title="TOTP 인증">
            <span>TOTP 비밀키는 <b>볼트에 암호화</b>되어 저장되고 Git 동기화·백업에 함께 들어갑니다.</span>
            <span>서버 편집 → 인증에서 <b>TOTP 인증</b>을 켜면 SSH keyboard-interactive 로 OTP 를 물을 때 고른 TOTP 코드를 자동으로 입력합니다.</span>
            <span><b>용도</b>로 서버 로그인·앱·서비스·기타를 나눠 관리합니다. 앱·서비스용 TOTP 는 여기서 코드를 보고 눌러서 복사합니다.</span>
            <span>비밀키 칸에는 Base32 키나 QR 코드의 <code>otpauth://totp/...</code> URI 를 붙여 넣을 수 있습니다.</span>
          </HelpTip>
        </h3>
        <Seg value={filter} onChange={setFilter} options={[{ value: 'all', label: '전체' }, ...(Object.keys(TOTP_PURPOSE_LABELS) as TotpPurpose[]).map((p) => ({ value: p, label: TOTP_PURPOSE_LABELS[p] }))]} />
        <button className="btn sm primary" disabled={!vault.unlocked} onClick={() => setDraft(emptyDraft(filter === 'all' ? 'server' : filter))}><Plus size={13} /> 추가</button>
      </div>

      {draft && (
        <div className="card totp-form">
          <div className="grid2">
            <Field label="이름"><input className="input" autoFocus value={draft.name} placeholder="예: 운영 베스천 OTP" onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></Field>
            <Field label="용도"><Seg value={draft.purpose} onChange={(v) => setDraft({ ...draft, purpose: v })} options={(Object.keys(TOTP_PURPOSE_LABELS) as TotpPurpose[]).map((p) => ({ value: p, label: TOTP_PURPOSE_LABELS[p] }))} /></Field>
          </div>
          <Field label="비밀키" hint={sState === 'uri' ? 'otpauth URI 에서 발급처·계정·자릿수·주기를 채웠습니다' : sState === 'bad' ? 'Base32(A-Z, 2-7, 8자 이상) 또는 otpauth://totp/... 형식이 아닙니다' : draft.id ? '비워 두면 기존 비밀키를 그대로 씁니다' : '인증 앱 등록용 Base32 키 또는 QR 코드의 otpauth://totp/... URI'}>
            <input className="input mono" type="password" autoComplete="off" value={draft.secret} placeholder={draft.id ? '••••••••  (바꿀 때만 입력)' : 'JBSWY3DPEHPK3PXP 또는 otpauth://totp/...'}
              onChange={(e) => setDraft(fillFromUri(draft, e.target.value))} />
          </Field>
          <div className="grid2">
            <Field label="발급처 (선택)"><input className="input" value={draft.issuer} placeholder="예: Company VPN" onChange={(e) => setDraft({ ...draft, issuer: e.target.value })} /></Field>
            <Field label="계정 (선택)"><input className="input" value={draft.account} placeholder="예: alice@example.com" onChange={(e) => setDraft({ ...draft, account: e.target.value })} /></Field>
          </div>
          <div className="grid3">
            <Field label="자릿수"><Seg value={draft.digits} onChange={(v) => setDraft({ ...draft, digits: v })} options={[{ value: 6, label: '6' }, { value: 7, label: '7' }, { value: 8, label: '8' }]} /></Field>
            <Field label="주기 (초)"><input className="input" type="number" min={10} max={300} value={draft.period} onChange={(e) => setDraft({ ...draft, period: Math.round(+e.target.value) || 30 })} /></Field>
            <Field label="알고리즘">
              <select className="select" value={draft.algorithm} onChange={(e) => setDraft({ ...draft, algorithm: e.target.value as TotpAlgorithm })}>
                {(['SHA1', 'SHA256', 'SHA512'] as TotpAlgorithm[]).map((a) => <option key={a} value={a}>{a}{a === 'SHA1' ? ' (대부분)' : ''}</option>)}
              </select>
            </Field>
          </div>
          <Field label="메모 (선택)"><input className="input" value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} /></Field>
          <div className="row" style={{ justifyContent: 'flex-end', paddingBottom: 10 }}>
            <button className="btn sm" onClick={() => setDraft(null)}>취소</button>
            <button className="btn sm primary" disabled={busy || !draft.name.trim() || sState === 'bad' || (!draft.id && !sState)} onClick={save}>{draft.id ? '저장' : '등록'}</button>
          </div>
        </div>
      )}

      <div className="card" style={{ padding: 0 }}>
        {shown.length === 0 && <div className="empty">{totps.length ? '이 용도의 TOTP 가 없습니다' : '등록된 TOTP 가 없습니다'}</div>}
        {shown.map((c) => {
          const code = codes[c.id]
          const used = usedBy(c.id)
          const sub = [c.totp?.issuer, c.totp?.account].filter(Boolean).join(' · ')
          return (
            <div key={c.id} className="toggle totp-row" style={{ padding: '8px 12px' }}>
              <div className="t-label">
                <span>{c.name} <span className="pill" style={{ background: 'var(--bg-3)' }}>{TOTP_PURPOSE_LABELS[c.totp?.purpose ?? 'server']}</span>{sub && <span className="muted"> {sub}</span>}</span>
                <small>
                  {c.totp && `${c.totp.digits}자리 · ${c.totp.period}초 · ${c.totp.algorithm}`}
                  {used.length ? ` · 사용 서버: ${used.slice(0, 4).join(', ')}${used.length > 4 ? ` 외 ${used.length - 4}` : ''}` : ''}
                  {c.totp?.note ? ` · ${c.totp.note}` : ''}
                </small>
              </div>
              <div className="row">
                {code ? (
                  <button className="totp-code" title="눌러서 복사" onClick={() => copy(c)}>
                    <span className="mono">{code.code.slice(0, Math.ceil(code.code.length / 2))} {code.code.slice(Math.ceil(code.code.length / 2))}</span>
                    <span className="totp-timer" style={{ ['--p' as string]: `${(code.remaining / code.period) * 100}%` }} title={`${code.remaining}초 남음`}><b>{code.remaining}</b></span>
                  </button>
                ) : <span className="muted">{vault.unlocked ? '…' : '잠김'}</span>}
                <button className="ibtn sm" title="코드 복사" disabled={!code} onClick={() => copy(c)}><Copy size={13} /></button>
                <button className="ibtn sm" title="수정" disabled={!vault.unlocked} onClick={() => setDraft(draftOf(c))}><Pencil size={13} /></button>
                <button className="ibtn sm" title="삭제" onClick={() => remove(c)}><Trash2 size={13} /></button>
              </div>
            </div>
          )
        })}
      </div>

      <h3>OTP 프롬프트 템플릿
        <HelpTip title="OTP 프롬프트 템플릿">
          <span>서버가 keyboard-interactive 로 보낸 프롬프트에 이 글자가 들어 있으면 OTP 를 묻는 것으로 보고 TOTP 코드를 넣습니다.</span>
          <span>대소문자·공백 차이는 무시하고, <code>*</code>는 아무 글자와 맞습니다 (예: <code>OTP*for*</code>).</span>
          <span>서버 편집 → 인증에서 TOTP 마다 프롬프트 예시를 따로 정할 수도 있습니다. 아래 칸에 서버가 보여 준 문장을 붙여 넣어 인식되는지 확인하세요.</span>
        </HelpTip>
      </h3>
      <Field label="한 줄에 하나">
        <textarea className="textarea mono" rows={6} value={prompts.join('\n')}
          onChange={(e) => st().setSettings({ totpPrompts: e.target.value.split('\n').map((x) => x.trimEnd()).filter((x, n, a) => x.trim() || n === a.length - 1) })}
          onBlur={() => st().setSettings({ totpPrompts: prompts.map((x) => x.trim()).filter(Boolean) })} />
      </Field>
      <div className="row">
        <input className="input grow" value={probe} placeholder="프롬프트 확인 — 서버가 보여 준 문장을 붙여 넣어 보세요 (예: Verification code: )" onChange={(e) => setProbe(e.target.value)} />
        {probe.trim() && <span className={`pill ${isTotpPrompt(probe, prompts) ? 'ok' : ''}`} style={{ background: 'var(--bg-3)' }}>{isTotpPrompt(probe, prompts) ? 'OTP 로 인식' : '인식 안 됨'}</span>}
        <button className="btn sm" onClick={() => st().setSettings({ totpPrompts: DEFAULT_SETTINGS.totpPrompts })}>기본값으로</button>
      </div>
    </>
  )
}
