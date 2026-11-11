import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TMOUT_READ_COMMAND, readTmoutResult, describeTmout } from '../src/main/idleTmout.ts'

test('TMOUT 조회 결과만 읽고 명령 에코와 불완전한 응답은 무시한다', () => {
  assert.equal(readTmoutResult(TMOUT_READ_COMMAND + '\r\n$ '), undefined)
  assert.equal(readTmoutResult('\r\n[BrightTerm TMOUT]=600'), undefined)
  assert.equal(readTmoutResult('\r\n[BrightTerm TMOUT]=600\r\n$ '), '600')
  assert.equal(readTmoutResult('\n[BrightTerm TMOUT]=\n'), '')
  assert.equal(readTmoutResult('\n[BrightTerm TMOUT]=__BT_UNSET__\n'), '__BT_UNSET__')
  assert.match(TMOUT_READ_COMMAND, /\$\{TMOUT-__BT_UNSET__\}/)
})
test('값·간격 비교와 미설정·0·비숫자 값을 구분해 설명한다', () => {
  assert.equal(describeTmout('600', 240).warning, false)
  assert.match(describeTmout('600', 240).message, /TMOUT=600초/)
  assert.equal(describeTmout('240', 240).warning, true)
  assert.equal(describeTmout('60', 240).warning, true)
  assert.match(describeTmout('60', 240).message, /짧게 설정/)
  assert.match(describeTmout('0', 240).message, /자동 로그아웃이 꺼진 값/)
  assert.match(describeTmout('__BT_UNSET__', 240).message, /미설정/)
  assert.match(describeTmout('', 240).message, /빈 값/)
  assert.equal(describeTmout('invalid\x1b', 240).warning, true)
  assert.doesNotMatch(describeTmout('invalid\x1b', 240).message, /\x1b/)
})
