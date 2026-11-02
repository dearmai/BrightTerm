/** macOS does not expose a reliable API for distinguishing a denied LAN request
 * from routing/firewall failures. Offer troubleshooting without claiming denial. */
export function localNetworkHelp(error: unknown, protocol: string, platform = process.platform): string | undefined {
  if (platform !== 'darwin' || (protocol !== 'ssh' && protocol !== 'telnet')) return
  const e = error as { code?: string; message?: string } | null
  const message = `${e?.code ?? ''} ${e?.message ?? String(error)}`
  if (!/\b(?:EHOSTUNREACH|ENETUNREACH|EHOSTDOWN|ENETDOWN|EACCES|EPERM|ETIMEDOUT)\b|timed?\s*out|(?:응답|연결) 시간 초과|no route to host|network is unreachable|operation not permitted|permission denied/i.test(message)) return
  // Authentication failures also use “Permission denied”; these are server errors.
  if (/authentication|인증 실패|permission denied\s*\(/i.test(message)) return
  return [
    '내부 네트워크 서버에 접속 중이라면 macOS 로컬 네트워크 권한을 확인하세요. 권한 차단 외에 주소·VPN·방화벽 문제로도 같은 오류가 날 수 있습니다.',
    '시스템 설정 → 개인정보 보호 및 보안 → 로컬 네트워크 → BrightTerm을 켜세요.',
    '이미 켜져 있다면 BrightTerm을 ⌘Q로 완전히 종료한 뒤, 권한을 껐다 켜고 앱을 다시 실행하세요.',
    '목록에 없다면 BrightTerm을 ⌘Q로 종료하고 /Applications/BrightTerm.app을 다시 열어 내부 서버에 접속한 뒤 권한 요청이 표시되면 허용하세요.',
    '계속 목록에 없다면 앱 서명·설치 상태를 확인해야 합니다. tccutil reset으로는 이 권한을 초기화할 수 없으며, 목록에서 앱을 제거하는 버튼이 없는 macOS 버전에서는 권한 팝업을 초기화하는 공식 방법이 없습니다.',
    '권한을 변경한 뒤 다시 접속하세요.'
  ].join('\r\n')
}
