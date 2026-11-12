import { readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const LAST_BUILD_ID_FILE = '.last-build-id'

/** 버전_YYYYMMDD_SEQ — SEQ 는 이 PC 에서 같은 버전·같은 날 빌드한 순번(1부터) */
function nextBuildId(version: string): string {
  const now = new Date()
  const date = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
  const prefix = `${version}_${date}_`
  let last = ''
  try { last = readFileSync(LAST_BUILD_ID_FILE, 'utf8').trim() } catch { /* 첫 빌드 */ }
  const seq = last.startsWith(prefix) ? Number(last.slice(prefix.length)) + 1 : 1
  const id = `${prefix}${seq}`
  writeFileSync(LAST_BUILD_ID_FILE, `${id}\n`)
  return id
}

export default defineConfig(({ command }) => {
  const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }
  const buildId = command === 'build' ? nextBuildId(version) : `${version}_dev`
  return {
    main: {
      plugins: [externalizeDepsPlugin()],
      resolve: { alias: { '@shared': resolve('src/shared') } },
      define: { __BUILD_ID__: JSON.stringify(buildId) }
    },
    preload: {
      plugins: [externalizeDepsPlugin()],
      resolve: { alias: { '@shared': resolve('src/shared') } }
    },
    renderer: {
      resolve: {
        alias: {
          '@renderer': resolve('src/renderer/src'),
          '@shared': resolve('src/shared')
        }
      },
      plugins: [react()],
      // rdp.html: 내장 원격 데스크톱 창 — IronRDP(WASM) 는 이 창에서만 읽는다
      build: { rollupOptions: { input: { index: resolve('src/renderer/index.html'), rdp: resolve('src/renderer/rdp.html') } } }
    }
  }
})
