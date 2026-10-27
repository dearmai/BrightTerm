const { execFileSync } = require('node:child_process')
const { randomBytes, X509Certificate } = require('node:crypto')
const { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, chmodSync } = require('node:fs')
const { homedir, tmpdir } = require('node:os')
const { join } = require('node:path')

const directory = process.env.BRIGHTTERM_SIGNING_DIR || join(homedir(), 'Library', 'Application Support', 'BrightTerm', 'build-signing')
const keychain = join(directory, 'local-signing.keychain-db')
const passwordFile = join(directory, 'keychain-password')
const certificateFile = join(directory, 'certificate.pem')
const security = (...args) => {
  try { return execFileSync('/usr/bin/security', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }
  catch (error) { throw new Error(`security ${args[0]} failed: ${error.stderr?.toString().trim() || `exit ${error.status}`}`) }
}

function prepareMacosSigning() {
  if (process.platform !== 'darwin') throw new Error('Local macOS signing requires macOS')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  chmodSync(directory, 0o700)
  if (!existsSync(keychain)) {
    if (existsSync(certificateFile)) throw new Error(`Signing keychain is missing. Restore it from backup: ${directory}`)
    const password = randomBytes(32).toString('hex')
    writeFileSync(passwordFile, password, { mode: 0o600 })
    const temporary = mkdtempSync(join(tmpdir(), 'brightterm-signing-'))
    try {
      const key = join(temporary, 'key.pem')
      const certificate = join(temporary, 'certificate.pem')
      const bundle = join(temporary, 'identity.p12')
      const config = join(temporary, 'openssl.cnf')
      writeFileSync(config, '[req]\nprompt=no\ndistinguished_name=subject\nx509_extensions=extensions\n[subject]\nCN=BrightTerm Local Development\n[extensions]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=codeSigning\n')
      execFileSync('/usr/bin/openssl', ['req', '-new', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-days', '3650', '-config', config, '-keyout', key, '-out', certificate], { stdio: 'pipe' })
      const bundlePassword = randomBytes(24).toString('hex')
      execFileSync('/usr/bin/openssl', ['pkcs12', '-export', '-inkey', key, '-in', certificate, '-out', bundle, '-passout', 'env:BRIGHTTERM_P12_PASSWORD'], { stdio: 'pipe', env: { ...process.env, BRIGHTTERM_P12_PASSWORD: bundlePassword } })
      security('create-keychain', '-p', password, keychain)
      security('unlock-keychain', '-p', password, keychain)
      security('import', bundle, '-k', keychain, '-P', bundlePassword, '-T', '/usr/bin/codesign')
      security('set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-s', '-k', password, keychain)
      writeFileSync(certificateFile, readFileSync(certificate), { mode: 0o600 })
      console.log(`  • created local signing certificate: ${certificateFile}`)
    } catch (error) {
      // A partial creation has no usable identity. Never replace an existing certificate.
      if (existsSync(keychain)) { try { security('delete-keychain', keychain) } catch {} }
      rmSync(passwordFile, { force: true })
      throw new Error('Could not create the local signing identity. ' + (error.stderr?.toString().trim() || error.message))
    } finally {
      rmSync(temporary, { recursive: true, force: true })
    }
  } else {
    console.log(`  • reusing local signing certificate: ${certificateFile}`)
  }
  if (!existsSync(passwordFile) || !existsSync(certificateFile)) throw new Error(`Local signing identity is incomplete; restore its files: ${directory}`)
  chmodSync(passwordFile, 0o600)
  security('unlock-keychain', '-p', readFileSync(passwordFile, 'utf8'), keychain)
  // codesign also resolves the certificate chain through the user search list,
  // even when --keychain is supplied. Preserve every existing entry.
  const searchList = [...security('list-keychains', '-d', 'user').matchAll(/"([^"]+)"/g)].map((m) => m[1])
  if (!searchList.includes(keychain)) security('list-keychains', '-d', 'user', '-s', ...searchList, keychain)
  const certificate = new X509Certificate(readFileSync(certificateFile))
  if (Date.parse(certificate.validTo) <= Date.now()) throw new Error('Local signing certificate has expired; renew it explicitly to avoid silently changing app identity')
  const identity = certificate.fingerprint.replaceAll(':', '')
  if (!security('find-identity', '-p', 'codesigning', keychain).includes(identity)) throw new Error(`Private signing identity not found in ${keychain}`)
  if (!security('find-identity', '-v', '-p', 'codesigning', keychain).includes(identity)) {
    console.log('  • registering certificate trust for code signing (macOS may request approval once)')
    security('add-trusted-cert', '-r', 'trustRoot', '-p', 'codeSign', '-k', keychain, certificateFile)
    if (!security('find-identity', '-v', '-p', 'codesigning', keychain).includes(identity)) throw new Error('The local certificate was not trusted for code signing')
  }
  return { identity, keychain }
}

// Also prepare direct `npm run dist:mac*` builds before identity discovery.
module.exports = function beforePack(context) {
  if (context.electronPlatformName === 'darwin' && context.packager.platformSpecificBuildOptions.identity === 'BrightTerm Local Development') prepareMacosSigning()
}
module.exports.prepareMacosSigning = prepareMacosSigning
if (require.main === module) {
  try { prepareMacosSigning() }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
