import { execFile } from 'child_process'
import { performance } from 'perf_hooks'
import type { Client, ClientChannel } from 'ssh2'
import type { SessionMetrics } from '@shared/types'
import type { Session } from './sessions'

// No terminal input or sudo: use a separate, short-lived command channel.
export const METRICS_SCRIPT = `
export LC_ALL=C
case "$(uname -s)" in
  Linux)
    awk '{printf "UPTIME %.0f\\n",int($1)}' /proc/uptime
    awk '/^cpu / {t=0; for(i=2;i<=9;i++) t+=$i; printf "COUNTER %.0f %.0f\\n",t,$5+$6}' /proc/stat
    sleep 1
    awk '/^cpu / {t=0; for(i=2;i<=9;i++) t+=$i; printf "COUNTER %.0f %.0f\\n",t,$5+$6}' /proc/stat
    awk '/^MemTotal:/ {t=$2} /^MemAvailable:/ {a=$2; found=1} /^MemFree:/ {f=$2} /^Buffers:/ {b=$2} /^Cached:/ {c=$2} /^SReclaimable:/ {r=$2} /^Shmem:/ {s=$2} END {if(t>0) print "MEMORY",100*(t-(found?a:f+b+c+r-s))/t}' /proc/meminfo
    ;;
  Darwin)
    sysctl -n kern.boottime | awk -v now="$(date +%s)" '$1=="{" && $2=="sec" && ($4+0)>0 {printf "UPTIME %.0f\\n",now-($4+0)}'
    top -l 2 -s 1 -n 0 | awk '/CPU usage:/ {v=$(NF-1); sub(/%/,"",v); print "CPU",100-v}'
    total=$(sysctl -n hw.memsize)
    vm_stat | awk -v total="$total" 'NR==1 {p=$8+0} /Pages free:|Pages inactive:|Pages speculative:/ {v=$NF; sub(/\\./,"",v); free+=v} END {if(total>0 && p>0) print "MEMORY",100*(total-free*p)/total}'
    ;;
esac
 df -Pk / 2>/dev/null | awk 'NR>1 {v=$5; sub(/%/,"",v); if(v ~ /^[0-9.]+$/) print "DISK",v}'
`

const percent = (v: number): number | null => Number.isFinite(v) && v >= 0 && v <= 100 ? Math.round(v * 10) / 10 : null

export function parseMetrics(output: string): Pick<SessionMetrics, 'cpu' | 'memory' | 'disk' | 'uptimeSec'> {
  const result: Pick<SessionMetrics, 'cpu' | 'memory' | 'disk' | 'uptimeSec'> = { cpu: null, memory: null, disk: null, uptimeSec: null }
  let previous: number[] | undefined
  for (const line of output.split('\n')) {
    const [key, ...parts] = line.trim().split(/\s+/)
    const values = parts.map(Number)
    if (!parts.length || parts.some((p) => !p)) continue
    if (key === 'COUNTER' && values.length === 2) {
      if (previous && values[0] > previous[0] && values[1] >= previous[1]) {
        result.cpu = percent(100 * (1 - (values[1] - previous[1]) / (values[0] - previous[0])))
      }
      previous = values
    } else if (key === 'CPU') result.cpu = percent(values[0])
    else if (key === 'MEMORY') result.memory = percent(values[0])
    else if (key === 'DISK') result.disk = percent(values[0])
    else if (key === 'UPTIME') result.uptimeSec = Number.isFinite(values[0]) && values[0] >= 0 && values[0] <= Number.MAX_SAFE_INTEGER ? Math.floor(values[0]) : null
  }
  return result
}

function remoteExec(client: Client, script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let channel: ClientChannel | undefined
    let done = false
    const finish = (error?: Error, output = ''): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      channel?.close()
      if (error) reject(error)
      else resolve(output)
    }
    const timer = setTimeout(() => finish(new Error('서버 정보 조회 시간 초과')), 4500)
    client.exec('sh -s', (err, ch) => {
      if (done) { ch?.close(); return }
      if (err) { finish(err); return }
      channel = ch
      let output = ''
      ch.on('data', (data: Buffer) => {
        output += data.toString('utf8')
        if (output.length > 65536) finish(new Error('서버 정보 응답이 너무 큽니다'))
      })
      ch.stderr.resume()
      ch.on('error', (error: Error) => finish(error))
      ch.on('close', () => finish(undefined, output))
      ch.end(script)
    })
  })
}

const cache = new WeakMap<Session, { at: number; pending: boolean; transport: Session['transport']; request: Promise<SessionMetrics> }>()

export function sessionMetrics(session: Session): Promise<SessionMetrics> {
  if (session.info.state !== 'connected') return Promise.resolve({ pingMs: null, cpu: null, memory: null, disk: null, uptimeSec: null })
  const existing = cache.get(session)
  if (existing && existing.transport === session.transport && (existing.pending || Date.now() - existing.at < 4000)) return existing.request
  const request = collect(session)
  const entry = { at: Date.now(), pending: true, transport: session.transport, request }
  cache.set(session, entry)
  void request.finally(() => { entry.pending = false; entry.at = Date.now() })
  return request
}

async function collect(session: Session): Promise<SessionMetrics> {
  const empty: SessionMetrics = { pingMs: null, cpu: null, memory: null, disk: null, uptimeSec: null }
  if (session.info.state !== 'connected') return empty
  const client = session.sshTransport()?.client
  if (client) {
    const started = performance.now()
    try {
      const pong = await remoteExec(client, "printf 'BT_PONG\\n'\n")
      if (pong.trim() !== 'BT_PONG') return empty
      empty.pingMs = Math.round(performance.now() - started)
      return { ...empty, ...parseMetrics(await remoteExec(client, METRICS_SCRIPT)) }
    } catch { return empty }
  }
  if (session.info.protocol === 'local' && process.platform !== 'win32') {
    try {
      const output = await new Promise<string>((resolve, reject) => {
        execFile('/bin/sh', ['-c', METRICS_SCRIPT], { timeout: 4500, maxBuffer: 65536 }, (error, out) => error ? reject(error) : resolve(out))
      })
      return { ...empty, ...parseMetrics(output) }
    } catch { return empty }
  }
  return empty
}
