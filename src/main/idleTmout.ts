/** 실제 터미널 셸에서 읽는다. 별도 SSH exec 채널의 환경값으로 대체하지 않는다. */
export const TMOUT_READ_COMMAND = `printf '\\n[BrightTerm TMOUT]=%s\\n' "\${TMOUT-__BT_UNSET__}"`

export function readTmoutResult(output: string): string | undefined {
  // 명령 에코의 %s 는 결과로 취급하지 않는다. 줄이 나뉘어 도착하면 다음 조각을 기다린다.
  const match = output.match(/(?:^|[\r\n])\[BrightTerm TMOUT\]=([^\r\n]*)[\r\n]/)
  return match?.[1]
}

export function describeTmout(value: string, intervalSec: number): { message: string; warning: boolean } {
  if (value === '__BT_UNSET__' || value === '') return {
    message: `TMOUT ${value === '' ? '빈 값' : '미설정'} — 이 셸 변수에서 자동 로그아웃 제한을 확인하지 못했습니다. 유휴 방지는 설정된 ${intervalSec}초 간격으로 동작합니다. 서버·방화벽의 별도 시간 제한은 적용될 수 있습니다.`, warning: false
  }
  const clean = value.replace(/[\x00-\x1f\x7f-\x9f]/g, '').slice(0, 80)
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) return {
    message: `TMOUT=${JSON.stringify(clean)} — 초 단위 숫자로 해석할 수 없어 자동 로그아웃 시간을 판단하지 못했습니다. 유휴 방지 간격은 ${intervalSec}초입니다.`, warning: true
  }
  const seconds = Number(value)
  if (!seconds) return { message: `TMOUT=0 — 일반적인 sh·bash·ksh 계열 셸에서는 TMOUT에 의한 자동 로그아웃이 꺼진 값입니다. 유휴 방지는 설정된 ${intervalSec}초 간격으로 동작합니다.`, warning: false }
  const warning = intervalSec >= seconds
  return {
    message: `TMOUT=${seconds}초 — 이 셸에서 입력 없이 프롬프트를 기다릴 때 적용되는 제한 값입니다. 유휴 방지 간격은 ${intervalSec}초입니다. ${warning ? '현재 간격이 TMOUT보다 길거나 같아 먼저 로그아웃될 수 있습니다. 서버 설정에서 유휴 방지 간격을 TMOUT보다 짧게 설정하세요.' : '설정 간격이 TMOUT보다 짧습니다. 셸 프롬프트가 확인될 때만 명령을 보내므로 다른 프로그램 실행 중의 제한까지 보장하지는 않습니다.'}`,
    warning
  }
}
