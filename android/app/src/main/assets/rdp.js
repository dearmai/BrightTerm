// 내장 원격 데스크톱(Android) — IronRDP(WASM) + 이 기기 안의 RDCleanPath 중계(Java RdpGateway).
// 터치패드 모드: 한 손가락으로 커서 이동, 탭 = 클릭, 두 번 탭 후 끌기 = 끌어서 놓기, 두 손가락 탭 = 오른쪽 클릭,
// 두 손가락 끌기 = 화면 이동(확대했을 때, 아니면 스크롤), 핀치 = 확대·축소.
import "./vendor/ironrdp/iron-remote-desktop.js";
import { Backend, displayControl, init } from "./vendor/ironrdp/iron-remote-desktop-rdp.js";

const $ = (id) => document.getElementById(id);
const A = window.Android;
const host = window.parent !== window ? window.parent : null;
const token = new URLSearchParams(location.search).get("t") || "";
const SCALE = { fit: 1, full: 2, real: 3 };

// ---------------------------------------------------------------- 클립보드 — WebView 는 읽기 권한을 주지 않는다. Android 클립보드로 잇는다(텍스트)
if (navigator.clipboard && A) {
  const c = navigator.clipboard;
  c.read = async () => {
    const t = A.clipboardText();
    return t ? [new ClipboardItem({ "text/plain": new Blob([t], { type: "text/plain" }) })] : [];
  };
  c.readText = async () => A.clipboardText();
  c.write = async (items) => {
    for (const item of items) if (item.types.includes("text/plain")) { A.copy(await (await item.getType("text/plain")).text()); return; }
  };
  c.writeText = async (t) => A.copy(t);
  const query = navigator.permissions.query.bind(navigator.permissions);
  navigator.permissions.query = (d) =>
    d && (d.name === "clipboard-read" || d.name === "clipboard-write") ? Promise.resolve({ state: "granted", onchange: null }) : query(d);
}

// ---------------------------------------------------------------- 키 입력 — IronRDP 는 자기 요소에 포커스가 있을 때만 키를 보낸다.
// 소프트 키보드는 숨은 입력칸에 포커스가 있어야 뜨므로, 보내는 동안만 포커스를 IronRDP 요소로 보이게 한다.
const realActive = Object.getOwnPropertyDescriptor(Document.prototype, "activeElement").get;
let forceActive = null;
Object.defineProperty(document, "activeElement", { configurable: true, get() { return forceActive ?? realActive.call(this); } });

let info = null, ui = null, el = null, phase = "loading", attempt = 0, steps = [], fellBack = false, notice = "", applied = null;
const mods = { ctrl: false, alt: false, shift: false, win: false };

function asRemote(fn) {
  forceActive = el;
  try { fn(); } finally { forceActive = null; }
}
function key(type, code, keyName, extra = {}) {
  window.dispatchEvent(new KeyboardEvent(type, { code, key: keyName, bubbles: true, ctrlKey: mods.ctrl, altKey: mods.alt, shiftKey: mods.shift, metaKey: mods.win, ...extra }));
}
const MOD_CODES = { ctrl: ["ControlLeft", "Control"], alt: ["AltLeft", "Alt"], shift: ["ShiftLeft", "Shift"], win: ["MetaLeft", "Meta"] };
function withMods(fn) {
  const on = Object.keys(mods).filter((m) => mods[m]);
  for (const m of on) key("keydown", ...MOD_CODES[m]);
  fn();
  for (const m of on.reverse()) key("keyup", ...MOD_CODES[m]);
}
function clearMods() {
  for (const m of Object.keys(mods)) mods[m] = false;
  for (const b of document.querySelectorAll("#keys [data-mod]")) b.classList.remove("on");
}
/** 이름 있는 키(Esc·Tab·방향키 …) — 스캔 코드 */
function tapKey(code) {
  if (!ui || phase !== "connected") return;
  asRemote(() => withMods(() => { key("keydown", code, code); key("keyup", code, code); }));
  clearMods();
}
function charCode(ch) {
  if (/^[a-z]$/i.test(ch)) return "Key" + ch.toUpperCase();
  if (/^[0-9]$/.test(ch)) return "Digit" + ch;
  return { " ": "Space", "-": "Minus", "=": "Equal", "[": "BracketLeft", "]": "BracketRight", ";": "Semicolon", "'": "Quote", ",": "Comma", ".": "Period", "/": "Slash", "\\": "Backslash", "`": "Backquote" }[ch] || "";
}
/** 글자 — 수정 키가 없으면 유니코드로(한글 포함), 있으면 그 글자의 스캔 코드로(Ctrl+C 등) */
function typeText(text) {
  if (!ui || phase !== "connected" || !text) return;
  const anyMod = mods.ctrl || mods.alt || mods.win;
  asRemote(() => {
    if (anyMod) {
      for (const ch of text) { const code = charCode(ch); if (code) withMods(() => { key("keydown", code, ch); key("keyup", code, ch); }); }
      return;
    }
    ui.setKeyboardUnicodeMode(true);
    for (const ch of text) {
      if (ch === "\n") { key("keydown", "Enter", "Enter"); key("keyup", "Enter", "Enter"); continue; }
      key("keydown", "", ch); key("keyup", "", ch);
    }
    ui.setKeyboardUnicodeMode(!!info.options.unicodeKeyboard);
  });
  if (anyMod) clearMods();
}

