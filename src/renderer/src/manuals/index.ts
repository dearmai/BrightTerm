import aix from './aix.md?raw'
import ksh from './ksh.md?raw'
import { parseManual, type ManualId, type ManualSection } from './manual'

export const MANUALS: { id: ManualId; title: string; sections: ManualSection[] }[] = [
  { id: 'aix', title: 'AIX 7.2 – 7.3', sections: parseManual(aix) },
  { id: 'ksh', title: 'ksh (Korn shell)', sections: parseManual(ksh) }
]
