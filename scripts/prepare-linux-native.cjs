// node-pty has no Linux prebuilds. npmRebuild is disabled because the other
// native dependencies ship Node-API prebuilds, so fix the packaged PTY here.
// Build in isolation to preserve the host module used by npm run dev.
const { execFileSync } = require('node:child_process')
const { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } = require('node:fs')
const { join } = require('node:path')
const { Arch } = require('builder-util')

const machines = { x64: 62, arm64: 183 }

function matchesArch(file, arch) {
  try {
    const header = readFileSync(file).subarray(0, 20)
    return header.length === 20 && header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) &&
      header[4] === 2 && header[5] === 1 && header.readUInt16LE(18) === machines[arch]
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'linux') return
  const arch = Arch[context.arch]
  if (!machines[arch]) return
  const destination = join(context.appOutDir, 'resources', 'app.asar.unpacked', 'node_modules', 'node-pty', 'build', 'Release', 'pty.node')
  if (matchesArch(destination, arch)) return
  if (process.platform !== 'linux') throw new Error('Build Linux packages on Linux (native or with a cross compiler).')

  const env = { ...process.env }
  if (arch !== process.arch) {
    const prefix = arch === 'arm64' ? 'aarch64-linux-gnu' : 'x86_64-linux-gnu'
    env.CC = env.CC || `${prefix}-gcc`
    env.CXX = env.CXX || `${prefix}-g++`
    env.AR = env.AR || `${prefix}-ar`
    for (const compiler of [env.CC, env.CXX, env.AR]) {
      try { execFileSync(compiler, ['--version'], { stdio: 'ignore' }) }
      catch { throw new Error(`Cross compiler not found: ${compiler}. For arm64 on Debian/Ubuntu, install gcc-aarch64-linux-gnu and g++-aarch64-linux-gnu, or build on an arm64 Linux machine.`) }
    }
  }

  const root = context.packager.projectDir
  const source = join(root, 'node_modules', 'node-pty')
  const temporary = mkdtempSync(join(root, 'node_modules', '.brightterm-pty-'))
  try {
    copyFileSync(join(source, 'binding.gyp'), join(temporary, 'binding.gyp'))
    cpSync(join(source, 'src'), join(temporary, 'src'), { recursive: true })
    console.log(`  • building Linux node-pty (${arch})`)
    // node-pty uses Node-API, so the host Node headers also work in Electron.
    execFileSync(process.execPath, [require.resolve('node-gyp/bin/node-gyp.js'), 'rebuild', `--arch=${arch}`, `--target=${process.versions.node}`], {
      cwd: temporary, env, stdio: 'inherit'
    })
    const binary = join(temporary, 'build', 'Release', 'pty.node')
    if (!matchesArch(binary, arch)) throw new Error(`node-pty was not compiled for ${arch}. Check CC/CXX/AR.`)
    mkdirSync(join(destination, '..'), { recursive: true })
    copyFileSync(binary, destination)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}
