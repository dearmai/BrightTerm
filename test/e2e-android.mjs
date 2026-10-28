// Run against an isolated Android emulator with the debug APK already installed.
// ANDROID_SERIAL=emulator-5554 node test/e2e-android.mjs
import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {generateKeyPairSync} from 'node:crypto';
import {mkdirSync,mkdtempSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import ssh2 from 'ssh2';
const {Server} = ssh2;
const serial = process.env.ANDROID_SERIAL;
assert(serial?.startsWith('emulator-'), 'Set ANDROID_SERIAL to an isolated emulator (never a personal device).');
const adbBin = process.env.ADB || `${process.env.ANDROID_HOME || `${process.env.HOME}/Library/Android/sdk`}/platform-tools/adb`;
const adb = (...args) => execFileSync(adbBin, ['-s',serial,...args], {encoding:'utf8'}).trim();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const pkg = 'kr.balkeunter.brightterm';
const screenshots = new URL('../android/build/screenshots/', import.meta.url);
mkdirSync(screenshots, {recursive:true});
let browserSocket, server, forwardedPort, connections=0, lastPty;
let expectedPassword='android-test-secret';
const identity=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs1',format:'pem'});
const parsedIdentity=ssh2.utils.parseKey(identity);
let received='', shells=0, raw=Buffer.alloc(0), probes=0, lastClient, ptyRequest, sftpEnabled=true, execFiles=false;
// Files for the "SFTP missing, exec works" server: commands run here in a real sh.
const remoteRoot=realpathSync(mkdtempSync(join(tmpdir(),'bt-android-remote-')));
writeFileSync(join(remoteRoot,'hello.txt'),'hello from server\n');
let hostKey = () => generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs1',format:'pem'});
async function startServer(port=0) {
  server = new Server({hostKeys:[hostKey()]}, client => {
    client.on('error',e=>{ if(process.env.E2E_DEBUG) console.error('server client error',e.message); });
    client.on('authentication', ctx => {
      const passwordOK=ctx.method==='password' && ctx.password===expectedPassword;
      const keyOK=ctx.method==='publickey' && ctx.key.data.equals(parsedIdentity.getPublicSSH()) && (!ctx.signature || parsedIdentity.verify(ctx.blob,ctx.signature,ctx.hashAlgo)===true);
      if(ctx.username==='tester' && (passwordOK || keyOK)) ctx.accept(); else ctx.reject(['publickey','password']);
    });
    client.on('ready', () => { connections++; lastClient=client; client.on('session', accept => {
      const session = accept();
      session.on('pty',(accept,reject,info) => { lastPty=ptyRequest=info; accept(); });
      session.on('window-change',(accept,reject,info) => {lastPty=info; accept?.();});
      session.on('sftp', (accept, reject) => {
        if(!sftpEnabled) return reject();
        const sftp=accept(); let listed=false;
        sftp.on('REALPATH',(id,path)=>sftp.name(id,[{filename:'/home/tester',longname:'/home/tester',attrs:{}}]));
        for(const type of ['STAT','LSTAT']) sftp.on(type,(id,path)=>sftp.attrs(id,{mode:0o40755,size:0,uid:1000,gid:1000,atime:0,mtime:0}));
        sftp.on('OPENDIR',(id,path)=>sftp.handle(id,Buffer.from('dir')));
        sftp.on('READDIR',(id)=>{ if(listed) sftp.status(id,ssh2.utils.sftp.STATUS_CODE.EOF); else {listed=true;sftp.name(id,[{filename:'hello.txt',longname:'-rw-r--r-- 1 tester tester 5 Jan 1 00:00 hello.txt',attrs:{mode:0o100644,size:5,uid:1000,gid:1000,atime:0,mtime:0}}]);} });
        sftp.on('CLOSE',(id)=>sftp.status(id,ssh2.utils.sftp.STATUS_CODE.OK));
      });
      session.on('exec', (accept, reject, info) => {
        // Resume health check opens a throwaway channel.
        if(info.command==='true') { const stream=accept(); probes++; stream.exit(0); stream.end(); return; }
        if(!/tmux list-sessions/.test(info.command)) {
          if(!execFiles) return reject();
          const stream=accept(), child=spawn('sh',['-c',info.command],{cwd:remoteRoot});
          child.stdout.on('data',d=>stream.write(d)); child.stderr.on('data',d=>stream.stderr.write(d));
          stream.on('data',d=>child.stdin.write(d)); stream.on('end',()=>child.stdin.end());
          child.on('close',code=>{stream.exit(code??1); stream.end();});
          return;
        }
        const stream=accept();
        assert.match(info.command,/tmux list-sessions/); stream.end("shared\nbt-Android-E2E\nodd'quote\n"); });
      session.on('shell', accept => { shells++; const stream = accept(); stream.write('BrightTerm Android test shell\r\n'); stream.on('data', data => {received+=data.toString(); raw=Buffer.concat([raw,data]); stream.write(data); if(data.toString().includes('sudo -i\r')) stream.write('\r\n[sudo] password for tester: ');}); });
    }); });
  });
  await new Promise(resolve => server.listen(port,'127.0.0.1',resolve));
  return server.address().port;
}
let sequence=0; const pending = new Map();
function cdp(method,params={}) { return new Promise((resolve,reject) => {
  const id=++sequence; pending.set(id,{resolve,reject}); browserSocket.send(JSON.stringify({id,method,params}));
}); }
async function evaluate(expression) {
  const response=await cdp('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
  if(response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
  return response.result?.value;
}
async function until(check, message, timeout=20000) {
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline) { if(await check()) return; await delay(150); }
  throw new Error(message + ' · ' + await evaluate("JSON.stringify({status:$('status').textContent, error:$('toast').textContent, events:window.testEvents})"));
}
async function attach() {
  // A cold emulator can take several seconds before the WebView opens its DevTools socket.
  let targets;
  for(const deadline=Date.now()+20000;;) {
    try {
      const pid=adb('shell','pidof',pkg).split(' ')[0];
      adb('forward','tcp:9223',`localabstract:webview_devtools_remote_${pid}`);
      targets=await (await fetch('http://127.0.0.1:9223/json')).json();
      break;
    } catch(error) { if(Date.now()>deadline) throw error; await delay(500); }
  }
  const target=targets.find(t => t.url.includes('appassets.androidplatform.net'));
  assert(target, 'Local WebView loaded');
  browserSocket=new WebSocket(target.webSocketDebuggerUrl);
  browserSocket.onmessage=event => { const r=JSON.parse(event.data); if(r.id && pending.has(r.id)) { const p=pending.get(r.id); pending.delete(r.id); r.error ? p.reject(new Error(JSON.stringify(r.error))) : p.resolve(r.result); } };
  await new Promise((resolve,reject) => {browserSocket.onopen=resolve; browserSocket.onerror=reject;});
  await until(() => evaluate('!!window.nativeEvent'), 'App script did not load');
}
async function clickNative(label) {
  await until(async () => {
    try { adb('shell','uiautomator','dump','/sdcard/brightterm-test.xml'); }
    catch (error) { if (!error.stdout?.includes('UI hierchary dumped')) return false; }
    const xml=adb('shell','cat','/sdcard/brightterm-test.xml');
    const escaped=label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const node=xml.match(new RegExp(`<node[^>]*text="${escaped}"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`));
    if(!node) return false;
    adb('shell','input','tap',String((+node[1]+ +node[3])/2|0),String((+node[2]+ +node[4])/2|0));return true;
  },`Native option did not appear: ${label}`);
}
async function connectForm(port,remember=false) {
  await evaluate(`openEditor(); Object.assign($('form').elements.name,{value:'Android E2E'}); $('form').elements.host.value='127.0.0.1'; $('form').elements.port.value=${port}; $('form').elements.username.value='tester'; $('form').elements.password.value=${JSON.stringify(expectedPassword)}; $('form').elements.remember.checked=${remember}; $('form').requestSubmit();`);
}
function screenshot(name) { writeFileSync(new URL(name,screenshots),execFileSync(adbBin,['-s',serial,'exec-out','screencap','-p'])); }
try {
  const port=await startServer(); forwardedPort=port; adb('reverse',`tcp:${port}`,`tcp:${port}`);
  adb('shell','am','force-stop',pkg); adb('shell','pm','grant',pkg,'android.permission.POST_NOTIFICATIONS');
  adb('shell','am','start','-n',`${pkg}/.MainActivity`); await delay(1000); await attach();
  await delay(300);
  await evaluate("for(const p of profiles.filter(p=>p.name==='Android E2E')) Android.delete(p.id)");
  await delay(300);
  await evaluate("window.testEvents=[]; window.originalHandler=window.nativeEvent; window.nativeEvent=e=>{window.testEvents.push(['data','key'].includes(e.type)?{...e,value:'redacted'}:e);window.originalHandler(e)}");
  assert(await evaluate("getComputedStyle($('sidebar')).display==='none'"),'Phone sidebar collapsed'); screenshot('phone.png');
  await connectForm(port,true); await clickNative('신뢰하고 연결');
  await until(() => evaluate("current()?.state==='connected'"),'SSH did not connect');
  await until(() => evaluate("profiles.some(p=>p.name==='Android E2E')"),'Profile not saved');
  const encrypted=execFileSync(adbBin,['-s',serial,'shell','run-as',pkg,'cat','files/profiles.enc']);
  assert(!encrypted.includes(Buffer.from(expectedPassword)) && !encrypted.includes(Buffer.from('tester')),'Vault contains plaintext');
  await evaluate("current().term.input('입력-한글-123\\r')");
  await until(() => evaluate("Array.from({length:current().term.buffer.active.length},(_,i)=>current().term.buffer.active.getLine(i).translateToString()).join('').includes('입력-한글-123')"),'UTF-8 terminal roundtrip failed');
  assert.equal(connections,1);
  await evaluate("$('ctrl').click(); current().term.input('c')");
  await until(()=>received.includes('\x03'),'Touch Ctrl+C failed');
  // Actual WebView multi-touch events resize glyphs and the remote PTY without reconnecting.
  const center=await evaluate("(()=>{const r=current().pane.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()");
  const points=gap=>[{x:center.x,y:center.y-gap/2,id:1},{x:center.x,y:center.y+gap/2,id:2}];
  const beforePinch=received;
  await cdp('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:points(40)});
  await cdp('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:points(240)});
  await until(()=>evaluate('current().term.options.fontSize===28'),'Pinch out failed');
  const enlargedCols=await evaluate('current().term.cols');
  await cdp('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:points(2)});
  await until(()=>evaluate('current().term.options.fontSize===8'),'Pinch in failed');
  await cdp('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await until(()=>lastPty?.cols>enlargedCols,'Pinch did not resize remote PTY');
  assert.equal(received,beforePinch,'Pinch sent terminal input');
  assert.equal(connections,1,'Pinch reconnected SSH');
  // One finger remains available to xterm and never changes font size.
  await cdp('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:center.x,y:center.y,id:1}]});
  await cdp('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:center.x,y:center.y-30,id:1}]});
  await cdp('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  assert.equal(await evaluate('current().term.options.fontSize'),8);
  await evaluate("$('sftp').click()");
  await until(()=>evaluate("$('file-list').textContent.includes('hello.txt')"),'SFTP listing failed');
  await evaluate("$('file-list').querySelector('button').click(); $('close-files').click()");
  assert.equal(await evaluate("$('remote-file').value"),'/home/tester/hello.txt');

  // Resize physical emulator display, exercising native configuration changes, not browser emulation.
  adb('shell','wm','size','1600x1000'); adb('shell','wm','density','160');
  await until(() => evaluate("innerWidth>1000 && getComputedStyle($('sidebar')).display!=='none'"),'Desktop layout did not respond');
  await until(() => lastPty?.cols>100,'PTY did not resize'); assert.equal(connections,1,'Resize reconnected SSH'); screenshot('desktop.png');
  // Activity background / foreground retains the service socket.
  adb('shell','input','keyevent','KEYCODE_HOME'); await delay(500); adb('shell','am','start','-n',`${pkg}/.MainActivity`);
  await until(() => evaluate("current()?.state==='connected'"),'Background lost session'); assert.equal(connections,1);
  await until(() => probes>0,'Resume did not check the session'); assert.equal(await evaluate("current().state"),'connected','Healthy session marked stale');
  // Return to same trusted host without asking again, exercising saved encrypted credentials.
  const savedId=await evaluate("profiles.find(p=>p.name==='Android E2E').id");
  await evaluate(`Android.connect(JSON.stringify({savedId:${JSON.stringify(savedId)}}),80,24)`);
  await until(() => connections===2,'Saved credentials / known host reconnect failed');
  // Exercise real JSch private-key authentication using a fresh ephemeral identity.
  await evaluate(`openEditor(); $('form').elements.name.value='Key E2E'; $('form').elements.host.value='127.0.0.1'; $('form').elements.port.value=${port}; $('form').elements.username.value='tester'; $('form').elements.remember.checked=false; window.nativeEvent({type:'key',value:${JSON.stringify(identity)}}); $('form').requestSubmit();`);
  await until(()=>connections===3,'Private-key authentication failed');
  // First connection offers exact existing targets, a distinct new session, or a plain shell.
  async function tmuxConnect(option) {
    await evaluate(`Android.connect(JSON.stringify({inheritId:${JSON.stringify(savedId)},persist:true,persistName:'shared',command:'echo startup'}),80,24)`);
    await clickNative(option);
    await clickNative('연결');
    await until(()=>evaluate("current()?.state==='connected'"),'Tmux selection did not connect');
  }
  received=''; await tmuxConnect("기존 세션: odd'quote");
  await until(()=>received.includes('attach-session'),'Existing tmux startup missing');
  assert(received.includes("odd") && received.includes("quote") && !received.includes("odd-quote"), "Existing session name was altered");
  received=''; await tmuxConnect('신규 tmux 세션 생성');
  await until(()=>received.includes('attach-session'),'New tmux startup missing');
  assert.match(received,/new-session -d -s.*shared-[a-f0-9]{8}/,'New session reused an existing name');
  received=''; await tmuxConnect('일반 SSH 셸 (tmux 사용 안 함)');
  await until(()=>received.includes('echo startup'),'Plain shell lost startup command');
  assert(!received.includes('tmux'),'Plain SSH selection launched tmux');
  const shellCount=shells;
  await evaluate(`Android.connect(JSON.stringify({inheritId:${JSON.stringify(savedId)},persist:true}),80,24)`);
  await clickNative('취소');
  await until(()=>evaluate("current()?.state==='disconnected'"),'Cancelled selection stayed connecting');
  assert.equal(shells,shellCount,'Cancel opened a shell');
  // Multi-line startup: one line at a time after the prompt settles, stopping at a password prompt.
  // The same server refuses the SFTP subsystem, so the file button is dimmed.
  received=''; sftpEnabled=false;
  await evaluate(`Android.connect(JSON.stringify({inheritId:${JSON.stringify(savedId)},persist:false,command:'echo one\\n# skip\\n\\necho two\\nsudo -i\\nwhoami'}),80,24)`);
  await until(()=>received.includes('sudo -i\r'),'Multi-line startup not sent');
  await delay(1500);
  assert.equal(received,'echo one\recho two\rsudo -i\r','Startup lines were not sent one by one or kept going after the password prompt');
  await until(()=>evaluate("Array.from({length:current().term.buffer.active.length},(_,i)=>current().term.buffer.active.getLine(i).translateToString()).join('').includes('1줄은 보내지 않았습니다')"),'Password stop notice missing');
  await until(()=>evaluate("current().sftp==='unavailable' && $('sftp').classList.contains('unavailable')"),'File button not dimmed without SFTP');
  // SFTP missing but exec works: files go over SSH commands (cat·ls) and the button stays enabled.
  execFiles=true;
  const beforeShell=connections;
  await evaluate(`Android.connect(JSON.stringify({inheritId:${JSON.stringify(savedId)},persist:false,command:''}),80,24)`);
  await until(async()=>connections===beforeShell+1 && await evaluate("current()?.sftp==='shell' && !$('sftp').classList.contains('unavailable')"),'Exec file fallback not detected');
  await evaluate("$('sftp').click()");
  await until(()=>evaluate("$('file-list').textContent.includes('hello.txt')"),'File list over SSH commands failed');
  await evaluate(`Android.list(active, ${JSON.stringify(remoteRoot)})`);
  await until(()=>evaluate(`$('remote-directory').value===${JSON.stringify(remoteRoot)} || $('file-list').textContent.includes('hello.txt')`),'Absolute path listing failed');
  await evaluate("$('close-files').click()");
  execFiles=false; sftpEnabled=true;
  const beforeAix=connections;
  // AIX template: Backspace ^H with matching pty VERASE, vt220 Home, EUC-KR both ways.
  await evaluate(`Android.connect(JSON.stringify({inheritId:${JSON.stringify(savedId)},persist:false,termType:'xterm',encoding:'euc-kr',keys:{backspace:'ctrl-h',delete:'vt220',homeEnd:'vt220',enter:'CR'}}),80,24)`);
  await until(async()=>connections===beforeAix+1 && await evaluate("current()?.state==='connected'"),'AIX profile did not connect');
  // VERASE is not asserted: the ssh2 server parser starts the modes string at offset 1, dropping the first opcode.
  assert.equal(ptyRequest.term,'xterm');
  received=''; raw=Buffer.alloc(0);
  await evaluate("current().term.input('\\x7f')"); await until(()=>received.includes('\b'),'Backspace not mapped to ^H');
  await evaluate("current().term.input('\\x1b[H')"); await until(()=>received.includes('\x1b[1~'),'Home not mapped to vt220');
  await evaluate("current().term.input('한글-EUC\\r')");
  await until(()=>raw.includes(Buffer.from([0xc7,0xd1,0xb1,0xdb])),'EUC-KR input not encoded');
  await until(()=>evaluate("Array.from({length:current().term.buffer.active.length},(_,i)=>current().term.buffer.active.getLine(i).translateToString()).join('').includes('한글-EUC')"),'EUC-KR output not decoded');
  // Server drop shows the reconnect notice and button; the button reconnects in the same tab.
  const aixId=await evaluate('active'), beforeDrop=connections;
  lastClient.end();
  await until(()=>evaluate("current().state==='disconnected' && !current().again.hidden"),'Reconnect button not shown');
  assert(await evaluate("Array.from({length:current().term.buffer.active.length},(_,i)=>current().term.buffer.active.getLine(i).translateToString()).join('').includes('재접속이 필요합니다')"),'Disconnect notice missing');
  await evaluate("current().again.click()");
  await until(()=>connections===beforeDrop+1,'Reconnect failed');
  await until(()=>evaluate(`active===${JSON.stringify(aixId)} && current().state==='connected' && current().again.hidden`),'Reconnect did not reuse the tab');
  await until(()=>evaluate("current().sftp==='ok' && !$('sftp').classList.contains('unavailable')"),'SFTP check did not pass on a capable server');
  // Tab menu by right click / long press: duplicate the same server into a new tab.
  await evaluate("current().tab.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:20,clientY:20}))");
  assert(await evaluate("!$('tab-menu').hidden && [...$('tab-menu').querySelectorAll('button')].map(b=>b.textContent).join('|').includes('같은 서버 새 탭')"),'Tab menu not shown');
  assert(await evaluate("!current().tab.querySelector('.close')"),'Tab still has a close button');
  await evaluate("[...$('tab-menu').querySelectorAll('button')].find(b=>b.textContent==='같은 서버 새 탭').click()");
  await until(()=>connections===beforeDrop+2 && evaluate(`active!==${JSON.stringify(aixId)} && current()?.state==='connected'`),'Duplicate tab failed');
  assert(await evaluate("$('tab-menu').hidden"),'Tab menu stayed open');
  const beforeChangedKey=connections;
  await evaluate("for(const id of [...sessions.keys()]) { Android.disconnect(id); } window.nativeEvent({type:'reset'});");
  await new Promise(resolve => server.close(resolve));
  // Same address + port, different host key must fail closed without asking to overwrite.
  await startServer(port);
  await evaluate(`Android.connect(JSON.stringify({savedId:${JSON.stringify(savedId)}}),80,24)`);
  await until(() => evaluate("current()?.state==='disconnected'"),'Changed key was not rejected');
  assert.equal(connections,beforeChangedKey,'Changed host key authenticated');
  assert.match(await evaluate("$('toast').textContent"),/HostKey|host.?key|reject/i);
  await evaluate(`Android.delete(${JSON.stringify(savedId)}); for(const id of sessions.keys()) Android.disconnect(id);`);
  console.log('PASS: phone/desktop layouts, encrypted profiles, password/key SSH, SFTP listing, UTF-8 I/O, touch Ctrl+C, pinch font/PTY resize, tmux existing/new/plain/cancel selection, multi-line startup, SFTP availability, file list over SSH commands without SFTP, AIX keys/EUC-KR, reconnect button, tab menu duplicate, resume health check, PTY resize without reconnect, background retention, trusted reconnect, changed-host-key rejection.');
} catch(error) {
  console.error(error); process.exitCode=1; try { screenshot('failure.png'); } catch {}
} finally {
  browserSocket?.close();
  server?.close();
  adb('shell','am','force-stop',pkg);
  adb('shell','wm','size','reset'); adb('shell','wm','density','reset');
  if(forwardedPort) adb('reverse','--remove',`tcp:${forwardedPort}`);
  adb('forward','--remove','tcp:9223');
  rmSync(remoteRoot,{recursive:true,force:true});
}
// Lingering SSH sockets from the emulator must not keep the run alive.
process.exit();
