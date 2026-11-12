// Android 원격 데스크톱 — 점프 호스트·SSH 터널 경로. 격리된 에뮬레이터(개인 기기 금지)에서
// podman sshd(ksh 이미지)와 같은 네트워크 공간의 xrdp 에 붙는다(에뮬레이터에서 3389 로 바로는 못 간다).
// make android-build && ANDROID_SERIAL=emulator-5554 node test/e2e-android-rdp-route.mjs
// 필요: podman, test/podman/ksh 이미지(없으면 만든다), docker.io/scottyhardy/docker-remote-desktop
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';

const serial = process.env.ANDROID_SERIAL;
assert(serial?.startsWith('emulator-'), 'Set ANDROID_SERIAL to an isolated emulator (never a personal device).');
const adbBin = process.env.ADB || `${process.env.ANDROID_HOME || `${process.env.HOME}/Library/Android/sdk`}/platform-tools/adb`;
const adb = (...args) => execFileSync(adbBin, ['-s',serial,...args], {encoding:'utf8'}).trim();
const podman = (...a) => execFileSync('podman', a, {encoding:'utf8'}).trim();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const pkg = 'kr.balkeunter.brightterm';
const SSHD = 'bt-rdp-android-jump', XRDP = 'bt-rdp-android-behind', SSH_PORT = 12423, IMAGE = 'localhost/bt-ksh-sshd:test';
import {spawnSync} from 'node:child_process';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const shots = new URL('../android/build/screenshots/', import.meta.url);
mkdirSync(shots, {recursive:true});
const screenshot = name => writeFileSync(new URL(name, shots), execFileSync(adbBin, ['-s',serial,'exec-out','screencap','-p']));

let socket, sequence = 0;
const pending = new Map();
function cdp(method, params = {}) { return new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, {resolve, reject}); socket.send(JSON.stringify({id, method, params})); }); }
async function evaluate(expression) {
  const r = await cdp('Runtime.evaluate', {expression, returnByValue:true, awaitPromise:true});
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 600));
  return r.result?.value;
}
async function until(check, message, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { try { if (await check()) return; } catch { /* 다시 */ } await delay(250); }
  throw new Error(message);
}
async function attach() {
  let targets;
  for (const deadline = Date.now() + 30000;;) {
    try {
      const pid = adb('shell', 'pidof', pkg).split(' ')[0];
      adb('forward', 'tcp:9224', `localabstract:webview_devtools_remote_${pid}`);
      targets = await (await fetch('http://127.0.0.1:9224/json')).json();
      if (targets.some(t => t.url.endsWith('/assets/index.html'))) break;
    } catch (error) { if (Date.now() > deadline) throw error; }
    await delay(500);
  }
  const target = targets.find(t => t.url.endsWith('/assets/index.html'));
  socket = new WebSocket(target.webSocketDebuggerUrl);
  socket.onmessage = e => { const r = JSON.parse(e.data);
    if (r.method === 'Runtime.consoleAPICalled' && process.env.BT_DIAG) console.log('[console]', r.params.args.map(a => a.value ?? a.description).join(' ').slice(0, 300));
    if (r.id && pending.has(r.id)) { const p = pending.get(r.id); pending.delete(r.id); r.error ? p.reject(new Error(JSON.stringify(r.error))) : p.resolve(r.result); } };
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  await until(() => evaluate('!!window.nativeEvent && !!window.openRdp'), 'App script did not load');
  if (process.env.BT_DIAG) await cdp('Runtime.enable');
}
async function clickNative(label, timeout = 30000) {
  await until(async () => {
    try { adb('shell', 'uiautomator', 'dump', '/sdcard/bt-rdp.xml'); } catch (error) { if (!String(error.stdout).includes('dumped')) return false; }
    const xml = adb('shell', 'cat', '/sdcard/bt-rdp.xml');
    const node = xml.match(new RegExp(`<node[^>]*text="${label}"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`));
    if (!node) return false;
    adb('shell', 'input', 'tap', String((+node[1] + +node[3]) / 2 | 0), String((+node[2] + +node[4]) / 2 | 0));
    return true;
  }, `Native button did not appear: ${label}`, timeout);
}
const F = "document.querySelector('.rdp-frame:not([hidden])')";
const inFrame = (expr) => evaluate(`(() => { const w = ${F}.contentWindow; with (w) { return (${expr}); } })()`);
/** 원격 화면 캔버스의 색 수(검은 화면이 아닌지) */
const painted = () => inFrame(`(() => { const c = document.querySelector('iron-remote-desktop')?.shadowRoot?.querySelector('canvas'); if (!c || !c.width) return 0;
  const t = document.createElement('canvas'); t.width = 64; t.height = 36; t.getContext('2d').drawImage(c, 0, 0, 64, 36);
  const d = t.getContext('2d').getImageData(0, 0, 64, 36).data, s = new Set(); for (let i = 0; i < d.length; i += 4) s.add((d[i] >> 4) << 8 | (d[i+1] >> 4) << 4 | (d[i+2] >> 4)); return s.size; })()`);
/** 원격 화면(터치 층)의 메인 페이지 좌표 */
async function touchRect() {
  return evaluate(`(() => { const f = ${F}.getBoundingClientRect(), t = ${F}.contentDocument.getElementById('touch').getBoundingClientRect(); return { x: f.x + t.x, y: f.y + t.y, w: t.width, h: t.height }; })()`);
}
const touch = (type, points) => cdp('Input.dispatchTouchEvent', {type, touchPoints: points.map((p, i) => ({x: p.x, y: p.y, id: i + 1}))});


