// Android 원격 데스크톱 — 격리된 에뮬레이터(개인 기기 금지)와 podman xrdp 로 확인한다.
// make android-build && ANDROID_SERIAL=emulator-5554 node test/e2e-android-rdp.mjs
//   - 서버 OS·RDP 설정 저장, 편집 화면의 RDP 허용 상태 확인
//   - 목록의 RDP 버튼 → 인증서 신뢰(네이티브 창) → 원격 데스크톱 탭, 중계 단계(16비트·효과 끔)
//   - 터치패드: 한 손가락 이동·탭 = 클릭, 두 손가락 탭 = 오른쪽 클릭, 핀치 = 확대, 두 손가락 끌기 = 화면 이동
//   - 소프트 키보드 입력(유니코드)으로 xrdp 로그인, 클립보드 양방향(텍스트)
//   - 설정 패널 저장, 15비트 멈춤 흉내 → 16비트 자동 다시 연결, 탭 닫기
// 필요: podman, docker.io/scottyhardy/docker-remote-desktop, 설치된 debug APK. Windows(NLA) 는 확인하지 않는다.
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
const NAME = 'bt-rdp-android', PORT = 13396;
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

const rdp = {mode:'builtin', port:PORT, auth:'host', clipboard:true, resolution:'1280x720', route:'direct', colorDepth:16,
  experience:{wallpaper:false, themes:false, fontSmoothing:false, composition:false, windowDrag:false, animations:false, cursorShadow:false}, audio:'off'};
const profile = {id:'rdp-e2e', name:'RDP E2E', host:'10.0.2.2', port:22, username:'ubuntu', password:'ubuntu', command:'', os:'windows', rdp};

