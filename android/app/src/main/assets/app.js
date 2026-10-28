"use strict";
const $ = (id) => document.getElementById(id);
const native = window.Android;
const sessions = new Map();
let profiles = [],
  active = null,
  editing = null,
  privateKey = "",
  ctrl = false,
  alt = false;
let toastTimer,
  filesSession = null;
let gitStatus = null,
  gitKey = "",
  gitDirty = false;
// Desktop settings that apply to the Android terminal; window, backup, lock and
// connection options are desktop-only.
const DEFAULT_SETTINGS = {
  theme: "dark",
  terminalTheme: "BrightTerm Dark",
  fontFamily: "D2Coding ligature",
  fontSize: 14,
  lineHeight: 1.15,
  cursorStyle: "block",
  cursorBlink: true,
  scrollback: 10000,
  copyOnSelect: true,
  confirmMultilinePaste: true,
  shiftEnterNewline: true,
  osc52Clipboard: true,
};
const FONT_STACKS = {
  "D2Coding ligature": "'D2Coding ligature', 'D2Coding', monospace",
  D2Coding: "'D2Coding', monospace",
  monospace: "monospace",
};
const MIN_FONT_SIZE = 8,
  MAX_FONT_SIZE = 28;
const clamp = (value, min, max, fallback) =>
  Number.isFinite(+value) ? Math.max(min, Math.min(max, +value)) : fallback;