const base = {port:22, command:''};
const jump = {...base, id:'jump', name:'bastion', host:'10.0.2.2', port:SSH_PORT, username:'kshuser', password:'KshPass!1'};
const rdpOpts = {mode:'builtin', port:3389, auth:'own', clipboard:false, resolution:'1280x720', route:'direct'};
const viaJump = {...base, id:'via-jump', name:'베스천 뒤 윈도우', host:'127.0.0.1', username:'ubuntu', os:'windows', jumpHostId:'jump', directSsh:false, rdp:rdpOpts, rdpPassword:'ubuntu'};
const viaSsh = {...base, id:'via-ssh', name:'SSH 터널 윈도우', host:'10.0.2.2', port:SSH_PORT, username:'kshuser', password:'KshPass!1', os:'windows', rdp:{...rdpOpts, route:'ssh', username:'ubuntu'}, rdpPassword:'ubuntu'};
let trusting = true;
async function trustLoop() {
  while (trusting) {
    for (const label of ['신뢰하고 연결', '신뢰하고 접속']) {
      try {
        adb('shell', 'uiautomator', 'dump', '/sdcard/bt-rdp.xml');
        const xml = adb('shell', 'cat', '/sdcard/bt-rdp.xml');
        const node = xml.match(new RegExp(`<node[^>]*text="${label}"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`));
        if (node) adb('shell', 'input', 'tap', String((+node[1] + +node[3]) / 2 | 0), String((+node[2] + +node[4]) / 2 | 0));
      } catch { /* */ }
    }
    await delay(700);
  }
}
async function openAndCheck(id, routeRe) {
  await evaluate(`openRdp(profiles.find(p => p.id === '${id}')); 1`);
  await until(() => evaluate(`!!${F}`), `${id}: RDP tab did not open`, 60000);
  await until(() => inFrame(`window.rdpTest?.phase === 'connected'`), `${id}: RDP did not connect`, 90000);
  let colors = 0;
  for (let i = 0; i < 30 && colors < 8; i++) { await delay(1000); colors = await painted(); }
  assert.ok(colors >= 8, `${id}: 원격 화면이 그려지지 않았습니다 (${colors})`);
  const sub = await inFrame(`document.getElementById('sub').textContent`);
  assert.match(sub, routeRe);
  console.log(id, 'connected:', sub, 'colors', colors);
  await evaluate(`rdpCloseTab(decodeURIComponent(${F}.src.split('t=')[1]), false); 1`);
  await until(() => evaluate(`!document.querySelector('.rdp-frame')`), `${id}: tab did not close`);
}

try {
  for (const n of [XRDP, SSHD]) try { podman('rm', '-f', n); } catch { /* */ }
  if (spawnSync('podman', ['image', 'exists', IMAGE]).status !== 0) podman('build', '-t', IMAGE, '-f', join(here, 'podman', 'ksh', 'Containerfile'), join(here, 'podman', 'ksh'));
  podman('run', '-d', '--name', SSHD, '-p', `${SSH_PORT}:22`, IMAGE);
  podman('run', '-d', '--name', XRDP, '--network', `container:${SSHD}`, '--shm-size=1g', 'docker.io/scottyhardy/docker-remote-desktop:latest');
  adb('shell', 'am', 'force-stop', pkg);
  adb('shell', 'pm', 'clear', pkg);
  adb('shell', 'am', 'start', '-W', '-n', `${pkg}/.MainActivity`);
  await attach();
  for (const p of [jump, viaJump, viaSsh]) await evaluate(`Android.save(${JSON.stringify(JSON.stringify(p))}); 1`);
  await until(() => evaluate(`profiles.length === 3`), 'Profiles not saved');
  trustLoop();
  // xrdp 준비 — 점프 호스트를 거친 허용 상태 확인
  let check;
  for (let i = 0; i < 40; i++) {
    const id = crypto.randomUUID();
    check = await evaluate(`new Promise(r => { const prev = window.rdpEvent; window.rdpEvent = e => { if (e.id === '${id}') { window.rdpEvent = prev; r(JSON.parse(e.value)); } else prev(e); }; Android.rdpCheck('${id}', JSON.stringify(profiles.find(p => p.id === 'via-jump'))); })`);
    if (check.state === 'ok') break;
    await delay(1500);
  }
  assert.equal(check.state, 'ok', JSON.stringify(check));
  assert.match(check.route, /^점프 호스트 bastion → 127\.0\.0\.1:3389$/);
  console.log('jump check:', check.route, check.security);
  await openAndCheck('via-jump', /점프 호스트 bastion/);
  await openAndCheck('via-ssh', /SSH 터널 \(SSH 터널 윈도우\)/);
  // 탭을 닫으면 경로 SSH 세션도 닫힌다
  await delay(2000);
  const left = podman('exec', SSHD, 'sh', '-c', "ps -eo user,args | grep '^kshuser' | grep sshd | grep -v grep | wc -l");
  assert.equal(left, '0', `남은 SSH 세션 ${left}`);
  console.log('e2e-android-rdp-route OK');
} catch (error) {
  console.error(error);
  try { screenshot('rdp-route-fail.png'); } catch { /* */ }
  process.exitCode = 1;
} finally {
  trusting = false;
  socket?.close();
  for (const n of [XRDP, SSHD]) try { podman('rm', '-f', n); } catch { /* */ }
}
