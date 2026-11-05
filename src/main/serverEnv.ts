import type { ServerEnv } from '@shared/types'

// 터미널에 입력하지 않고 별도 명령 채널로 묻는다. oslevel 은 오래 걸릴 수 있어 uname 만 쓴다.
export const SERVER_ENV_SCRIPT = `
export LC_ALL=C
printf 'BT_OS %s\\n' "$(uname -s)"
printf 'BT_REL %s\\n' "$(uname -r)"
printf 'BT_VER %s\\n' "$(uname -v)"
printf 'BT_SHELL %s\\n' "\${SHELL:-$(awk -F: -v u="$(id -un)" '$1==u {print $7}' /etc/passwd)}"
`

/** 접속 때 로그인 스크립트가 찍는 글이 섞여도 되도록 BT_ 줄만 읽는다. OS 를 모르면 null */
export function parseServerEnv(output: string): ServerEnv | null {
  const read = (key: string): string => output.match(new RegExp(`^${key} (.*)$`, 'm'))?.[1].trim() ?? ''
  const os = read('BT_OS')
  if (!os) return null
  // AIX 는 uname -v 가 주 버전, -r 이 부 버전이다 (7.3 이면 7 과 3)
  const osVersion = os === 'AIX' ? `${read('BT_VER')}.${read('BT_REL')}` : read('BT_REL')
  return { os, osVersion, shell: read('BT_SHELL') }
}