function normalizeSettings(value) {
  const s = { ...DEFAULT_SETTINGS, ...value };
  if (!Object.hasOwn(TERMINAL_THEMES, s.terminalTheme))
    s.terminalTheme = DEFAULT_SETTINGS.terminalTheme;
  if (!Object.hasOwn(FONT_STACKS, s.fontFamily))
    s.fontFamily = DEFAULT_SETTINGS.fontFamily;
  if (!["dark", "light", "system"].includes(s.theme))
    s.theme = DEFAULT_SETTINGS.theme;
  if (!["block", "bar", "underline"].includes(s.cursorStyle))
    s.cursorStyle = DEFAULT_SETTINGS.cursorStyle;
  s.fontSize = Math.round(clamp(s.fontSize, MIN_FONT_SIZE, MAX_FONT_SIZE, 14));
  s.lineHeight = clamp(s.lineHeight, 1, 2, 1.15);
  s.scrollback = Math.round(clamp(s.scrollback, 500, 100000, 10000));
  for (const key of Object.keys(DEFAULT_SETTINGS))
    if (typeof DEFAULT_SETTINGS[key] === "boolean") s[key] = !!s[key];
  return s;
}
let settings = DEFAULT_SETTINGS;
try {
  settings = normalizeSettings(native ? JSON.parse(native.settings()) : {});
} catch (_) {
  settings = normalizeSettings({});
}
let settingsTimer;
function saveSettings() {
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(
    () => invoke("saveSettings", JSON.stringify(settings)),
    300,
  );
}
function terminalOptions() {
  return {
    fontSize: settings.fontSize,
    fontFamily: FONT_STACKS[settings.fontFamily],
    lineHeight: settings.lineHeight,
    cursorStyle: settings.cursorStyle,
    cursorBlink: settings.cursorBlink,
    scrollback: settings.scrollback,
    theme: TERMINAL_THEMES[settings.terminalTheme],
  };
}
// Measure cells only after the bundled font is ready, or xterm keeps fallback metrics.
function loadFont() {
  if (settings.fontFamily === "monospace" || !document.fonts)
    return Promise.resolve();
  const family = `"${settings.fontFamily}"`;
  return Promise.all([
    document.fonts.load(`${settings.fontSize}px ${family}`),
    document.fonts.load(`bold ${settings.fontSize}px ${family}`),
  ]).catch(() => {});
}
let systemNight = native ? native.nightMode() : true;
function applyAppTheme() {
  const light =
    settings.theme === "light" || (settings.theme === "system" && !systemNight);
  document.documentElement.dataset.theme = light ? "light" : "dark";
  invoke("setAppearance", light);
}
let applying = 0;
function updateSettings(patch) {
  // Like the desktop, switching the app theme flips the default terminal theme with it.
  if (patch.theme && patch.theme !== settings.theme && !patch.terminalTheme) {
    const light =
      patch.theme === "light" || (patch.theme === "system" && !systemNight);
    if (light && settings.terminalTheme === "BrightTerm Dark")
      patch = { ...patch, terminalTheme: "BrightTerm Light" };
    else if (!light && settings.terminalTheme === "BrightTerm Light")
      patch = { ...patch, terminalTheme: "BrightTerm Dark" };
  }
  settings = normalizeSettings({ ...settings, ...patch });
  saveSettings();
  applyAppTheme();
  const run = ++applying;
  loadFont().then(() => {
    if (run !== applying) return;
    const options = terminalOptions();
    for (const s of sessions.values()) {
      Object.assign(s.term.options, options);
      s.pane.style.background = options.theme.background;
    }
    fit(current());
  });
}
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
let fontFrame = 0;
function setFontSize(value) {
  const size = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, Math.round(value)));
  if (settings.fontSize === size) return;
  settings = { ...settings, fontSize: size };
  saveSettings();
  if ($("settings-dialog").open) $("settings-form").elements.fontSize.value = size;
  for (const s of sessions.values()) s.term.options.fontSize = size;
  if (!fontFrame) fontFrame = requestAnimationFrame(() => {
    fontFrame = 0;
    fit(current());
  });
}
function enablePinch(pane) {
  let gesture = null, suppress = false;
  const distance = (touches) => Math.hypot(
    touches[0].clientX - touches[1].clientX,
    touches[0].clientY - touches[1].clientY,
  );
  const handle = (event) => {
    if (event.touches.length >= 2) {
      suppress = true;
      if (!gesture) gesture = { distance: Math.max(1, distance(event.touches)), size: settings.fontSize };
      if (event.type === "touchmove") setFontSize(gesture.size * distance(event.touches) / gesture.distance);
    }
    if (suppress) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!event.touches.length) { gesture = null; suppress = false; }
    }
  };
  for (const type of ["touchstart", "touchmove", "touchend", "touchcancel"])
    pane.addEventListener(type, handle, { capture: true, passive: false });
}
function select(id) {
  active = id;
  for (const s of sessions.values()) {
    s.pane.hidden = s.id !== id;
    s.tab.classList.toggle("active", s.id === id);
  }
  const s = current();
  updateSftpButton();
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
  const term = new Terminal({ ...terminalOptions(), allowProposedApi: false });
  pane.style.background = TERMINAL_THEMES[settings.terminalTheme].background;
  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  enablePinch(pane);
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
  const label = document.createTextNode(name);
  choose.append(dot, label);
  choose.onclick = () => select(id);
  choose.setAttribute("aria-label", `${name} — 길게 눌러 메뉴`);
  tab.append(choose);
  enableTabMenu(tab, id);
  $("tabs").append(tab);
  // 끊기면 터미널 위에 띄우는 재접속 버튼
  const again = document.createElement("button");
  again.className = "reconnect primary";
  again.textContent = "재접속";
  again.hidden = true;
  again.onclick = () => reconnect(id);
  pane.append(again);
  const session = {
    id,
    name,
    term,
    fit: fitAddon,
    pane,
    tab,
    label,
    again,
    state: "connecting",
  };
  sessions.set(id, session);
  term.onData((data) => {
    if (session.state === "disconnected") {
      if (data === "\r") reconnect(id);
      return;
    }
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
    if (
      settings.shiftEnterNewline &&
      event.key === "Enter" &&
      event.shiftKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.metaKey &&
      !event.isComposing
    ) {
      // Ctrl+J: newline in Claude Code/Codex CLI, Enter in ordinary shells.
      event.preventDefault();
      if (event.type === "keydown") invoke("input", id, "\n");
      return false;
    }
    const appShortcut =
      event.ctrlKey &&
      (event.shiftKey || ["Tab", "+", "=", "-", ","].includes(event.key));
    return !appShortcut;
  });
  let copyTimer;
  term.onSelectionChange(() => {
    if (!settings.copyOnSelect) return;
    clearTimeout(copyTimer);
    // Copy once the selection settles instead of on every drag step.
    copyTimer = setTimeout(() => {
      if (term.hasSelection()) invoke("copy", term.getSelection());
    }, 400);
  });
  // OSC 52 ; Pc ; Pd — Pd is base64 text to copy. Reading the clipboard ('?') is never answered.
  term.parser.registerOscHandler(52, (data) => {
    if (!settings.osc52Clipboard) return true;
    const payload = data.slice(data.indexOf(";") + 1);
    if (data.includes(";") && payload && payload !== "?") {
      try {
        const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
        invoke("copy", new TextDecoder().decode(bytes));
      } catch (_) {
        /* Invalid base64. */
      }
    }
    return true;
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
  $("form").elements.persist.checked = profile?.persist ?? false;
  $("form").elements.persistName.value = profile?.persistName ?? "";
  $("form").elements.persistMouse.checked = profile?.persistMouse ?? true;
  const keys = { ...TERMINAL.defaultKeys, ...profile?.keys };
  $("form").elements.encoding.value = profile?.encoding || "utf-8";
  $("form").elements.termType.value = profile?.termType || "xterm-256color";
  for (const key of KEY_FIELDS) $("form").elements[keyField(key)].value = keys[key];
  terminalChosen = profile?.terminalPreset || "";
  updateTerminalPreset();
  $("terminal-settings").open = !!matchingPreset() && matchingPreset().id !== "linux";
  updateTmuxOptions();
  $("tmux-settings").open = !!profile?.persist;
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
    persist: fields.persist.checked,
    persistName: fields.persistName.value.trim(),
    persistMouse: fields.persistMouse.checked,
    termType: fields.termType.value.trim() || "xterm-256color",
    encoding: fields.encoding.value,
    keys: Object.fromEntries(KEY_FIELDS.map((key) => [key, fields[keyField(key)].value])),
    ...(matchingPreset() ? { terminalPreset: matchingPreset().id } : {}),
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
    case "git-sync":
      gitStatus = JSON.parse(event.value);
      renderGitStatus();
      break;
    case "night":
      systemNight = event.value === "true";
      if (settings.theme === "system") applyAppTheme();
      break;
    case "git-key":
      gitKey = event.value;
      $("git-key-state").textContent = " 개인키 선택됨";
      break;
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
        const was = s.state;
        s.state = event.value;
        if (s.state === "connected") fit(s);
        s.tab.dataset.state = event.value;
        s.again.hidden = s.state !== "disconnected";
        if (s.state === "disconnected" && was !== "disconnected")
          s.term.write(
            "\r\n\x1b[33m● 연결이 끊어졌습니다 — 재접속이 필요합니다. [재접속] 버튼이나 Enter 를 누르세요.\x1b[0m\r\n",
          );
        if (active === s.id)
          $("status").textContent = `${s.name} · ${s.state} · SSH`;
      }
      break;
    case "sftp":
      if (s) {
        s.sftp = event.value;
        updateSftpButton();
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
      if (current()) pasteText(current(), event.value);
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
function pasteText(session, text) {
  const lines = text.split(/\r\n|\r|\n/).filter((line) => line.length);
  if (
    settings.confirmMultilinePaste &&
    lines.length > 1 &&
    !session.term.modes.bracketedPasteMode &&
    !confirm(
      `${lines.length}줄을 ${session.name}에 붙여넣습니다. 각 줄이 명령으로 실행될 수 있습니다.`,
    )
  )
    return session.term.focus();
  session.term.paste(text);
  session.term.focus();
}
window.androidBack = () => {
  if ($("settings-dialog").open) $("settings-dialog").close();
  else if ($("git-dialog").open) $("git-dialog").close();
  else if ($("files").open) $("files").close();
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
      $("git-dialog").open ||
      $("settings-dialog").open ||
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
      setFontSize(settings.fontSize + (event.key === "-" ? -1 : 1));
    } else if (event.key === ",") openSettings();
    else handled = false;
    if (handled) event.preventDefault();
  },
  true,
);
new ResizeObserver(() => requestAnimationFrame(() => fit(current()))).observe(
  $("terminals"),
);
window.visualViewport?.addEventListener("resize", () => fit(current()));
renderProfiles();
applyAppTheme();
loadFont().then(() => native?.ready());

function renderThemes() {
  $("theme-list").replaceChildren();
  for (const [name, t] of Object.entries(TERMINAL_THEMES)) {
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("role", "radio");
    button.setAttribute("aria-checked", String(settings.terminalTheme === name));
    Object.assign(button.style, {
      background: t.background,
      color: t.foreground,
      fontFamily: FONT_STACKS[settings.fontFamily],
    });
    const sample = (color, text) => {
      const span = document.createElement("span");
      span.style.color = color;
      span.textContent = text;
      return span;
    };
    button.append(
      name,
      document.createElement("br"),
      sample(t.green, "user@host"),
      ":",
      sample(t.blue, "~"),
      "$ ",
      sample(t.yellow, "ls"),
      " ",
      sample(t.red, "err"),
    );
    button.onclick = () => {
      updateSettings({ terminalTheme: name });
      renderThemes();
    };
    $("theme-list").append(button);
  }
}
function fillSettings() {
  const f = $("settings-form").elements;
  for (const [key, value] of Object.entries(settings)) {
    if (!f[key]) continue;
    if (typeof value === "boolean") f[key].checked = value;
    else f[key].value = value;
  }
  renderThemes();
}
function openSettings() {
  fillSettings();
  $("settings-dialog").showModal();
}
for (const id of ["settings", "open-settings"]) $(id).onclick = openSettings;
$("close-settings").onclick = () => $("settings-dialog").close();
$("settings-dialog").addEventListener("close", () => current()?.term.focus());
$("settings-form").onsubmit = (event) => event.preventDefault();
$("settings-form").addEventListener("change", (event) => {
  const field = event.target;
  if (!field.name || !Object.hasOwn(DEFAULT_SETTINGS, field.name)) return;
  const value =
    field.type === "checkbox"
      ? field.checked
      : field.type === "number"
        ? +field.value
        : field.value;
  updateSettings({ [field.name]: value });
  fillSettings();
});
$("reset-settings").onclick = () => {
  updateSettings(DEFAULT_SETTINGS);
  fillSettings();
};
$("settings-git").onclick = () => {
  $("settings-dialog").close();
  $("git-settings").click();
};
$("settings-about").onclick = () => {
  $("settings-dialog").close();
  $("about").click();
};

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
        $("transfer-status").textContent =
    current().sftp === "shell"
      ? "SFTP가 없어 SSH 명령으로 엽니다… (큰 파일은 느릴 수 있음)"
      : "폴더 여는 중…";
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
  if (current().sftp === "unavailable") {
    toast("이 서버는 파일을 주고받을 수 없습니다 (SFTP·명령 채널 모두 막힘).");
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

function fillGitSettings() {
  if (!gitStatus?.config || gitDirty) return;
  const c = gitStatus.config;
  $("git-enabled").checked = c.enabled;
  $("git-remote").value = c.remote || "";
  $("git-branch").value = c.branch || "main";
  $("git-user").value = c.username || "git";
  $("git-key-state").textContent = c.hasKey ? " 저장된 개인키 사용" : "";
  $("git-token").placeholder = c.hasToken
    ? "저장된 인증 정보 사용 (빈칸은 유지)"
    : "토큰 또는 SSH 비밀번호";
}
function renderGitStatus() {
  if (!gitStatus) return;
  $("git-message").textContent = gitStatus.message;
  $("git-last").textContent = gitStatus.lastSync
    ? "마지막 동기화: " + new Date(gitStatus.lastSync).toLocaleString()
    : "";
  $("git-settings").textContent =
    "Git 동기화 · " +
    ({
      disabled: "꺼짐",
      idle: "대기",
      syncing: "진행 중",
      synced: "완료",
      conflict: "충돌",
      "password-required": "비밀번호 필요",
      error: "오류",
    }[gitStatus.state] || gitStatus.state);
  const busy = gitStatus.state === "syncing";
  for (const id of [
    "git-save",
    "git-now",
    "git-pull",
    "git-push",
    "git-restore",
  ])
    $(id).disabled = busy;
  $("git-restore").hidden = !gitStatus.hasBackup;
  const conflict = ["conflict", "password-required"].includes(gitStatus.state);
  $("git-pull").hidden = !conflict;
  $("git-push").hidden = !conflict;
  fillGitSettings();
}
$("git-settings").onclick = () => {
  gitDirty = false;
  gitKey = "";
  $("git-token").value = "";
  $("git-passphrase").value = "";
  $("git-master").value = "";
  $("git-clear").checked = false;
  fillGitSettings();
  $("git-dialog").showModal();
  invoke("syncStatus");
};
$("close-git").onclick = () => $("git-dialog").close();
$("git-dialog").addEventListener("close", () => {
  gitKey = "";
  $("git-master").value = "";
  $("git-token").value = "";
  $("git-passphrase").value = "";
});
$("git-form").addEventListener("input", () => (gitDirty = true));
$("git-import-key").onclick = () => {
  gitDirty = true;
  invoke("importSyncKey");
};
$("git-form").onsubmit = (event) => {
  event.preventDefault();
  const config = {
    enabled: $("git-enabled").checked,
    remote: $("git-remote").value.trim(),
    branch: $("git-branch").value.trim() || "main",
    username: $("git-user").value.trim(),
    token: $("git-token").value,
    privateKey: gitKey,
    passphrase: $("git-passphrase").value,
    clearCredentials: $("git-clear").checked,
  };
  gitDirty = false;
  invoke("configureSync", JSON.stringify(config));
  gitKey = "";
  $("git-token").value = "";
  $("git-passphrase").value = "";
  $("git-clear").checked = false;
};
function synchronize(choice) {
  if (gitDirty) {
    toast("수정한 Git 설정을 먼저 저장하세요.");
    return;
  }
  if (
    choice === "remote" &&
    !confirm(
      "원격 데이터로 이 기기의 서버 목록을 교체할까요? 현재 데이터는 암호화해 백업합니다.",
    )
  )
    return;
  if (
    choice === "local" &&
    !confirm(
      "로컬 데이터로 원격 동기화 파일을 교체할까요? 기존 원격 버전은 Git 기록에 남습니다.",
    )
  )
    return;
  const password = $("git-master").value;
  $("git-master").value = "";
  invoke("sync", choice, password);
}
$("git-now").onclick = () => synchronize("");
$("git-pull").onclick = () => synchronize("remote");
$("git-push").onclick = () => synchronize("local");

$("git-restore").onclick = () => {
  if (
    confirm(
      "마지막 원격 가져오기 전의 로컬 데이터를 복원할까요? 현재 데이터도 백업하고, 자동 동기화는 끕니다.",
    )
  )
    invoke("restoreSyncBackup");
};

function updateTmuxOptions() {
  const f = $("form").elements;
  $("tmux-options").hidden = !f.persist.checked;
  const slug = (text) =>
    text
      .normalize("NFKD")
      .replace(/[^A-Za-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);
  const custom = f.persistName.value.trim(),
    base = slug(custom) || slug(f.name.value) || "terminal";
  $("tmux-preview").textContent = "세션: " + (custom ? base : "bt-" + base);
}
$("tmux-enabled").onchange = updateTmuxOptions;
$("form").elements.persistName.addEventListener("input", updateTmuxOptions);
$("form").elements.name.addEventListener("input", updateTmuxOptions);

// 서버 종류 템플릿 — 데스크톱 서버 편집의 "터미널" 탭과 같은 값 (terminal.js)
const KEY_FIELDS = ["backspace", "delete", "homeEnd", "enter"];
// form.elements.delete 는 삭제 버튼과 겹쳐 key 접두사를 붙인다
const keyField = (key) => "key" + key[0].toUpperCase() + key.slice(1);
let terminalChosen = "";
function matchingPreset() {
  const f = $("form").elements;
  const same = (p) =>
    p.termType === f.termType.value.trim() &&
    (!p.encoding || p.encoding === f.encoding.value) &&
    KEY_FIELDS.every((key) => p.keys[key] === f[keyField(key)].value);
  const chosen = TERMINAL.presets.find((p) => p.id === terminalChosen);
  return chosen && same(chosen) ? chosen : TERMINAL.presets.find(same);
}
function updateTerminalPreset() {
  const preset = matchingPreset();
  $("form").elements.terminalPreset.value = preset?.id || "";
  $("terminal-hint").textContent = preset
    ? preset.hint
    : "사용자 지정 — 값을 직접 바꿨습니다. 템플릿을 고르면 그 값으로 돌아갑니다.";
}
{
  const f = $("form").elements;
  f.terminalPreset.append(
    new Option("사용자 지정", ""),
    ...TERMINAL.presets.map((p) => new Option(p.label, p.id)),
  );
  f.encoding.append(...TERMINAL.encodings.map((e) => new Option(e.label, e.value)));
  $("term-types").append(
    ...["xterm-256color", "xterm", "vt100", "vt220", "ansi", "dtterm", "aixterm", "linux", "screen-256color"].map((t) => new Option(t)),
  );
  f.terminalPreset.addEventListener("change", () => {
    const preset = TERMINAL.presets.find((p) => p.id === f.terminalPreset.value);
    if (!preset) return updateTerminalPreset();
    terminalChosen = preset.id;
    f.termType.value = preset.termType;
    if (preset.encoding) f.encoding.value = preset.encoding;
    for (const key of KEY_FIELDS) f[keyField(key)].value = preset.keys[key];
    updateTerminalPreset();
  });
  for (const name of ["encoding", "termType", ...KEY_FIELDS.map(keyField)])
    f[name].addEventListener(name === "termType" ? "input" : "change", updateTerminalPreset);
}

// 탭 메뉴 — 길게 누르기·마우스 오른쪽 클릭. 데스크톱 탭·패널 메뉴 중 모바일에서 쓸 만한 것
function reconnect(id) {
  const s = sessions.get(id);
  if (!s || s.state !== "disconnected") return;
  s.again.hidden = true;
  s.term.write("\r\n\x1b[90m● 다시 접속 중...\x1b[0m\r\n");
  invoke("reconnect", id, s.term.cols || 80, s.term.rows || 24);
}
function enableTabMenu(tab, id) {
  let timer = 0, start = null;
  const cancel = () => { clearTimeout(timer); timer = 0; };
  tab.addEventListener("touchstart", (event) => {
    const t = event.touches[0];
    start = { x: t.clientX, y: t.clientY };
    cancel();
    timer = setTimeout(() => { timer = 0; openTabMenu(id, start.x, start.y); }, 500);
  }, { passive: true });
  tab.addEventListener("touchmove", (event) => {
    const t = event.touches[0];
    if (start && Math.hypot(t.clientX - start.x, t.clientY - start.y) > 10) cancel();
  }, { passive: true });
  tab.addEventListener("touchend", cancel);
  tab.addEventListener("touchcancel", cancel);
  // 마우스 오른쪽 클릭 (WebView 는 길게 누르기에도 contextmenu 를 보낸다)
  tab.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    cancel();
    openTabMenu(id, event.clientX, event.clientY);
  });
}
let tabMenuOpenedAt = 0;
function closeTabMenu() {
  $("tab-menu").hidden = true;
  $("tab-menu-backdrop").hidden = true;
}
function openTabMenu(id, x, y) {
  const s = sessions.get(id);
  if (!s) return;
  select(id);
  const others = [...sessions.keys()].filter((key) => key !== id);
  const cols = () => s.term.cols || 80, rows = () => s.term.rows || 24;
  const items = [
    { label: "다시 접속", disabled: s.state !== "disconnected", run: () => reconnect(id) },
    { label: "같은 서버 새 탭", run: () => invoke("duplicate", id, cols(), rows()) },
    { label: "SFTP 파일", disabled: s.state !== "connected" || s.sftp === "unavailable", run: () => $("sftp").click() },
    null,
    { label: "붙여넣기", disabled: s.state !== "connected", run: () => invoke("paste") },
    { label: "화면 지우기", run: () => s.term.clear() },
    { label: "탭 이름 바꾸기", run: () => {
      const name = window.prompt("탭 이름", s.name);
      if (name === null || !name.trim()) return;
      s.name = name.trim();
      s.label.textContent = s.name;
      s.tab.querySelector(".select").title = s.name;
      select(id);
    } },
    null,
    { label: "다른 탭 모두 닫기", disabled: !others.length, run: () => {
      if (!window.confirm(`다른 탭 ${others.length}개를 닫을까요?`)) return;
      for (const key of others) {
        const o = sessions.get(key);
        if (o) o.state = "disconnected"; // 한 번에 확인했으니 탭마다 묻지 않는다
        closeSession(key);
      }
    } },
    { label: "탭 닫기", danger: true, run: () => closeSession(id) },
  ];
  const menu = $("tab-menu");
  menu.replaceChildren(
    ...items.map((item) => {
      if (!item) return Object.assign(document.createElement("hr"), {});
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = item.label;
      button.disabled = !!item.disabled;
      if (item.danger) button.className = "danger";
      button.onclick = () => { closeTabMenu(); item.run(); };
      return button;
    }),
  );
  tabMenuOpenedAt = Date.now();
  $("tab-menu-backdrop").hidden = false;
  menu.hidden = false;
  const box = menu.getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(x, innerWidth - box.width - 8)) + "px";
  menu.style.top = Math.max(8, Math.min(y, innerHeight - box.height - 8)) + "px";
}
// 길게 누른 손가락을 뗄 때 오는 click 으로 바로 닫히지 않게
$("tab-menu-backdrop").addEventListener("click", () => {
  if (Date.now() - tabMenuOpenedAt > 400) closeTabMenu();
});
$("tab-menu-backdrop").addEventListener("contextmenu", (event) => {
  event.preventDefault();
  closeTabMenu();
});

// 지금 세션이 SFTP 를 못 쓰면 파일 버튼을 흐리게 (누르면 이유를 알린다)
function updateSftpButton() {
  const unavailable = current()?.sftp === "unavailable";
  $("sftp").classList.toggle("unavailable", unavailable);
  $("sftp").title = unavailable
    ? "이 서버는 파일을 주고받을 수 없습니다 (SFTP·명령 채널 모두 막힘)"
    : current()?.sftp === "shell"
      ? "SFTP 없이 SSH 명령(cat·ls)으로 파일 전송"
      : "SFTP 파일 전송";
}