try {
  try { podman('rm', '-f', NAME); } catch { /* */ }
  podman('run', '-d', '--name', NAME, '-p', `${PORT}:3389`, '--shm-size=1g', 'docker.io/scottyhardy/docker-remote-desktop:latest');
  try { podman('exec', NAME, 'sh', '-c', 'apt-get update -qq >/dev/null 2>&1; DEBIAN_FRONTEND=noninteractive apt-get install -y -qq xclip >/dev/null 2>&1'); } catch { console.log('xclip 설치 실패'); }
  adb('shell', 'am', 'force-stop', pkg);
  adb('shell', 'pm', 'clear', pkg);
  adb('shell', 'am', 'start', '-W', '-n', `${pkg}/.MainActivity`);
  await attach();
  await evaluate(`Android.save(${JSON.stringify(JSON.stringify(profile))}); 1`);
  await until(() => evaluate(`profiles.some(p => p.id === 'rdp-e2e' && p.os === 'windows' && p.rdp?.port === ${PORT})`), 'Profile with os/rdp not saved');

  // 1) 편집 화면 — OS 가 Windows 면 RDP 설정이 보이고, 허용 상태를 확인한다(xrdp 가 뜰 때까지 다시)
  await evaluate(`openEditor(profiles.find(p => p.id === 'rdp-e2e')); 1`);
  assert.equal(await evaluate(`!$('rdp-settings').hidden && !$('save-rdp').hidden && $('form').elements.rdpPort.value === '${PORT}' && $('form').elements.rdpQuality.value === 'fast'`), true, 'RDP section not filled');
  let check = '';
  for (let i = 0; i < 40 && !/RDP 허용됨/.test(check); i++) {
    await evaluate(`$('rdp-check').click(); 1`);
    await until(() => evaluate(`$('rdp-check-result').textContent !== '확인 중…'`), 'RDP check did not finish');
    check = await evaluate(`$('rdp-check-result').textContent`);
    if (!/RDP 허용됨/.test(check)) await delay(1500);
  }
  assert.match(check, /RDP 허용됨 · TLS/);
  assert.match(check, /인증서 SHA256:/);
  console.log('check:', check.split('\n')[0]);
  screenshot('rdp-editor.png');
  await evaluate(`$('editor').close(); 1`);

  // 2) 목록의 RDP 버튼 → 인증서 신뢰 → 원격 데스크톱 탭
  await evaluate(`[...$('hosts').querySelectorAll('.edit.rdp')].find(b => b.title.includes('원격 데스크톱')).click(); 1`);
  await clickNative('신뢰하고 접속');
  await until(() => evaluate(`!!${F}`), 'RDP tab did not open');
  await until(() => inFrame(`window.rdpTest?.phase === 'connected'`), 'RDP did not connect', 60000);
  let colors = 0;
  for (let i = 0; i < 30 && colors < 8; i++) { await delay(1000); colors = await painted(); }
  assert.ok(colors >= 8, `원격 화면이 그려지지 않았습니다 (${colors})`);
  const steps = await inFrame(`[...document.querySelectorAll('#steps div')].map(d => d.textContent)`).catch(() => []);
  console.log('connected, colors:', colors, steps);
  assert.equal(await evaluate(`document.querySelector('.tab.rdp-tab.active')?.dataset.state`), 'connected');
  screenshot('rdp-connected.png');

  // 3) 터치패드 — 캔버스가 받는 마우스 단추를 기록한다
  await inFrame(`(() => { window.__btn = []; const c = document.querySelector('iron-remote-desktop').shadowRoot.querySelector('canvas'); c.addEventListener('mousedown', e => window.__btn.push(e.button)); return 1; })()`);
  const r = await touchRect();
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
  const before = await inFrame(`({ ...rdpTest.cursor })`);
  await touch('touchStart', [{x: cx, y: cy}]);
  for (let k = 1; k <= 6; k++) await touch('touchMove', [{x: cx + k * 10, y: cy + k * 5}]);
  await touch('touchEnd', []);
  const after = await inFrame(`({ ...rdpTest.cursor })`);
  assert.ok(after.x > before.x + 40 && after.y > before.y + 20, `한 손가락 끌기로 커서가 움직이지 않았습니다 ${JSON.stringify([before, after])}`);
  assert.deepEqual(await inFrame(`window.__btn`), [], '끌기만 했는데 클릭되었습니다');
  await delay(400);
  await touch('touchStart', [{x: cx, y: cy}]); await delay(60); await touch('touchEnd', []);
  await until(() => inFrame(`window.__btn.join() === '0'`), '탭이 왼쪽 클릭이 되지 않았습니다');
  await delay(450);
  await touch('touchStart', [{x: cx - 30, y: cy}, {x: cx + 30, y: cy}]); await delay(60); await touch('touchEnd', []);
  await until(() => inFrame(`window.__btn.join() === '0,2'`), '두 손가락 탭이 오른쪽 클릭이 되지 않았습니다');
  // 오른쪽 클릭으로 열린 메뉴 닫기
  await inFrame(`rdpTest.tapKey('Escape')`);
  // 핀치 확대 → 두 손가락 끌기로 화면 이동
  await touch('touchStart', [{x: cx - 40, y: cy}, {x: cx + 40, y: cy}]);
  for (let k = 1; k <= 8; k++) await touch('touchMove', [{x: cx - 40 - k * 15, y: cy}, {x: cx + 40 + k * 15, y: cy}]);
  await touch('touchEnd', []);
  const zoom = await inFrame(`rdpTest.zoom`);
  assert.ok(zoom > 1.5, `핀치로 확대되지 않았습니다 (${zoom})`);
  const pan0 = await inFrame(`rdpTest.pan`);
  await touch('touchStart', [{x: cx - 40, y: cy}, {x: cx + 40, y: cy}]);
  for (let k = 1; k <= 6; k++) await touch('touchMove', [{x: cx - 40 + k * 12, y: cy + k * 8}, {x: cx + 40 + k * 12, y: cy + k * 8}]);
  await touch('touchEnd', []);
  const pan1 = await inFrame(`rdpTest.pan`);
  assert.ok(Math.abs(pan1[0] - pan0[0]) > 20 || Math.abs(pan1[1] - pan0[1]) > 20, `두 손가락 끌기로 화면이 움직이지 않았습니다 ${JSON.stringify([pan0, pan1])}`);
  assert.equal(await inFrame(`window.__btn.join()`), '0,2', '확대·이동 중에 클릭되었습니다');
  console.log('touch: zoom', zoom.toFixed(2), 'pan', pan0, '→', pan1);
  screenshot('rdp-zoomed.png');
  await inFrame(`document.getElementById('zoom-reset').click()`);

  // 4) 소프트 키보드 입력으로 xrdp 로그인 — 비밀번호 칸을 탭하고 글자를 보낸다
  await inFrame(`(() => { const c = document.querySelector('iron-remote-desktop').shadowRoot.querySelector('canvas').getBoundingClientRect(); rdpTest.cursor.x = c.left + c.width / 2; rdpTest.cursor.y = c.top + c.height * 0.58; rdpTest.click(0); return 1; })()`);
  await delay(500);
  await inFrame(`document.getElementById('kbd').click()`);
  await inFrame(`rdpTest.typeText('ubuntu')`);
  await inFrame(`rdpTest.tapKey('Enter')`);
  let display = '';
  for (let i = 0; i < 40 && !display; i++) {
    await delay(1000);
    try { display = podman('exec', NAME, 'sh', '-c', "ls /tmp/.X11-unix | grep -v X0 | sed 's/X/:/' | head -1"); } catch { /* */ }
  }
  assert.ok(display, 'xrdp 세션이 열리지 않았습니다(키 입력 실패)');
  await delay(4000);
  screenshot('rdp-session.png');
  console.log('xrdp session', display);

  // 5) 클립보드 — 원격 → 이 기기, 이 기기 → 원격
  // 원격 세션의 X 는 그 사용자(ubuntu)로만 열린다
  const xclip = (args) => { try { return podman('exec', '-u', 'ubuntu', '-e', `DISPLAY=${display}`, NAME, 'sh', '-c', `timeout 3 xclip ${args} -t UTF8_STRING`); } catch (e) { return `ERR ${String(e.stderr || e.message).slice(0, 120)}`; } };
  const REMOTE = `bt-remote-${Date.now()}`;
  podman('exec', '-u', 'ubuntu', '-e', `DISPLAY=${display}`, NAME, 'sh', '-c', `printf %s ${REMOTE} | timeout 3 xclip -selection clipboard -t UTF8_STRING -i; true`);
  await until(() => evaluate(`Android.clipboardText() === ${JSON.stringify(REMOTE)}`), '원격 → 이 기기 클립보드', 20000);
  const LOCAL = `bt-android-${Date.now()}`;
  await evaluate(`Android.copy(${JSON.stringify(LOCAL)}); 1`);
  let remote = '';
  for (let i = 0; i < 30 && remote !== LOCAL; i++) {
    await delay(500);
    remote = xclip('-o -selection clipboard');
  }
  assert.equal(remote, LOCAL, '이 기기 → 원격 클립보드');
  console.log('clipboard both ways ok');

  // 6) 설정 패널 — 화면 맞춤을 바꾸면 서버 설정에 저장된다
  await inFrame(`document.getElementById('settings-btn').click()`);
  const panelBox = await inFrame(`(() => { const p = document.getElementById('panel'); const r = p.getBoundingClientRect(); return { display: getComputedStyle(p).display, h: r.height, w: r.width, hidden: p.hidden, items: p.children.length } })()`);
  console.log('panel:', panelBox);
  assert.ok(panelBox.h > 150 && panelBox.display !== 'none', `설정 패널이 보이지 않습니다 ${JSON.stringify(panelBox)}`);
  await delay(500);
  screenshot('rdp-panel-open.png');
  await inFrame(`[...document.querySelectorAll('#panel .seg button')].find(b => b.textContent === '꽉 채움').click()`);
  await until(() => evaluate(`profiles.find(p => p.id === 'rdp-e2e')?.rdp?.scale === 'full'`), '설정 패널 값이 저장되지 않았습니다');
  screenshot('rdp-panel.png');

  // 7) 탭 닫기 → 15비트 멈춤 흉내 → 16비트 자동 다시 연결
  await evaluate(`rdpCloseTab([...document.querySelectorAll('.rdp-frame')][0].src.split('t=')[1] && decodeURIComponent([...document.querySelectorAll('.rdp-frame')][0].src.split('t=')[1]), false); 1`);
  await until(() => evaluate(`!document.querySelector('.rdp-frame')`), 'RDP tab did not close');
  await evaluate(`Android.rdpTestStall(true); Android.save(JSON.stringify({ ...${JSON.stringify(profile)}, rdp: { ...${JSON.stringify(rdp)}, colorDepth: 15 } })); 1`);
  await until(() => evaluate(`profiles.find(p => p.id === 'rdp-e2e')?.rdp?.colorDepth === 15`), '15-bit profile not saved');
  await evaluate(`openRdp(profiles.find(p => p.id === 'rdp-e2e')); 1`);
  await until(() => inFrame(`!document.getElementById('warn').hidden && document.getElementById('warn').textContent.includes('16비트로 다시 연결')`), '15비트 → 16비트 자동 다시 연결 안내가 없습니다', 40000);
  await until(() => inFrame(`window.rdpTest?.phase === 'connected'`), '16비트로 다시 연결하지 못했습니다', 60000);
  assert.equal(await evaluate(`profiles.find(p => p.id === 'rdp-e2e').rdp.colorDepth`), 15, '저장한 설정은 15비트 그대로');
  console.log('15→16 fallback ok');
  await evaluate(`Android.rdpTestStall(false); 1`);
  await evaluate(`rdpCloseTab(decodeURIComponent(document.querySelector('.rdp-frame').src.split('t=')[1]), false); 1`);
  await until(() => evaluate(`!document.querySelector('.rdp-frame') && !document.querySelector('.rdp-tab')`), 'RDP tab did not close');
  console.log('e2e-android-rdp OK');
} catch (error) {
  console.error(error);
  try { screenshot('rdp-fail.png'); } catch { /* */ }
  process.exitCode = 1;
} finally {
  socket?.close();
  try { podman('rm', '-f', NAME); } catch { /* */ }
}
