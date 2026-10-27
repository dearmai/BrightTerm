const { signAsync } = require('@electron/osx-sign')
const { prepareMacosSigning } = require('./prepare-macos-signing.cjs')

// Local installs always reuse BrightTerm's dedicated self-signed identity.
// No timestamp service is needed for local builds.
module.exports = async function signMacosLocal(options) {
  const { identity, keychain } = prepareMacosSigning()
  console.log(`  • local signing (identity=${identity}, timestamp=none)`)
  await signAsync({
    ...options,
    identity,
    keychain,
    identityValidation: false,
    optionsForFile: (file) => ({
      ...options.optionsForFile?.(file),
      hardenedRuntime: false,
      timestamp: 'none'
    })
  })
}
