"use strict";
// 원격 데스크톱(RDP) — 서버 편집의 OS·RDP 설정, 서버 목록의 RDP 버튼, 원격 데스크톱 탭(rdp.html iframe).
// app.js 의 select·renderProfiles·openEditor·getProfile·nativeEvent 가 여기 함수를 부른다.
(() => {
  const views = new Map(); // token → { token, name, frame, tab, state }
  const waiting = new Map(); // 요청 id → resolve
  const form = () => $("form").elements;
  let editingRdp = null; // 편집 중인 서버의 원래 rdp 설정(credentialId 등 유지)

  const PRESETS = {
    best: { colorDepth: 32, experience: { wallpaper: true, themes: true, fontSmoothing: true, composition: true, windowDrag: true, animations: true, cursorShadow: true } },
    balanced: { colorDepth: 32, experience: { wallpaper: false, themes: true, fontSmoothing: true, composition: true, windowDrag: false, animations: false, cursorShadow: false } },
    fast: { colorDepth: 16, experience: { wallpaper: false, themes: false, fontSmoothing: false, composition: false, windowDrag: false, animations: false, cursorShadow: false } },
  };
  function presetOf(r) {
    const depth = r?.colorDepth ?? 32;
    const e = { ...PRESETS.best.experience, ...(r?.experience || {}) };
    for (const [k, p] of Object.entries(PRESETS)) if (p.colorDepth === depth && Object.keys(p.experience).every((x) => p.experience[x] === e[x])) return k;
    return "custom";
  }

  function request(method, ...args) {
    const id = crypto.randomUUID();
    return new Promise((resolve) => { waiting.set(id, resolve); invoke(method, id, ...args); });
  }

  window.rdpEvent = (event) => {
    if (event.type === "rdp-log") { views.get(event.id)?.frame.contentWindow?.rdpLog?.(event.value); return; }
    const resolve = waiting.get(event.id);
    if (resolve) { waiting.delete(event.id); resolve(JSON.parse(event.value)); }
  };

  const capable = (p) => p?.os === "windows" && !!p?.host;
  window.rdpPrimary = (p) => capable(p) && !!p.rdp?.primary;

  // ---------------------------------------------------------------- 서버 목록

  window.rdpRowButtons = (p) => {
    if (!capable(p)) return [];
    const b = document.createElement("button");
    b.className = "edit rdp";
    b.textContent = "🖥";
    b.title = "원격 데스크톱(RDP) 연결";
    b.setAttribute("aria-label", `${p.name || p.host} 원격 데스크톱 연결`);
    b.onclick = () => window.openRdp(p);
    const row = [b];
    // 기본 연결이 RDP 면 터미널 버튼을 따로 둔다 (점프 호스트 경유 서버는 터미널을 쓸 수 없다)
    if (p.rdp?.primary && !p.unsupported) {
      const t = document.createElement("button");
      t.className = "edit";
      t.textContent = "❯_";
      t.title = "터미널로 연결";
      t.onclick = () => invoke("connect", JSON.stringify({ savedId: p.id }), current()?.term.cols || 80, current()?.term.rows || 24);
      row.push(t);
    }
    return row;
  };

  window.openRdp = async (p) => {
    toast(`${p.name || p.host}: 원격 데스크톱 확인 중…`);
    const r = await request("rdpOpen", p.id);
    if (r.error) { toast(r.error); return; }
    createView(r.token, r.title);
  };

  // ---------------------------------------------------------------- 원격 데스크톱 탭

  function createView(token, name) {
    const frame = document.createElement("iframe");
    frame.className = "rdp-frame";
    frame.src = `rdp.html?t=${encodeURIComponent(token)}`;
    frame.title = `${name} 원격 데스크톱`;
    $("terminals").append(frame);
    const tab = document.createElement("div");
    tab.className = "tab rdp-tab";
    tab.dataset.state = "connecting";
    const choose = document.createElement("button");
    choose.className = "select";
    choose.title = name;
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.textContent = "● ";
    choose.append(dot, document.createTextNode("🖥 " + name));
    choose.onclick = () => select("rdp:" + token);
    const x = document.createElement("button");
    x.className = "close";
    x.textContent = "✕";
    x.setAttribute("aria-label", `${name} 원격 데스크톱 닫기`);
    x.onclick = () => window.rdpCloseTab(token, true);
    tab.append(choose, x);
    $("tabs").append(tab);
    views.set(token, { token, name, frame, tab, state: "connecting" });
    select("rdp:" + token);
    document.body.classList.remove("sidebar-open");
  }

  window.rdpSelect = (id) => {
    let shown = false;
    for (const v of views.values()) {
      const on = id === "rdp:" + v.token;
      v.frame.hidden = !on;
      v.tab.classList.toggle("active", on);
      if (on) { shown = true; $("status").textContent = `${v.name} · ${v.state} · 원격 데스크톱`; }
    }
    // 터미널 보조키 줄은 원격 데스크톱 탭에서 감춘다(원격 화면 위 막대에 따로 있다)
    document.body.classList.toggle("rdp-active", shown);
    return shown;
  };

  window.rdpState = (token, state) => {
    const v = views.get(token);
    if (!v) return;
    v.state = state;
    v.tab.dataset.state = state === "connected" ? "connected" : state === "connecting" ? "connecting" : "disconnected";
    if (active === "rdp:" + token) $("status").textContent = `${v.name} · ${state} · 원격 데스크톱`;
  };

  /** ask: 연결 중이면 확인 */
  window.rdpCloseTab = (token, ask) => {
    const v = views.get(token);
    if (!v) return;
    if (ask && v.state === "connected" && !window.confirm(`${v.name} 원격 데스크톱 연결을 끊고 닫을까요?\n원격 세션은 서버에 남아 다시 연결하면 이어집니다.`)) return;
    try { v.frame.contentWindow?.rdpShutdown?.(); } catch (_) { /* */ }
    invoke("rdpClose", token);
    v.frame.remove();
    v.tab.remove();
    views.delete(token);
    if (active === "rdp:" + token) select([...sessions.keys()].pop() || (views.size ? "rdp:" + [...views.keys()].pop() : null));
  };

  window.rdpResetAll = () => {
    for (const v of views.values()) { v.frame.remove(); v.tab.remove(); }
    views.clear();
  };

  // ---------------------------------------------------------------- 서버 편집

  function update() {
    const f = form();
    const windows = f.os.value === "windows";
    $("rdp-settings").hidden = !windows;
    $("save-rdp").hidden = !windows;
    $("rdp-password-row").hidden = f.rdpAuth.value !== "own";
    const p = editing ? profiles.find((x) => x.id === editing) : null;
    const jump = p?.jumpHostId ? profiles.find((x) => x.id === p.jumpHostId) : null;
    f.rdpRoute.options[0].textContent = jump ? `점프 호스트 경유 (${jump.name || jump.host})` : p?.jumpHostId ? "점프 호스트 경유 (Android 에 없는 서버)" : "직접";
    $("rdp-route-hint").textContent = f.rdpRoute.value === "ssh"
      ? "이 서버에 SSH 로 접속해 127.0.0.1:RDP포트 로 터널을 엽니다 — 3389 가 막혀 있고 SSH 만 열려 있을 때"
      : jump ? "데스크톱에서 정한 점프 호스트를 거쳐 갑니다" : "이 기기에서 바로 연결합니다";
  }

  window.rdpFill = (p) => {
    const f = form();
    const r = p?.rdp || {};
    editingRdp = p?.rdp ? { ...p.rdp } : null;
    f.os.value = p?.os || "";
    f.rdpPort.value = r.port || 3389;
    f.rdpUsername.value = r.username || "";
    f.rdpDomain.value = r.domain || "";
    f.rdpAuth.value = r.auth || "host";
    f.rdpPassword.value = "";
    f.rdpPassword.placeholder = p?.hasRdpPassword || r.credentialId ? "저장된 값 유지" : "RDP 비밀번호";
    f.rdpRoute.value = r.route === "ssh" ? "ssh" : "direct";
    const preset = presetOf(r);
    f.rdpQuality.querySelector('[value="custom"]').hidden = preset !== "custom";
    f.rdpQuality.value = preset;
    f.rdpAudio.value = r.audio === "remote" ? "remote" : "off";
    f.rdpClipboard.checked = r.clipboard ?? true;
    f.rdpPrimary.checked = !!r.primary;
    $("rdp-check-result").textContent = "RDP 포트에 연결해 원격 데스크톱이 켜져 있는지, 보안 방식과 인증서를 확인합니다 — 로그인은 하지 않습니다";
    $("rdp-check-result").className = "hint";
    $("rdp-settings").open = !!p?.os && p.os === "windows";
    update();
  };

  window.rdpFields = () => {
    const f = form();
    const os = f.os.value;
    if (!os) return { os: "" };
    if (os !== "windows") return { os, ...(editingRdp ? { rdp: editingRdp } : {}) };
    const preset = f.rdpQuality.value;
    const quality = PRESETS[preset] ? { colorDepth: PRESETS[preset].colorDepth, experience: PRESETS[preset].experience } : {};
    const rdp = {
      mode: "builtin",
      resolution: "window",
      ...(editingRdp || {}),
      port: Number(f.rdpPort.value) || 3389,
      username: f.rdpUsername.value.trim() || undefined,
      domain: f.rdpDomain.value.trim() || undefined,
      auth: f.rdpAuth.value,
      route: f.rdpRoute.value,
      clipboard: f.rdpClipboard.checked,
      audio: f.rdpAudio.value,
      primary: f.rdpPrimary.checked || undefined,
      ...quality,
    };
    for (const k of Object.keys(rdp)) if (rdp[k] === undefined) delete rdp[k];
    const out = { os, rdp };
    if (f.rdpAuth.value === "own" && f.rdpPassword.value) out.rdpPassword = f.rdpPassword.value;
    return out;
  };

  const f = form();
  for (const name of ["os", "rdpAuth", "rdpRoute"]) f[name].addEventListener("change", update);
  $("rdp-check").onclick = async () => {
    const result = $("rdp-check-result");
    result.className = "hint";
    result.textContent = "확인 중…";
    const p = getProfile();
    const r = await request("rdpCheck", JSON.stringify(p));
    if (r.error) { result.textContent = r.error; result.className = "hint err"; return; }
    result.className = "hint " + (r.state === "ok" ? "ok" : r.state === "error" ? "err" : "warn");
    result.textContent = `${r.state === "ok" ? "✓" : "✕"} ${r.message}${r.security ? ` · ${r.security}` : ""}${r.latencyMs !== undefined ? ` · ${r.latencyMs}ms` : ""}\n${r.route || ""}${r.fingerprint ? `\n인증서 ${r.fingerprint}` : ""}`;
  };
  $("save-rdp").onclick = () => {
    if (!$("form").reportValidity()) return;
    const p = getProfile();
    invoke("save", JSON.stringify(p));
    $("editor").close();
    $("form").reset();
    window.openRdp(p);
  };
})();
