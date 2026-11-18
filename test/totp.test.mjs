import assert from 'node:assert/strict'
import { test } from 'node:test'
import { base32Decode, remainingSec, totpAt } from '../src/main/totpCore.ts'
import { isTotpPrompt, isValidBase32, matchesPromptExample, normalizeTotpMeta, parseOtpauth, resolveTotpInput } from '../src/shared/totp.ts'

// src/shared/types.ts 의 DEFAULT_SETTINGS.totpPrompts 와 같게 유지
const PROMPTS = ['Verification code', 'One-time password', 'One time password', 'OTP', 'Passcode', 'Token code', 'Authenticator code', 'Google Authenticator', '인증 코드', '인증번호', '일회용 비밀번호']

test('RFC 6238 부록 B 테스트 벡터 (SHA1·SHA256·SHA512, 8자리)', () => {
  const keys = {
    SHA1: Buffer.from('12345678901234567890'),
    SHA256: Buffer.from('12345678901234567890123456789012'),
    SHA512: Buffer.from('1234567890123456789012345678901234567890123456789012345678901234')
  }
  const vectors = [
    [59, '94287082', '46119246', '90693936'],
    [1111111109, '07081804', '68084774', '25091201'],
    [1111111111, '14050471', '67062674', '99943326'],
    [1234567890, '89005924', '91819424', '93441116'],
    [2000000000, '69279037', '90698825', '38618901'],
    [20000000000, '65353130', '77737706', '47863826']
  ]
  for (const [t, sha1, sha256, sha512] of vectors) {
    assert.equal(totpAt(keys.SHA1, { digits: 8, period: 30, algorithm: 'SHA1' }, t * 1000), sha1)
    assert.equal(totpAt(keys.SHA256, { digits: 8, period: 30, algorithm: 'SHA256' }, t * 1000), sha256)
    assert.equal(totpAt(keys.SHA512, { digits: 8, period: 30, algorithm: 'SHA512' }, t * 1000), sha512)
  }
  assert.equal(totpAt(keys.SHA1, { digits: 6, period: 30, algorithm: 'SHA1' }, 59000), '287082')
  assert.equal(remainingSec(30, 59000), 1)
  assert.equal(remainingSec(30, 60000), 30)
})

test('Base32 — 인증 앱이 보여 주는 소문자·띄어쓰기·패딩도 받는다', () => {
  assert.equal(base32Decode('gezd gnbv gy3t qojq gezd gnbv gy3t qojq').toString(), '12345678901234567890')
  assert.equal(base32Decode('MZXW6===').toString(), 'foo')
  assert.throws(() => base32Decode('ABC1'))
  assert.equal(isValidBase32('JBSW Y3DP EHPK 3PXP'), true)
  assert.equal(isValidBase32('JBSWY3D'), false)
  assert.equal(isValidBase32('JBSW1Y3DPEHP'), false)
})

test('OTP 프롬프트 인식 — 비밀번호 프롬프트와 구분', () => {
  for (const p of ['Verification code: ', 'OTP: ', "One-time password (OATH) for `alice': ", 'Passcode:', 'Enter Token code:', '인증 코드: ', 'Google Authenticator Code:']) {
    assert.equal(isTotpPrompt(p, PROMPTS), true, p)
  }
  for (const p of ['Password: ', "alice@host's password: ", 'Enter passphrase for key: ']) assert.equal(isTotpPrompt(p, PROMPTS), false, p)
  assert.equal(matchesPromptExample('OTP for alice: ', 'otp*for*'), true)
  assert.equal(matchesPromptExample('Verification  code:', 'verification code'), true)
  assert.equal(matchesPromptExample('price (USD)?', '(usd)?'), true)
  assert.equal(matchesPromptExample('anything', '*'), false)
  assert.equal(matchesPromptExample('anything', '  '), false)
})

test('otpauth URI 와 설정 검사', () => {
  const u = parseOtpauth('otpauth://totp/ACME%20Co:alice@example.com?secret=JBSWY3DPEHPK3PXP&issuer=ACME%20Co&algorithm=SHA256&digits=8&period=60')
  assert.deepEqual([u.issuer, u.account, u.digits, u.period, u.algorithm, u.secret], ['ACME Co', 'alice@example.com', 8, 60, 'SHA256', 'JBSWY3DPEHPK3PXP'])
  assert.throws(() => parseOtpauth('otpauth://hotp/x?secret=AAAAAAAA&counter=1'), /HOTP/)
  assert.equal(parseOtpauth('JBSWY3DPEHPK3PXP'), null)
  const r = resolveTotpInput({ name: '운영', secret: 'otpauth://totp/A:b?secret=JBSWY3DPEHPK3PXP&digits=8', issuer: '' })
  assert.deepEqual([r.name, r.issuer, r.account, r.digits, r.secret], ['운영', 'A', 'b', 8, 'JBSWY3DPEHPK3PXP'])
  assert.throws(() => normalizeTotpMeta({ digits: 5 }))
  assert.throws(() => normalizeTotpMeta({ period: 5 }))
  assert.throws(() => normalizeTotpMeta({ algorithm: 'MD5' }))
  assert.deepEqual(normalizeTotpMeta({}), { purpose: 'server', digits: 6, period: 30, algorithm: 'SHA1', issuer: undefined, account: undefined, note: undefined })
  assert.equal(normalizeTotpMeta({ purpose: 'app' }, { purpose: 'server', digits: 8, period: 60, algorithm: 'SHA1', issuer: 'X' }).issuer, 'X')
})

test('터미널 OTP 프롬프트 줄 — 출력 끝의 열린 줄만, 입력을 기다리는 모양일 때', async () => {
  const { pendingPromptLine } = await import('../src/main/totpTerminal.ts')
  assert.equal(pendingPromptLine('Welcome\r\nOTP: '), 'OTP:')
  assert.equal(pendingPromptLine('\x1b[1;33mVerification code?\x1b[0m '), 'Verification code?')
  assert.equal(pendingPromptLine('menu\r\n[OTP] > '), '[OTP] >')
  assert.equal(pendingPromptLine('Enter token (6 digits)'), 'Enter token (6 digits)')
  assert.equal(pendingPromptLine('OTP: \r\n'), null, '줄이 끝났으면 기다리는 프롬프트가 아니다')
  assert.equal(pendingPromptLine('OTP: 123456'), null, '코드가 되울려진 줄')
  assert.equal(pendingPromptLine('OTP: ******'), null)
  assert.equal(pendingPromptLine('your OTP was accepted'), null)
  assert.equal(pendingPromptLine(''), null)
  assert.equal(pendingPromptLine('x'.repeat(250) + ':'), null)
})