// 숨은 입력칸 — 소프트 키보드. 조합(한글) 중에는 보내지 않고 끝나면 보낸다
const ime = $("ime");
let composing = false;
ime.addEventListener("compositionstart", () => { composing = true; });
ime.addEventListener("compositionend", (e) => { composing = false; typeText(e.data || ""); ime.value = ""; });
ime.addEventListener("beforeinput", (e) => {
  if (e.inputType === "deleteContentBackward" && !composing) { e.preventDefault(); tapKey("Backspace"); }
  else if (e.inputType === "deleteContentForward" && !composing) { e.preventDefault(); tapKey("Delete"); }
  else if ((e.inputType === "insertLineBreak" || e.inputType === "insertParagraph") && !composing) { e.preventDefault(); tapKey("Enter"); }
});
ime.addEventListener("input", (e) => {
  if (composing || e.isComposing) return;
  if (e.inputType === "insertText" || e.inputType === "insertFromPaste") typeText(e.data ?? ime.value);
  ime.value = "";
});
ime.addEventListener("keydown", (e) => {
  // 하드웨어 키보드로 입력칸에 칠 때 — 이름 있는 키는 그대로 보낸다
  if (e.isComposing || e.keyCode === 229) return;
  if (["Enter", "Backspace", "Tab", "Escape", "Delete", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(e.key)) {
    e.preventDefault();
    tapKey(e.code || e.key);
  }
});

// ---------------------------------------------------------------- 연결

function describe(e) {
  const kind = typeof e?.kind === "function" ? e.kind() : -1;
  const detail = typeof e?.backtrace === "function" ? e.backtrace() : e?.message ?? String(e);
  const short = String(detail).split("\n")[0];
  switch (kind) {
    case 1: return { message: "비밀번호가 틀렸습니다.", auth: true };
    case 2: return { message: "로그온에 실패했습니다 — 사용자 이름·도메인·비밀번호를 확인하세요.", auth: true };
    case 3: return { message: "접근이 거부되었습니다 — 이 계정이 원격 데스크톱 사용자 그룹에 있는지 확인하세요.", auth: true };
    case 4: {
      const d = typeof e.rdcleanpathDetails === "function" ? e.rdcleanpathDetails() : undefined;
      if (d?.tlsAlertCode === 42) return { message: "서버 인증서가 처음 확인한 것과 다릅니다. 탭을 닫고 다시 연결해 인증서를 확인하세요.", auth: false };
      if (d?.wsaErrorCode) return { message: `서버에 연결하지 못했습니다 (WSA ${d.wsaErrorCode}).`, auth: false };
      return { message: `연결 중계 오류: ${short}`, auth: false };
    }
    case 5: return { message: `앱 내부 중계에 연결하지 못했습니다: ${short}`, auth: false };
    case 6: return { message: `RDP 협상 실패: ${short}`, auth: false };
    default: return { message: short || "알 수 없는 오류", auth: /credssp|logon|password|auth/i.test(short) };
  }
}

let wasm = null;
const ensureWasm = () => (wasm ??= init("WARN"));

function readInfo() {
  const i = JSON.parse(A.rdpInfo(token));
  if (i.error) throw new Error(i.error);
  return i;
}

function sizeOf(resolution) {
  const m = /^(\d+)x(\d+)$/.exec(resolution || "");
  if (m) return { width: +m[1], height: +m[2] };
  // 창 크기에 맞춤 — 화면 픽셀 기준(휴대폰은 CSS 픽셀이 작다)
  const r = $("screen").getBoundingClientRect(), dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  const even = (v, min) => Math.max(min, Math.min(2560, Math.floor((v * dpr) / 2) * 2));
  return { width: even(r.width, 800), height: even(r.height, 600) };
}

function mount(i) {
  return new Promise((resolve) => {
    const stage = $("stage");
    stage.replaceChildren();
    el = document.createElement("iron-remote-desktop");
    el.setAttribute("scale", i.options.scale || "fit");
    el.setAttribute("flexcenter", "true");
    el.setAttribute("verbose", "false");
    el.module = Backend;
    el.addEventListener("ready", (ev) => {
      const u = ev.detail.irgUserInteraction;
      u.setEnableClipboard(!!i.options.clipboard);
      u.setEnableAutoClipboard(!!i.options.clipboard);
      u.setKeyboardUnicodeMode(!!i.options.unicodeKeyboard);
      u.onWarningCallback((w) => warn(w));
      // 클립보드 권한 확인이 끝난 뒤 연결해야 클립보드 채널이 붙는다
      const settle = () => setTimeout(() => resolve(u), 0);
      if (i.options.clipboard) navigator.permissions.query({ name: "clipboard-read" }).then(settle, settle);
      else settle();
    }, { once: true });
    stage.append(el);
  });
}

function setPhase(p, message, error) {
  phase = p;
  $("dot").className = "dot " + (p === "connected" ? "connected" : p === "connecting" || p === "loading" ? "connecting" : "closed");
  $("disconnect").textContent = p === "connected" ? "끊기" : "다시 연결";
  host?.rdpState?.(token, p === "connected" ? "connected" : p === "connecting" || p === "loading" ? "connecting" : "closed");
  const card = $("card");
  $("overlay").hidden = p === "connected";
  card.className = "card" + (error ? " error" : "");
  card.replaceChildren();
  if (p === "loading" || p === "connecting") {
    card.append(text("div", `${info?.title ?? ""} 에 연결 중…`), text("div", info?.route ?? "", "muted"));
    const list = document.createElement("div"); list.className = "steps"; list.id = "steps";
    card.append(list); renderSteps();
  } else if (p === "ended") {
    card.append(text("div", message || "연결이 끝났습니다"));
    if (error && steps.length) { const l = document.createElement("div"); l.className = "steps"; for (const s of steps.slice(-4)) l.append(text("div", s)); card.append(l); }
    card.append(row(button("다시 연결", () => reconnect(), "primary"), button("탭 닫기", close)));
  } else if (p === "login") {
    card.append(text("b", `${info?.title ?? ""} 로그인`));
    if (message) card.append(text("div", message, "err"));
    const user = input("사용자 이름 (도메인\\사용자 가능)", info?.domain ? `${info.domain}\\${info.username}` : info?.username ?? "");
    const pw = input("비밀번호", "", "password");
    card.append(user.label, pw.label, row(button("취소", close), button("연결", () => {
      const m = /^([^\\]+)\\(.+)$/.exec(user.input.value.trim());
      connect(info, m ? m[2] : user.input.value.trim(), m ? m[1] : "", pw.input.value);
    }, "primary")));
    setTimeout(() => (user.input.value ? pw.input : user.input).focus(), 50);
  }
}
const text = (tag, t, cls) => { const e = document.createElement(tag); e.textContent = t; if (cls) e.className = cls; return e; };
const button = (t, fn, cls) => { const b = document.createElement("button"); b.textContent = t; b.onclick = fn; if (cls) b.className = cls; return b; };
const row = (...items) => { const r = document.createElement("div"); r.className = "row"; r.append(...items); return r; };
function input(labelText, value, type = "text") {
  const label = document.createElement("label"); label.textContent = labelText;
  const i = document.createElement("input"); i.type = type; i.value = value; i.autocapitalize = "off"; i.spellcheck = false;
  label.append(i);
  return { label, input: i };
}
function warn(m) {
  const w = $("warn");
  w.textContent = m; w.hidden = !m;
  if (m) { clearTimeout(warn.t); warn.t = setTimeout(() => { w.hidden = true; }, 8000); }
}
function renderSteps() {
  const l = $("steps"); if (!l) return;
  l.replaceChildren(...steps.map((s, k) => text("div", s, k === steps.length - 1 ? "now" : "")));
}
window.rdpLog = (m) => { steps = [...steps.slice(-7), m]; renderSteps(); };

const stuckAt15 = () => {
  const at = steps.findIndex((m) => m.includes("색 깊이 15비트"));
  return at >= 0 && !steps.slice(at).some((m) => m.startsWith("로그온 정보"));
};
function fallback16() {
  if (fellBack) return;
  fellBack = true; attempt++;
  try { ui?.shutdown(); } catch { /* */ }
  A.rdpDepthFallback(token);
  notice = "15비트 접속이 멈춰 16비트로 다시 연결했습니다. 앱을 켜 둔 동안 이 서버는 16비트로 접속합니다.";
  reconnect();
}

async function connect(i, username, domain, password) {
  const my = ++attempt;
  steps = [];
  setPhase("connecting");
  warn(notice); notice = "";
  // 15비트는 일부 Windows 가 화면 협상에서 멈춘다 — 10초 안에 로그온 정보까지 못 가면 16비트로
  const watch = setInterval(() => { if (my !== attempt || phase !== "connecting") return clearInterval(watch); }, 1000);
  setTimeout(() => { if (my === attempt && phase === "connecting" && !fellBack && stuckAt15()) fallback16(); }, 12000);
  try {
    await ensureWasm();
    const u = await mount(i);
    if (my !== attempt) return;
    ui = u;
    const size = sizeOf(i.options.resolution);
    const config = u.configBuilder()
      .withUsername(username).withPassword(password).withServerDomain(domain || "")
      .withDestination(i.destination).withProxyAddress(i.wsUrl).withAuthToken(i.token)
      .withDesktopSize(size).withExtension(displayControl(true)).build();
    const session = await u.connect(config);
    if (my !== attempt) return;
    u.setVisibility(true);
    u.setScale(SCALE[i.options.scale] || 1);
    if (i.options.dpi && i.options.dpi !== 100) setTimeout(() => { if (my === attempt) { const s = sizeOf(i.options.resolution); u.resize(s.width, s.height, i.options.dpi); } }, 1500);
    applied = { colorDepth: i.options.colorDepth, audio: i.options.audio, experience: { ...i.options.experience }, clipboard: i.options.clipboard };
    setPhase("connected");
    resetView();
    const end = await session.run();
    if (my !== attempt) return;
    setPhase("ended", `연결이 끝났습니다${end?.reason?.() ? ` — ${end.reason()}` : ""}`);
  } catch (e) {
    if (my !== attempt) return;
    if (!fellBack && stuckAt15()) return fallback16();
    const d = describe(e);
    console.warn("[rdp]", e);
    if (d.auth) setPhase("login", d.message); else setPhase("ended", d.message, true);
  }
}

function reconnect() {
  try {
    info = readInfo();
    $("title").textContent = info.title;
    $("sub").textContent = `${info.route}${info.security ? ` · ${info.security}` : ""}`;
    if (info.password && info.username) connect(info, info.username, info.domain, info.password);
    else setPhase("login");
  } catch (e) { setPhase("ended", e.message, true); }
}
function disconnect() {
  attempt++;
  try { ui?.shutdown(); } catch { /* */ }
  setPhase("ended", "연결을 끊었습니다");
}
function close() {
  attempt++;
  try { ui?.shutdown(); } catch { /* */ }
  if (host?.rdpCloseTab) host.rdpCloseTab(token); else A.rdpClose(token);
}
window.rdpShutdown = () => { attempt++; try { ui?.shutdown(); } catch { /* */ } };

// ---------------------------------------------------------------- 화면 확대·이동과 터치패드

let zoom = 1, panX = 0, panY = 0;
const cursor = { x: 0, y: 0 };
const screenRect = () => $("screen").getBoundingClientRect();
function canvas() { return el?.shadowRoot?.querySelector("canvas") ?? null; }
function applyView() {
  const r = screenRect();
  panX = Math.min(0, Math.max(r.width - r.width * zoom, panX));
  panY = Math.min(0, Math.max(r.height - r.height * zoom, panY));
  $("stage").style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
  $("zoom-reset").hidden = zoom <= 1.01;
  $("zoom-reset").textContent = `${zoom.toFixed(1)}×`;
}
function resetView() {
  zoom = 1; panX = panY = 0; applyView();
  const r = screenRect();
  cursor.x = r.left + r.width / 2; cursor.y = r.top + r.height / 2;
  drawCursor();
}
function zoomAt(z, cx, cy) {
  const r = screenRect();
  const nz = Math.max(1, Math.min(5, z));
  const lx = cx - r.left, ly = cy - r.top;
  panX = lx - (lx - panX) * (nz / zoom);
  panY = ly - (ly - panY) * (nz / zoom);
  zoom = nz;
  applyView();
}
function drawCursor() {
  const c = $("cursor");
  c.hidden = phase !== "connected";
  const r = screenRect();
  c.style.transform = `translate(${cursor.x - r.left}px, ${cursor.y - r.top}px)`;
}
/** 커서가 보이는 원격 화면 안에 있게 — 확대했을 때 가장자리에 닿으면 화면을 민다 */
function moveCursor(dx, dy) {
  const r = screenRect(), cv = canvas()?.getBoundingClientRect();
  const minX = Math.max(r.left, cv?.left ?? r.left), maxX = Math.min(r.right, cv?.right ?? r.right) - 1;
  const minY = Math.max(r.top, cv?.top ?? r.top), maxY = Math.min(r.bottom, cv?.bottom ?? r.bottom) - 1;
  let x = cursor.x + dx, y = cursor.y + dy;
  if (zoom > 1) {
    if (x < minX) { panX += minX - x; } else if (x > maxX) { panX -= x - maxX; }
    if (y < minY) { panY += minY - y; } else if (y > maxY) { panY -= y - maxY; }
    applyView();
  }
  cursor.x = Math.max(minX, Math.min(maxX, x));
  cursor.y = Math.max(minY, Math.min(maxY, y));
  drawCursor();
  mouse("mousemove", 0);
}
function mouse(type, button) {
  const c = canvas(); if (!c || phase !== "connected") return;
  c.dispatchEvent(new MouseEvent(type, { clientX: cursor.x, clientY: cursor.y, button, buttons: type === "mouseup" ? 0 : button === 2 ? 2 : 1, bubbles: true, composed: true, cancelable: true }));
}
function click(button) {
  mouse("mousemove", 0);
  mouse("mousedown", button);
  mouse("mouseup", button);
  if (button === 2) canvas()?.dispatchEvent(new MouseEvent("contextmenu", { clientX: cursor.x, clientY: cursor.y, button: 2, bubbles: true, composed: true, cancelable: true }));
}
function wheel(dy) {
  const c = canvas(); if (!c || phase !== "connected") return;
  c.dispatchEvent(new WheelEvent("wheel", { clientX: cursor.x, clientY: cursor.y, deltaY: dy, deltaMode: 0, bubbles: true, composed: true, cancelable: true }));
}
window.rdpTest = { click, moveCursor, cursor, get zoom() { return zoom; }, get pan() { return [panX, panY]; }, typeText, tapKey, get phase() { return phase; }, get ui() { return ui; } };

const TAP_MS = 250, TAP_MOVE = 10, SPEED = 1.4;
let g = null, lastTap = 0, dragging = false;
const touchArea = $("touch");
const mid = (t) => ({ x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 });
const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
touchArea.addEventListener("touchstart", (e) => {
  e.preventDefault();
  if (phase !== "connected") return;
  const t = e.touches;
  if (t.length === 1 && !g) {
    g = { n: 1, start: Date.now(), x: t[0].clientX, y: t[0].clientY, lx: t[0].clientX, ly: t[0].clientY, moved: false, drag: Date.now() - lastTap < 350 };
  } else if (t.length >= 2) {
    if (g?.n === 1 && dragging) { mouse("mouseup", 0); dragging = false; }
    g = { n: 2, start: g?.n === 1 && !g.moved ? g.start : Date.now(), d0: Math.max(1, dist(t)), z0: zoom, m: mid(t), moved: false };
  }
  // 한 번 누르면 원격 화면이 하드웨어 키보드를 받게(소프트 키보드는 ⌨)
  if (document.activeElement !== ime) canvas()?.focus({ preventScroll: true });
}, { passive: false });
touchArea.addEventListener("touchmove", (e) => {
  e.preventDefault();
  if (!g || phase !== "connected") return;
  const t = e.touches;
  if (g.n === 1 && t.length === 1) {
    const dx = t[0].clientX - g.lx, dy = t[0].clientY - g.ly;
    g.lx = t[0].clientX; g.ly = t[0].clientY;
    if (!g.moved && Math.hypot(t[0].clientX - g.x, t[0].clientY - g.y) > TAP_MOVE) {
      g.moved = true;
      // 두 번 탭 후 끌기 = 왼쪽 버튼을 누른 채 끌기
      if (g.drag) { mouse("mousedown", 0); dragging = true; }
    }
    if (g.moved) moveCursor(dx * SPEED, dy * SPEED);
  } else if (g.n === 2 && t.length >= 2) {
    const m = mid(t), d = dist(t);
    const ratio = d / g.d0;
    if (Math.abs(ratio - 1) > 0.04 || Math.hypot(m.x - g.m.x, m.y - g.m.y) > TAP_MOVE) g.moved = true;
    if (!g.moved) return;
    const dx = m.x - g.m.x, dy = m.y - g.m.y;
    if (zoom > 1 || Math.abs(ratio - 1) > 0.04) {
      zoomAt(g.z0 * ratio, m.x, m.y);
      panX += dx; panY += dy; applyView();
      g.z0 = zoom; g.d0 = d;
    } else {
      // 확대하지 않았을 때 두 손가락 끌기는 스크롤
      wheel(-dy * 2);
    }
    g.m = m;
    drawCursor();
  }
}, { passive: false });
function touchEnd(e) {
  e.preventDefault();
  if (!g) return;
  if (e.touches.length) return;
  const quick = Date.now() - g.start < TAP_MS + 150;
  if (g.n === 1) {
    if (dragging) { mouse("mouseup", 0); dragging = false; lastTap = 0; }
    else if (!g.moved && Date.now() - g.start < TAP_MS + 100) { click(0); lastTap = Date.now(); }
  } else if (g.n === 2 && !g.moved && quick) click(2);
  g = null;
}
touchArea.addEventListener("touchend", touchEnd, { passive: false });
touchArea.addEventListener("touchcancel", touchEnd, { passive: false });
// 마우스(DeX·블루투스)는 그대로 원격으로 — 터치 영역 아래 캔버스가 받게 한다
touchArea.addEventListener("pointerdown", (e) => { if (e.pointerType === "mouse") touchArea.style.pointerEvents = "none"; });
document.addEventListener("pointermove", (e) => { if (e.pointerType === "touch") touchArea.style.pointerEvents = ""; });
window.addEventListener("resize", () => { applyView(); drawCursor(); });

// ---------------------------------------------------------------- 막대·키·설정

$("kbd").onclick = () => {
  if (document.activeElement === ime) { ime.blur(); return; }
  ime.focus({ preventScroll: true });
};
$("keys-btn").onclick = () => { $("keys").hidden = !$("keys").hidden; $("keys-btn").classList.toggle("on", !$("keys").hidden); };
$("zoom-reset").onclick = () => { zoom = 1; panX = panY = 0; applyView(); drawCursor(); };
$("disconnect").onclick = () => (phase === "connected" ? disconnect() : reconnect());
for (const b of document.querySelectorAll("#keys [data-mod]")) b.onclick = () => { const m = b.dataset.mod; mods[m] = !mods[m]; b.classList.toggle("on", mods[m]); };
for (const b of document.querySelectorAll("#keys [data-key]")) b.onclick = () => tapKey(b.dataset.key);
document.querySelector('#keys [data-special="cad"]').onclick = () => { if (ui && phase === "connected") ui.ctrlAltDel(); };
document.querySelector('#keys [data-special="paste"]').onclick = () => typeText(A.clipboardText());
// 막대 버튼을 눌러도 소프트 키보드가 닫히지 않게
for (const b of document.querySelectorAll("#bar button, #keys button")) b.addEventListener("pointerdown", (e) => { if (document.activeElement === ime) e.preventDefault(); });

const RESOLUTIONS = ["window", "1024x768", "1280x720", "1366x768", "1600x900", "1920x1080", "2560x1440"];
const PRESETS = {
  best: { label: "최고 화질", colorDepth: 32, experience: { wallpaper: true, themes: true, fontSmoothing: true, composition: true, windowDrag: true, animations: true, cursorShadow: true } },
  balanced: { label: "균형", colorDepth: 32, experience: { wallpaper: false, themes: true, fontSmoothing: true, composition: true, windowDrag: false, animations: false, cursorShadow: false } },
  fast: { label: "빠르게", colorDepth: 16, experience: { wallpaper: false, themes: false, fontSmoothing: false, composition: false, windowDrag: false, animations: false, cursorShadow: false } },
};
const EXPERIENCE = { wallpaper: "바탕 화면 배경", themes: "시각 스타일", fontSmoothing: "글꼴 다듬기", composition: "투명 효과", windowDrag: "끄는 동안 창 내용", animations: "애니메이션", cursorShadow: "포인터 그림자" };
function presetOf(o) {
  for (const [k, p] of Object.entries(PRESETS)) if (p.colorDepth === o.colorDepth && Object.keys(p.experience).every((x) => p.experience[x] === o.experience[x])) return k;
  return "custom";
}

async function change(patch) {
  const next = JSON.parse(A.rdpSetOptions(token, JSON.stringify(patch)));
  if (next.error) { warn(`설정을 저장하지 못했습니다: ${next.error}`); return; }
  info.options = next;
  if (ui && phase === "connected") {
    if (patch.scale) ui.setScale(SCALE[next.scale] || 1);
    if (patch.unicodeKeyboard !== undefined) ui.setKeyboardUnicodeMode(next.unicodeKeyboard);
    if (patch.clipboard !== undefined && applied?.clipboard) ui.setEnableAutoClipboard(next.clipboard);
    if (patch.resolution !== undefined || patch.dpi !== undefined) { const s = sizeOf(next.resolution); ui.resize(s.width, s.height, next.dpi); }
  }
  renderPanel();
}

function renderPanel() {
  const p = $("panel");
  if (p.hidden || !info) return;
  const o = info.options;
  p.replaceChildren();
  const seg = (value, options, onPick) => {
    const s = document.createElement("div"); s.className = "seg";
    for (const [v, label] of options) { const b = button(label, () => onPick(v)); if (v === value) b.className = "on"; s.append(b); }
    return s;
  };
  const select = (value, options, onPick, aria) => {
    const s = document.createElement("select"); s.setAttribute("aria-label", aria);
    for (const [v, label] of options) { const op = document.createElement("option"); op.value = v; op.textContent = label; s.append(op); }
    s.value = String(value); s.onchange = () => onPick(s.value);
    return s;
  };
  const check = (label, value, onPick) => { const l = document.createElement("label"); l.className = "check"; const c = document.createElement("input"); c.type = "checkbox"; c.checked = value; c.onchange = () => onPick(c.checked); l.append(c, label); return l; };
  const line = (label, control, hint) => { const r = document.createElement("div"); r.className = "set-row"; r.append(text("span", label, "set-label")); const box = document.createElement("div"); box.append(control); if (hint) box.append(text("div", hint, "hint")); r.append(box); return r; };
  const head = row(text("b", "원격 데스크톱 설정"), text("span", "이 서버 설정에 저장됩니다", "muted"), button("✕", () => { p.hidden = true; $("settings-btn").classList.remove("on"); }));
  head.className = "set-head";
  p.append(head, text("div", "화면 · 입력 — 바로 적용", "set-sec"));
  p.append(line("화면 맞춤", seg(o.scale, [["fit", "맞춤"], ["full", "꽉 채움"], ["real", "실제 크기"]], (v) => change({ scale: v }))));
  p.append(line("해상도", select(o.resolution, RESOLUTIONS.map((r) => [r, r === "window" ? "화면에 맞춤" : r.replace("x", " × ")]), (v) => change({ resolution: v }), "해상도")));
  p.append(line("배율", select(o.dpi, [100, 125, 150, 175, 200].map((d) => [d, `${d}%`]), (v) => change({ dpi: +v }), "배율"), "원격 Windows 의 글자·아이콘 크기"));
  p.append(line("키보드", check("문자(유니코드)로 보내기", o.unicodeKeyboard, (v) => change({ unicodeKeyboard: v }))));
  p.append(line("클립보드", check("동기화", o.clipboard, (v) => change({ clipboard: v })), applied && !applied.clipboard && o.clipboard ? "꺼진 채로 연결해 다시 연결해야 켜집니다" : "텍스트만 — 이 기기와 원격 PC"));
  p.append(text("div", "화질 · 소리 — 다시 연결하면 적용", "set-sec"));
  const preset = presetOf(o);
  p.append(line("화질", seg(preset, [...Object.entries(PRESETS).map(([k, v]) => [k, v.label]), ...(preset === "custom" ? [["custom", "사용자 지정"]] : [])], (v) => { if (v !== "custom") change({ colorDepth: PRESETS[v].colorDepth, experience: PRESETS[v].experience }); })));
  p.append(line("색 깊이", select(o.colorDepth, [32, 24, 16, 15].map((d) => [d, `${d}비트`]), (v) => change({ colorDepth: +v }), "색 깊이"), info.depthFallback ? `15비트 접속이 멈춰 지금은 ${info.depthFallback}비트로 접속했습니다` : o.colorDepth === 15 ? "일부 Windows 는 15비트에서 멈춥니다 — 그러면 16비트로 자동 다시 연결합니다" : ""));
  const exp = document.createElement("div"); exp.className = "checks";
  for (const [k, label] of Object.entries(EXPERIENCE)) exp.append(check(label, o.experience[k], (v) => change({ experience: { ...o.experience, [k]: v } })));
  p.append(exp);
  p.append(line("소리", seg(o.audio, [["remote", "원격 PC 에서 재생"], ["off", "재생 안 함"]], (v) => change({ audio: v })), "이 기기로 소리를 가져오지는 못합니다"));
  const a = applied;
  if (a && phase === "connected" && (a.colorDepth !== o.colorDepth || a.audio !== o.audio || Object.keys(o.experience).some((k) => a.experience[k] !== o.experience[k]) || (!a.clipboard && o.clipboard))) {
    const f = row(text("span", "바뀐 화질·소리는 다시 연결해야 적용됩니다."), button("다시 연결해 적용", () => { p.hidden = true; disconnect(); reconnect(); }, "primary"));
    f.className = "set-foot"; p.append(f);
  }
  p.append(text("div", "터치: 한 손가락 = 커서 이동 · 탭 = 클릭 · 두 번 탭 후 끌기 = 끌기 · 두 손가락 탭 = 오른쪽 클릭 · 두 손가락 끌기 = 화면 이동(확대 시)/스크롤 · 핀치 = 확대·축소", "hint"));
}
$("settings-btn").onclick = () => { const p = $("panel"); p.hidden = !p.hidden; $("settings-btn").classList.toggle("on", !p.hidden); renderPanel(); };

// ---------------------------------------------------------------- 시작
try {
  info = readInfo();
  document.documentElement.dataset.theme = info.theme;
  $("title").textContent = info.title;
  $("sub").textContent = `${info.route}${info.security ? ` · ${info.security}` : ""}`;
  setPhase("loading");
  if (info.password && info.username) connect(info, info.username, info.domain, info.password);
  else setPhase("login");
} catch (e) {
  setPhase("ended", e.message, true);
}
