/** Mouse protocols and encodings. Reset only these modes, preserving screen/history. */
const MOUSE_MODES = new Set([9, 1000, 1001, 1002, 1003, 1005, 1006, 1007, 1015, 1016])
export const RESET_MOUSE = '\x18\x1b[?' + [...MOUSE_MODES].join(';') + 'l'

/** xterm.js emits these through onData (or onBinary for legacy X10). */
export function isMouseReport(data: string): boolean {
  return /^(?:\x1b\[M[\s\S]{3}|\x1b\[<\d+;\d+;\d+[Mm]|\x1b\[\d+;\d+;\d+M)$/.test(data)
}

/** Remove mouse mode requests without removing other modes in the same CSI.
 * Keep incomplete CSI prefixes across SSH packets so split requests cannot bypass the setting.
 */
export class MouseModeFilter {
  private pending = ''

  reset(): void { this.pending = '' }

  push(data: string, blocked: boolean): string {
    let text = this.pending + data
    this.pending = ''
    if (!blocked) return text
    const tail = text.match(/\x1b(?:\[(?:\?[0-9;]*)?)?$/)
    if (tail) {
      this.pending = tail[0]
      text = text.slice(0, -this.pending.length)
    }
    return text.replace(/\x1b\[\?([0-9;]*)([hl])/g, (sequence, params: string, final: string) => {
      const kept = params.split(';').filter((p) => !MOUSE_MODES.has(Number(p)))
      return kept.length ? `\x1b[?${kept.join(';')}${final}` : ''
    })
  }
}
