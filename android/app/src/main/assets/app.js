"use strict";
const $ = (id) => document.getElementById(id);
const native = window.Android;
const sessions = new Map();
let profiles = [],
  active = null,
  editing = null,
  privateKey = "",
  ctrl = false,
  alt = false,
  fontSize = 14;
let toastTimer,
  filesSession = null;
function toast(message) {
  $("toast").textContent = message;
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("toast").hidden = true), 7000);
}
function invoke(method, ...args) {
  if (native) native[method](...args);
  else toast("Android 앱에서 사용할 수 있습니다.");
}
function current() {
  return sessions.get(active);
}
function fit(session) {
  if (!session || session.pane.hidden) return;
  try {
    session.fit.fit();
    invoke("resize", session.id, session.term.cols, session.term.rows);
  } catch (_) {
    /* First frame may have no dimensions. */
  }
}
function select(id) {
  active = id;
  for (const s of sessions.values()) {
    s.pane.hidden = s.id !== id;
    s.tab.classList.toggle("active", s.id === id);
  }
  const s = current();
  $("welcome").hidden = !!s;
  $("status").textContent = s
    ? `${s.name} · ${s.state} · SSH`
    : "연결 대기 · SSH";
  requestAnimationFrame(() => {
    fit(s);
    if (s) s.term.focus();
  });
}
function closeSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  if (
    s.state !== "disconnected" &&
    !window.confirm(`${s.name} 연결을 끊을까요?`)
  )
    return;
  invoke("disconnect", id);
  s.term.dispose();
  s.pane.remove();
  s.tab.remove();
  sessions.delete(id);
  if (active === id) select([...sessions.keys()].pop() || null);
}
function createSession(id, name) {
  if (sessions.has(id)) return;
  const pane = document.createElement("div");
  pane.className = "terminal-pane";
  $("terminals").append(pane);
  const term = new Terminal({
    cursorBlink: true,
    fontSize,
    fontFamily: "monospace",
    scrollback: 5000,
    allowProposedApi: false,
    theme: {
      background: "#0d1117",
      foreground: "#d6dde6",
      cursor: "#7dd3fc",
      selectionBackground: "#2f4a6b",
    },
  });
  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(pane);
  const tab = document.createElement("div");
  tab.className = "tab";
  tab.dataset.state = "connecting";
  const choose = document.createElement("button");
  choose.className = "select";
  choose.title = name;
  const dot = document.createElement("span");
  dot.className = "dot";
  dot.textContent = "● ";
  choose.append(dot, document.createTextNode(name));
  choose.onclick = () => select(id);
  const close = document.createElement("button");
  close.className = "close";
  close.textContent = "×";
  close.setAttribute("aria-label", `${name} 연결 닫기`);
  close.onclick = () => closeSession(id);
  tab.append(choose, close);
  $("tabs").append(tab);
  const session = {
    id,
    name,
    term,
    fit: fitAddon,
    pane,
    tab,
    state: "connecting",
  };
  sessions.set(id, session);
  term.onData((data) => {
    if (ctrl && data.length === 1) {
      const code = data.toUpperCase().charCodeAt(0);
      if (code >= 64 && code <= 95) data = String.fromCharCode(code - 64);
    }
    if (alt) data = "\x1b" + data;
    ctrl = alt = false;
    updateModifiers();
    invoke("input", id, data);
  });
  term.attachCustomKeyEventHandler((event) => {
    const appShortcut =
      event.ctrlKey &&
      (event.shiftKey || ["Tab", "+", "=", "-"].includes(event.key));
    return !appShortcut;
  });
  pane.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    if (term.hasSelection()) invoke("copy", term.getSelection());
    else invoke("paste");
  });
  select(id);
  document.body.classList.remove("sidebar-open");
}
function renderProfiles() {
  const query = $("filter").value.toLowerCase();
  $("hosts").replaceChildren();
  const visible = profiles.filter((p) =>
    `${p.name} ${p.host} ${p.username}`.toLowerCase().includes(query),
  );
  if (!visible.length) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = profiles.length
      ? "검색 결과가 없습니다."
      : "새 연결로 서버를 추가하세요.";
    $("hosts").append(empty);
  }
  for (const p of visible) {
    const row = document.createElement("div");
    row.className = "host";
    const connect = document.createElement("button");
    connect.className = "connect";
    const title = document.createElement("b");
    title.textContent = p.name || p.host;
    const detail = document.createElement("small");
    detail.textContent = `${p.username}@${p.host}:${p.port}`;
    connect.append(title, detail);
    connect.onclick = () =>
      invoke(
        "connect",
        JSON.stringify({ savedId: p.id }),
        current()?.term.cols || 80,
        current()?.term.rows || 24,
      );
    const edit = document.createElement("button");
    edit.className = "edit";
    edit.textContent = "⋯";
    edit.setAttribute("aria-label", `${p.name || p.host} 편집`);
    edit.onclick = () => openEditor(p);
    row.append(connect, edit);
    $("hosts").append(row);
  }
}
function openEditor(profile) {
  editing = profile?.id || null;
  privateKey = "";
  $("form").reset();
  for (const key of ["name", "host", "username", "port", "command"])
    $("form").elements[key].value =
      profile?.[key] ?? (key === "port" ? 22 : "");
  $("delete").hidden = !editing;
  $("editor-title").textContent = editing ? "서버 편집" : "SSH 연결";
  $("key-name").textContent = profile?.hasKey ? "저장된 개인키 사용" : "";
  $("editor").showModal();
}
function getProfile() {
  const fields = $("form").elements;
  return {
    ...(editing ? { inheritId: editing } : {}),
    id: editing || crypto.randomUUID(),
    name: fields.name.value.trim() || fields.host.value.trim(),
    host: fields.host.value.trim(),
    port: Number(fields.port.value),
    username: fields.username.value.trim(),
    password: fields.password.value,
    passphrase: fields.passphrase.value,
    privateKey,
    command: fields.command.value,
  };
}
function submit(connect) {
  if (!$("form").reportValidity()) return;
  const profile = getProfile();
  const remember = $("form").elements.remember.checked;
  if (remember || !connect) invoke("save", JSON.stringify(profile));
  if (connect) {
    // Serialized native storage ensures save finishes before saved credentials are read.
    const request = remember ? { savedId: profile.id } : profile;
    invoke(
      "connect",
      JSON.stringify(request),
      current()?.term.cols || 80,
      current()?.term.rows || 24,
    );
  }
  $("editor").close();
  $("form").reset();
  privateKey = "";
}
window.nativeEvent = (event) => {
  const s = sessions.get(event.id);
  switch (event.type) {
    case "profiles":
      profiles = JSON.parse(event.value);
      renderProfiles();
      break;
    case "session":
      createSession(event.id, event.value);
      break;
    case "data":
      if (s)
        s.term.write(
          Uint8Array.from(atob(event.value), (c) => c.charCodeAt(0)),
        );
      break;
    case "state":
      if (s) {
        s.state = event.value;
        if (s.state === "connected") fit(s);
        s.tab.dataset.state = event.value;
        if (active === s.id)
          $("status").textContent = `${s.name} · ${s.state} · SSH`;
      }
      break;
    case "files":
      if (event.id === filesSession) showFiles(JSON.parse(event.value));
      break;
    case "transfer":
      if (event.id === filesSession)
        $("transfer-status").textContent = event.value;
      break;
    case "error":
      toast(event.value);
      if (event.id === filesSession)
        $("transfer-status").textContent = event.value;
      break;
    case "key":
      privateKey = event.value;
      $("key-name").textContent = "개인키 선택됨";
      break;
    case "paste":
      if (current()) current().term.paste(event.value);
      break;
    case "reset":
      for (const item of sessions.values()) {
        item.term.dispose();
        item.pane.remove();
        item.tab.remove();
      }
      sessions.clear();
      select(null);
      break;
  }
};
window.androidBack = () => {
  if ($("files").open) $("files").close();
  else if ($("editor").open) {
    $("editor").close();
    privateKey = "";
    $("form").reset();
  } else if ($("info").open) $("info").close();
  else if (document.body.classList.contains("sidebar-open"))
    document.body.classList.remove("sidebar-open");
  else return false;
  return true;
};
function updateModifiers() {
  $("ctrl").setAttribute("aria-pressed", String(ctrl));
  $("alt").setAttribute("aria-pressed", String(alt));
}
function toggleSidebar() {
  document.body.classList.toggle(
    matchMedia("(max-width:700px)").matches ? "sidebar-open" : "sidebar-hidden",
  );
  requestAnimationFrame(() => fit(current()));
}
for (const id of ["new", "add", "first"]) $(id).onclick = () => openEditor();
$("menu").onclick = toggleSidebar;
$("filter").oninput = renderProfiles;
$("form").onsubmit = (event) => {
  event.preventDefault();
  submit(true);
};
$("save").onclick = () => submit(false);
$("cancel").onclick = () => {
  $("editor").close();
  privateKey = "";
  $("form").reset();
};
$("delete").onclick = () => {
  if (editing && confirm("저장된 서버와 자격 증명을 삭제할까요?")) {
    invoke("delete", editing);
    $("editor").close();
  }
};
$("import-key").onclick = () => invoke("importKey");
$("about").onclick = () => {
  $("info").showModal();
  if (!$("licenses").textContent)
    fetch("NOTICE.txt")
      .then((r) => r.text())
      .then((text) => ($("licenses").textContent = text))
      .catch(
        () =>
          ($("licenses").textContent =
            "저장소의 LICENSE 및 android/THIRD_PARTY_NOTICES.txt를 참고하세요."),
      );
};
$("close-info").onclick = () => $("info").close();
$("ctrl").onclick = () => {
  ctrl = !ctrl;
  updateModifiers();
  current()?.term.focus();
};
$("alt").onclick = () => {
  alt = !alt;
  updateModifiers();
  current()?.term.focus();
};
for (const button of document.querySelectorAll("[data-key]")) {
  button.addEventListener("pointerdown", (e) => e.preventDefault());
  button.onclick = () => {
    if (active)
      invoke("input", active, JSON.parse('"' + button.dataset.key + '"'));
    current()?.term.focus();
  };
}
$("copy").onclick = () => {
  const text = current()?.term.getSelection();
  if (text) invoke("copy", text);
  else toast("터미널 텍스트를 먼저 선택하세요.");
};
$("paste").onclick = () => invoke("paste");
$("keyboard").onclick = () => {
  current()?.term.focus();
  invoke("keyboard");
};
document.addEventListener(
  "keydown",
  (event) => {
    if (
      $("editor").open ||
      $("info").open ||
      $("files").open ||
      event.target instanceof HTMLInputElement ||
      !event.ctrlKey
    )
      return;
    let handled = true;
    if (event.shiftKey && event.key.toLowerCase() === "t") openEditor();
    else if (event.shiftKey && event.key.toLowerCase() === "l") toggleSidebar();
    else if (event.shiftKey && event.key.toLowerCase() === "w") {
      if (active) closeSession(active);
    } else if (event.shiftKey && event.key.toLowerCase() === "c")
      $("copy").click();
    else if (event.shiftKey && event.key.toLowerCase() === "v")
      $("paste").click();
    else if (event.key === "Tab") {
      const ids = [...sessions.keys()];
      if (ids.length)
        select(
          ids[
            (ids.indexOf(active) + (event.shiftKey ? ids.length - 1 : 1)) %
              ids.length
          ],
        );
    } else if (["+", "=", "-"].includes(event.key)) {
      fontSize = Math.max(
        10,
        Math.min(28, fontSize + (event.key === "-" ? -1 : 1)),
      );
      for (const s of sessions.values()) s.term.options.fontSize = fontSize;
      fit(current());
    } else handled = false;
    if (handled) event.preventDefault();
  },
  true,
);
new ResizeObserver(() => requestAnimationFrame(() => fit(current()))).observe(
  $("terminals"),
);
window.visualViewport?.addEventListener("resize", () => fit(current()));
renderProfiles();
if (native) native.ready();

