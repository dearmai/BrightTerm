// 저장소 루트의 .env 를 읽는다 (make install 이 PC 마다 다른 값을 쓰는 곳). .env.example 참고.
const { existsSync, readFileSync } = require('node:fs')
const { join } = require('node:path')

/** KEY=VALUE 한 줄씩. # 주석, 앞뒤 따옴표 허용 */
function readEnv(file = join(__dirname, '..', '.env')) {
  const out = {}
  if (!existsSync(file)) return out
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!m) continue
    let v = m[2].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    out[m[1]] = v
  }
  return out
}

/** 환경 변수가 있으면 그 값, 없으면 .env 값 (앞뒤 공백 제거, 없으면 '') */
function envValue(name, env = readEnv()) {
  return (process.env[name] ?? env[name] ?? '').trim()
}

module.exports = { readEnv, envValue }
