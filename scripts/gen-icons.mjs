// Render docs/logo/icon.svg into every committed icon size.
// Usage: npx electron scripts/gen-icons.mjs
import { app, BrowserWindow } from 'electron'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const svg = readFileSync(join(root, 'docs/logo/icon.svg'), 'utf8')

// [output path, canvas size, crop to the plate (no transparent margin)]
const targets = [
  ['build/icon.png', 1024, false],
  ['resources/icon.png', 1024, false],
  ['src/renderer/src/assets/logo.png', 256, true],
  ...[16, 24, 32, 48, 64, 128, 256, 512].map((s) => [`build/icons/${s}x${s}.png`, s, false])
]

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false })
  await win.loadURL('data:text/html,<html><body></body></html>')
  const render = (size, crop) =>
    win.webContents.executeJavaScript(`(async () => {
      const img = new Image()
      img.src = ${JSON.stringify('data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64'))}
      await img.decode()
      const c = document.createElement('canvas')
      c.width = c.height = ${size}
      const ctx = c.getContext('2d')
      // The plate spans 100..924 of the 1024 viewBox; cropping scales it to fill the canvas.
      const scale = ${crop} ? 1024 / 824 : 1
      const off = ${crop} ? -100 * ${size} / 824 : 0
      ctx.drawImage(img, off, off, ${size} * scale, ${size} * scale)
      return c.toDataURL('image/png')
    })()`)
  for (const [out, size, crop] of targets) {
    const url = await render(size, crop)
    const file = join(root, out)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, Buffer.from(url.split(',')[1], 'base64'))
    console.log(out)
  }
  app.quit()
})