function showFiles(data) {
  $("remote-directory").value = data.path;
  $("file-list").replaceChildren();
  for (const entry of data.entries.sort(
    (a, b) =>
      Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name),
  )) {
    const button = document.createElement("button");
    button.textContent = `${entry.directory ? "▸" : "·"} ${entry.name}${entry.directory ? "/" : "  (" + entry.size + " B)"}`;
    button.onclick = () => {
      const path = data.path.replace(/\/$/, "") + "/" + entry.name;
      if (entry.directory) {
        $("transfer-status").textContent = "폴더 여는 중…";
        invoke("list", filesSession, path);
      } else $("remote-file").value = path;
    };
    $("file-list").append(button);
  }
  $("transfer-status").textContent =
    `${data.entries.length}개 항목 (최대 2,000개 표시)`;
}
$("sftp").onclick = () => {
  if (current()?.state !== "connected") {
    toast("SSH 서버에 먼저 연결하세요.");
    return;
  }
  filesSession = active;
  $("files").showModal();
  $("remote-directory").value = ".";
  $("remote-file").value = "";
  $("file-list").replaceChildren();
  $("transfer-status").textContent = "폴더 여는 중…";
  invoke("list", filesSession, ".");
};
$("close-files").onclick = () => $("files").close();
$("list-files").onclick = () => {
  $("transfer-status").textContent = "폴더 여는 중…";
  invoke("list", filesSession, $("remote-directory").value);
};
$("upload").onclick = () => {
  const path = $("remote-file").value.trim();
  if (!path || path.endsWith("/")) {
    toast("원격 파일의 전체 경로를 입력하세요.");
    return;
  }
  if (
    confirm(
      `${path}에 업로드합니다. 기존 파일이 있으면 덮어씁니다. 계속할까요?`,
    )
  )
    invoke("transfer", filesSession, path, true);
};
$("download").onclick = () =>
  invoke("transfer", filesSession, $("remote-file").value.trim(), false);
