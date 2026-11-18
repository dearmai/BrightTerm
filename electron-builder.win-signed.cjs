// Windows 셀프 인증서 서명 (사내·폐쇄망 배포용)
//   1) 처음 한 번: powershell -ExecutionPolicy Bypass -File scripts\codesign-cert.ps1
//   2) npm run dist:win:signed
// 인증서는 현재 사용자 저장소(Cert:\CurrentUser\My)에서 지문으로 지정한다 — .pfx·비밀번호를 설정에 두지 않는다.
// 빌드 PC 마다 인증서가 다르면 .env 의 BRIGHTTERM_CODESIGN_SHA1 (환경 변수가 먼저)로 지문을 덮어쓴다.
// 셀프 인증서라 배포 대상 PC 에 서명한 인증서의 .cer 를 등록해야 '신뢰된 게시자'로 보인다(install-cert.cmd).
const { envValue } = require('./scripts/read-env.cjs')

const DEFAULT_SHA1 = '32FA25DC5BE857930C7579D87E30CAE73F01E9E0'
const sha1 = (envValue('BRIGHTTERM_CODESIGN_SHA1') || DEFAULT_SHA1).replace(/\s+/g, '').toUpperCase()
if (!/^[0-9A-F]{40}$/.test(sha1)) throw new Error(`BRIGHTTERM_CODESIGN_SHA1 이 SHA-1 지문(16진수 40자)이 아닙니다: ${sha1}`)
console.log(`  • code signing certificate  sha1=${sha1}${sha1 === DEFAULT_SHA1 ? '' : ' (from BRIGHTTERM_CODESIGN_SHA1)'}`)

module.exports = {
  extends: './electron-builder.yml',
  win: {
    signtoolOptions: {
      certificateSubjectName: 'Dany Kim',
      certificateSha1: sha1,
      publisherName: 'Dany Kim',
      signingHashAlgorithms: ['sha256'],
      rfc3161TimeStampServer: 'http://timestamp.digicert.com'
    }
  }
}
