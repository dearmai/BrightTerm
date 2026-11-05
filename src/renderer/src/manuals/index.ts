import aix from './aix.md?raw'
import ksh from './ksh.md?raw'
import rhel9 from './rhel9.md?raw'
import rhel10 from './rhel10.md?raw'
import rhelCommon from './rhel-common.md?raw'
import bash from './bash.md?raw'
import zsh from './zsh.md?raw'
import { parseManual, withCommon, type ManualId, type ManualSection } from './manual'

export const MANUALS: { id: ManualId; title: string; sections: ManualSection[] }[] = [
  { id: 'aix', title: 'AIX 7.2 – 7.3', sections: parseManual(aix) },
  { id: 'rhel9', title: 'RHEL 9', sections: withCommon(rhel9, rhelCommon) },
  { id: 'rhel10', title: 'RHEL 10', sections: withCommon(rhel10, rhelCommon) },
  { id: 'ksh', title: 'ksh (Korn shell)', sections: parseManual(ksh) },
  { id: 'bash', title: 'bash', sections: parseManual(bash) },
  { id: 'zsh', title: 'zsh', sections: parseManual(zsh) }
]
