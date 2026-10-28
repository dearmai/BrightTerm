import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { ShellFs, modeFromPerm, parseLsLine } from '../src/main/shellfs.ts'

/** ssh2 Client.exec 대신 로컬 sh 로 — 셸 스크립트를 실제로 돌린다. 홈 폴더는 root */
function fakeClient(root) {
  return {
    exec(cmd, cb) {
      // ssh2 처럼 채널은 나중에 열린다
      setTimeout(() => this.open(cmd, cb), 20)
    },
    open(cmd, cb) {
      const child = spawn('sh', ['-c', cmd], { cwd: root })
      const ch = new Writable({ emitClose: false, write(c, _e, done) { child.stdin.write(c, done) }, final(done) { child.stdin.end(); done() } })
      ch.stderr = new EventEmitter()
      child.stdout.on('data', (d) => ch.emit('data', d))
      child.stderr.on('data', (d) => ch.stderr.emit('data', d))
      child.on('exit', (code) => ch.emit('exit', code))
      child.on('close', () => ch.emit('close'))
      cb(undefined, ch)
    }
  }
}

for (const perl of [true, false]) {
  test(`셸 명령으로 파일 다루기 (${perl ? 'perl' : 'ls -la'})`, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'bt-shellfs-')))
    try {
      const fs = new ShellFs(fakeClient(root))
      if (!perl) fs.perl = Promise.resolve(false)
      assert.equal(await fs.realpath('.'), root)
      const dir = join(root, "폴더 a'b")
      await fs.mkdir(dir)
      assert((await fs.stat(dir)).isDirectory())
      const odd = join(dir, '-x "y".txt')
      await fs.writeFile(odd, Buffer.from('한글 text\n'))
      assert.equal((await fs.readFile(odd)).toString(), '한글 text\n')
      await fs.chmod(odd, 0o640)
      const entries = await fs.readdir(dir)
      const e = entries.find((x) => x.filename === '-x "y".txt')
      assert(e, JSON.stringify(entries.map((x) => x.filename)))
      assert.equal(e.attrs.size, Buffer.byteLength('한글 text\n'))
      assert.equal(e.attrs.mode & 0o777, 0o640)
      assert(!e.attrs.isDirectory())
      assert(Math.abs(e.attrs.mtime - Date.now() / 1000) < 172800)
      assert.equal(await fs.realpath(odd), odd)

      // 바이너리 업로드·다운로드와 진행률
      const big = Buffer.alloc(1024 * 1024 + 7)
      for (let i = 0; i < big.length; i++) big[i] = (i * 31) & 0xff
      const localUp = join(root, 'up.bin'), remote = join(dir, 'big.bin'), localDown = join(root, 'down.bin')
      writeFileSync(localUp, big)
      let upSeen = 0, downSeen = 0
      await fs.put(localUp, remote, (done, total) => { upSeen = done; assert.equal(total, big.length) })
      await fs.get(remote, localDown, (done) => { downSeen = done })
      assert.equal(upSeen, big.length)
      assert.equal(downSeen, big.length)
      assert(readFileSync(localDown).equals(big))

      await fs.rename(remote, join(dir, 'moved.bin'))
      await assert.rejects(fs.stat(remote))
      await fs.unlink(join(dir, 'moved.bin'))
      await fs.unlink(odd)
      await fs.rmdir(dir)
      await assert.rejects(fs.readdir(dir))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
}

test('ls -la 줄 읽기 (GNU·BSD·AIX 형식)', () => {
  const now = new Date(2026, 9, 28, 12, 0)
  const a = parseLsLine('-rw-r--r--   1 201      1        1234 Oct 27 09:15 report final.txt', now)
  assert.equal(a.filename, 'report final.txt')
  assert.equal(a.attrs.size, 1234)
  assert.equal(new Date(a.attrs.mtime * 1000).getDate(), 27)
  const d = parseLsLine('drwxr-sr-x+  3 0 0 4096 Jan  5  2024 conf', now)
  assert(d.attrs.isDirectory())
  assert.equal(d.attrs.mode & 0o7777, 0o2755)
  assert.equal(parseLsLine('lrwxrwxrwx 1 0 0 7 Dec 31 23:59 lib -> usr/lib', now).filename, 'lib')
  assert.equal(new Date(parseLsLine('-rw------- 1 0 0 1 Dec 31 23:59 x', now).attrs.mtime * 1000).getFullYear(), 2025)
  assert.equal(parseLsLine('total 12', now), null)
  assert.equal(modeFromPerm('-rwsr-xr-t') & 0o7777, 0o5755)
})
