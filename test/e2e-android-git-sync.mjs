// Isolated emulator only. Installs no personal credentials and clears this app's emulator data.
// ANDROID_SERIAL=emulator-5554 npm run test:android:git-sync
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  randomBytes,
  scryptSync,
  createCipheriv,
  createDecipheriv,
  generateKeyPairSync,
} from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ssh2 from "ssh2";
const serial = process.env.ANDROID_SERIAL;
assert(
  serial?.startsWith("emulator-"),
  "ANDROID_SERIAL must select an isolated emulator; app data is cleared.",
);
const adbBin =
  process.env.ADB ||
  `${process.env.ANDROID_HOME || `${process.env.HOME}/Library/Android/sdk`}/platform-tools/adb`;
const adb = (...args) =>
  execFileSync(adbBin, ["-s", serial, ...args], { encoding: "utf8" }).trim();
const pkg = "kr.balkeunter.brightterm",
  root = mkdtempSync(join(tmpdir(), "bt-android-sync-")),
  bare = join(root, "vault.git"),
  seed = join(root, "seed");
const git = (...args) =>
  execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hostKey = generateKeyPairSync("rsa", {
  modulusLength: 2048,
}).privateKey.export({ type: "pkcs1", format: "pem" });
const identity = generateKeyPairSync("rsa", {
  modulusLength: 2048,
}).privateKey.export({ type: "pkcs1", format: "pem" });
const parsedKey = ssh2.utils.parseKey(identity);
const clients = new Set();
let server,
  port,
  socket,
  sequence = 0,
  raceOnReceive = null;
const pending = new Map();
const password = "Desktop-sync-vault-2026",
  gitToken = "ephemeral-git-password";
const key = randomBytes(32),
  kdf = {
    alg: "scrypt",
    N: 131072,
    r: 8,
    p: 1,
    salt: randomBytes(16).toString("base64"),
  };
const derive = (pw, k) =>
  scryptSync(pw.normalize("NFKC"), Buffer.from(k.salt, "base64"), 32, {
    N: k.N,
    r: k.r,
    p: k.p,
    maxmem: 512 * 1024 * 1024,
  });
function seal(key, plain, aad) {
  const iv = randomBytes(12),
    c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return {
    iv: iv.toString("base64"),
    ct: ct.toString("base64"),
    tag: c.getAuthTag().toString("base64"),
  };
}
function open(key, e, aad) {
  const c = createDecipheriv("aes-256-gcm", key, Buffer.from(e.iv, "base64"));
  c.setAAD(Buffer.from(aad));
  c.setAuthTag(Buffer.from(e.tag, "base64"));
  return Buffer.concat([c.update(Buffer.from(e.ct, "base64")), c.final()]);
}
const originalSecret = {
  username: "desktop-user",
  password: "desktop-server-secret",
  privateKey: identity,
  passphrase: "",
};
const credential = {
  id: "shared-credential",
  name: "Shared account",
  kind: "key",
  username: "desktop-user",
  updatedAt: 1,
  ...seal(
    key,
    Buffer.from(JSON.stringify(originalSecret)),
    "shared-credential",
  ),
};
const host = (id, alias) => ({
  id,
  groupId: "folder",
  alias,
  protocol: "ssh",
  host: "example.invalid",
  port: 22,
  username: "desktop-user",
  authType: "key",
  credentialId: credential.id,
  tags: ["prod"],
  encoding: "utf-8",
  termType: "xterm-256color",
  keepaliveSec: 30,
  forwards: [],
  sort: 0,
  notes: "Preserve desktop metadata",
});
const desktop = {
  version: 1,
  groups: [{ id: "folder", name: "Desktop folder", parentId: null, sort: 0 }],
  hosts: [
    {
      ...host("ssh-main", "Desktop server"),
      persist: true,
      persistName: "desktop-work",
      persistMouse: false,
    },
    host("ssh-shared", "Shared server"),
    { ...host("unsupported", "Jump server"), jumpHostId: "ssh-main" },
    {
      ...host("local-host", "Local workstation"),
      protocol: "local",
      port: 0,
      local: { cwd: "/keep/this/path" },
      authType: "ask",
    },
  ],
  vault: {
    version: 1,
    kdf,
    wrapped: seal(derive(password, kdf), key, "vault-key"),
    items: [credential],
  },
};
function envelope(snapshot, cipherKey = key) {
  return {
    format: "brightterm-git-v1",
    kdf: snapshot.vault.kdf,
    wrapped: snapshot.vault.wrapped,
    payload: seal(
      cipherKey,
      Buffer.from(JSON.stringify(snapshot)),
      "brightterm-git-v1",
    ),
  };
}
function decode(raw, pw = password) {
  const e = JSON.parse(raw),
    k = open(derive(pw, e.kdf), e.wrapped, "vault-key");
  return {
    snapshot: JSON.parse(open(k, e.payload, "brightterm-git-v1")),
    key: k,
    envelope: e,
  };
}
function remoteRaw(branch = "main") {
  return git("--git-dir", bare, "show", `${branch}:brightterm.vault.json`);
}
function remoteSnapshot(branch = "main") {
  return decode(remoteRaw(branch)).snapshot;
}
function commitRemote(value, branch = "main") {
  git("-C", seed, "fetch", "origin", branch);
  git("-C", seed, "checkout", "-B", branch, `origin/${branch}`);
  writeFileSync(join(seed, "brightterm.vault.json"), JSON.stringify(value));
  git("-C", seed, "add", ".");
  git(
    "-C",
    seed,
    "-c",
    "user.name=Desktop Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "Desktop update",
  );
  git("-C", seed, "push", "origin", branch);
}
async function startServer() {
  server = new ssh2.Server({ hostKeys: [hostKey] }, (client) => {
    clients.add(client);
    client.on("close", () => clients.delete(client));
    client.on("error", () => {});
    client.on("authentication", (ctx) => {
      const passwordOK = ctx.method === "password" && ctx.password === gitToken;
      const keyOK =
        ctx.method === "publickey" &&
        ctx.key.data.equals(parsedKey.getPublicSSH()) &&
        (!ctx.signature ||
          parsedKey.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true);
      if (ctx.username === "git" && (passwordOK || keyOK)) ctx.accept();
      else ctx.reject(["publickey", "password"]);
    });
    client.on("ready", () =>
      client.on("session", (accept) =>
        accept().on("exec", (accept, reject, info) => {
          const match = info.command.match(
            /^(git-upload-pack|git-receive-pack) '(?:\/)?vault\.git'$/,
          );
          if (!match) {
            console.error("Unexpected Git exec", info.command);
            reject();
            return;
          }
          if (match[1] === "git-receive-pack" && raceOnReceive) {
            const race = raceOnReceive;
            raceOnReceive = null;
            race();
          }
          const channel = accept(),
            child = spawn("git", [match[1].slice(4), bare]);
          child.stdout.pipe(channel);
          child.stderr.pipe(channel.stderr);
          channel.pipe(child.stdin);
          child.stdin.on("error", () => {});
          channel.on("close", () => child.kill());
          child.on("exit", (code) => {
            channel.exit(code ?? 1);
            channel.end();
          });
        }),
      ),
    );
  });
  await new Promise((resolve) =>
    server.listen(port || 0, "127.0.0.1", resolve),
  );
  port = server.address().port;
}
function command(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP timeout: ${method}`));
    }, 15000);
    pending.set(id, {
      resolve: (r) => {
        clearTimeout(timeout);
        resolve(r);
      },
      reject,
    });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await command("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails)
    throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result?.value;
}
async function until(check, message, timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await pause(150);
  }
  throw new Error(`${message}: ${JSON.stringify(await evaluate("gitStatus"))}`);
}
async function status(expected) {
  await until(
    () => evaluate(`gitStatus?.state===${JSON.stringify(expected)}`),
    `Expected ${expected}`,
  );
}
async function launch(clear = false) {
  socket?.close();
  adb("shell", "am", "force-stop", pkg);
  if (clear) adb("shell", "pm", "clear", pkg);
  adb("shell", "am", "start", "-n", `${pkg}/.MainActivity`);
  await pause(1000);
  const pid = adb("shell", "pidof", pkg).split(" ")[0];
  adb("forward", "tcp:9224", `localabstract:webview_devtools_remote_${pid}`);
  const targets = await (await fetch("http://127.0.0.1:9224/json")).json();
  const target = targets.find((t) =>
    t.url.includes("appassets.androidplatform.net"),
  );
  assert(target);
  socket = new WebSocket(target.webSocketDebuggerUrl);
  socket.onmessage = (e) => {
    const r = JSON.parse(e.data);
    const p = pending.get(r.id);
    if (p) {
      pending.delete(r.id);
      r.error
        ? p.reject(new Error(JSON.stringify(r.error)))
        : p.resolve(r.result);
    }
  };
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  await until(
    () => evaluate('!!window.nativeEvent && !!$("git-settings")'),
    "App did not load",
  );
}
async function trust() {
  await until(async () => {
    try {
      adb("shell", "uiautomator", "dump", "/sdcard/bt-sync-test.xml");
    } catch (error) {
      if (!error.stdout?.includes("UI hierchary dumped")) return false;
    }
    const xml = adb("shell", "cat", "/sdcard/bt-sync-test.xml");
    const m = xml.match(
      /<node[^>]*text="신뢰하고 연결"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/,
    );
    if (!m) return false;
    adb(
      "shell",
      "input",
      "tap",
      String(((+m[1] + +m[3]) / 2) | 0),
      String(((+m[2] + +m[4]) / 2) | 0),
    );
    return true;
  }, "SSH trust dialog missing");
}
const config = () => ({
  enabled: true,
  remote: `ssh://git@127.0.0.1:${port}/vault.git`,
  branch: "main",
  username: "git",
  token: gitToken,
});
async function configure(c) {
  await evaluate(`Android.configureSync(${JSON.stringify(JSON.stringify(c))})`);
}
async function sync(choice = "", pw = "") {
  await evaluate(
    `Android.sync(${JSON.stringify(choice)},${JSON.stringify(pw)})`,
  );
}
async function saveProfile(p) {
  await evaluate(`Android.save(${JSON.stringify(JSON.stringify(p))})`);
}
try {
  git("init", "--bare", bare);
  mkdirSync(seed);
  git("-C", seed, "init", "-b", "main");
  git("-C", seed, "remote", "add", "origin", bare);
  mkdirSync(join(seed, "unrelated"));
  writeFileSync(join(seed, "unrelated", "keep.txt"), "Preserve me");
  writeFileSync(
    join(seed, "brightterm.vault.json"),
    JSON.stringify(envelope(desktop)),
  );
  git("-C", seed, "add", ".");
  git(
    "-C",
    seed,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "Seed desktop vault",
  );
  git("-C", seed, "push", "origin", "main");
  await startServer();
  adb("reverse", `tcp:${port}`, `tcp:${port}`);
  await launch(true);
  await until(
    () =>
      evaluate(
        "gitStatus?.config?.remote==='https://github.com/dearmai/bright-term-vault.git'",
      ),
    "Deployment Git URL was not prefilled",
  );
  assert.equal(await evaluate("gitStatus.config.enabled"), false);
  assert.equal(await evaluate("gitStatus.config.username"), "dearmai");
  const deploymentConfig = join(root, "deploy.json");
  const deploymentToken = "ephemeral-provision-only-token";
  writeFileSync(
    deploymentConfig,
    JSON.stringify({
      remote: "https://example.invalid/vault.git",
      branch: "main",
      username: "deploy-user",
      accessToken: deploymentToken,
      enabled: false,
    }),
    { mode: 0o600 },
  );
  const requestId = execFileSync(
    process.execPath,
    [
      "scripts/android-provision.mjs",
      "prepare",
      adbBin,
      serial,
      deploymentConfig,
    ],
    { encoding: "utf8" },
  ).trim();
  assert.match(requestId, /^[a-f0-9-]{36}$/);
  await launch();
  const registration = execFileSync(
    process.execPath,
    ["scripts/android-provision.mjs", "confirm", adbBin, serial, requestId],
    { encoding: "utf8" },
  );
  assert(!registration.includes(deploymentToken));
  await until(
    () =>
      evaluate(
        "gitStatus?.config?.username==='deploy-user' && gitStatus?.config?.hasToken",
      ),
    "Deployment credentials not registered",
  );
  assert(
    !adb("shell", "run-as", pkg, "ls", "files").includes("deploy-pending.json"),
  );
  const registeredBytes = execFileSync(adbBin, [
    "-s",
    serial,
    "shell",
    "run-as",
    pkg,
    "cat",
    "files/profiles.enc",
  ]);
  assert(!registeredBytes.includes(Buffer.from(deploymentToken)));
  await launch();
  await until(
    () =>
      evaluate(
        "gitStatus?.config?.username==='deploy-user' && gitStatus?.config?.hasToken",
      ),
    "Deployment credentials did not survive restart",
  );
  await evaluate("$('git-settings').click()");
  assert.equal(await evaluate("$('git-dialog').open"), true);
  await configure({
    ...config(),
    remote: "https://embedded-secret@example.invalid/vault.git",
  });
  await status("error");
  assert(
    !(await evaluate("JSON.stringify(gitStatus)")).includes("embedded-secret"),
  );
  await evaluate(
    `$('git-enabled').checked=true; $('git-remote').value=${JSON.stringify(config().remote)}; $('git-user').value='git'; $('git-token').value=${JSON.stringify(gitToken)}; $('git-form').dispatchEvent(new Event('input',{bubbles:true})); $('git-form').requestSubmit()`,
  );
  await trust();
  await status("conflict");
  await sync("remote", "wrong-password");
  await status("password-required");
  assert.equal(await evaluate("profiles.length"), 0);
  await sync("remote", password);
  await status("synced");
  await until(
    () => evaluate("profiles.some(p=>p.id==='ssh-main')"),
    "Imported profiles missing",
  );
  assert.equal(await evaluate("profiles.length"), 3);
  assert(await evaluate("profiles.find(p=>p.id==='ssh-main').persist"));
  assert.equal(
    await evaluate("profiles.find(p=>p.id==='ssh-main').persistName"),
    "desktop-work",
  );
  assert.equal(
    await evaluate("profiles.find(p=>p.id==='ssh-main').persistMouse"),
    false,
  );
  assert(await evaluate("profiles.find(p=>p.id==='unsupported').unsupported"));
  assert(!(await evaluate("JSON.stringify(gitStatus)")).includes(gitToken));
  assert(
    !(await evaluate("JSON.stringify(profiles)")).includes(
      "desktop-server-secret",
    ),
  );
  await saveProfile({
    id: "ssh-main",
    name: "Android renamed",
    host: "example.invalid",
    port: 22,
    username: "desktop-user",
    password: "android-updated-password",
    command: "",
  });
  await until(() => {
    try {
      return (
        remoteSnapshot().hosts.find((h) => h.id === "ssh-main").alias ===
        "Android renamed"
      );
    } catch {
      return false;
    }
  }, "Automatic Android push failed");
  await status("synced");
  let snapshot = remoteSnapshot();
  assert.deepEqual(snapshot.groups, desktop.groups);
  assert.deepEqual(
    snapshot.hosts.find((h) => h.id === "local-host"),
    desktop.hosts.find((h) => h.id === "local-host"),
  );
  assert.deepEqual(
    snapshot.hosts.find((h) => h.id === "unsupported"),
    desktop.hosts.find((h) => h.id === "unsupported"),
  );
  const shared = snapshot.hosts.find((h) => h.id === "ssh-shared");
  assert.equal(shared.credentialId, credential.id);
  const changed = snapshot.hosts.find((h) => h.id === "ssh-main");
  assert.notEqual(changed.credentialId, credential.id);
  assert.equal(
    JSON.parse(
      open(
        key,
        snapshot.vault.items.find((i) => i.id === changed.credentialId),
        changed.credentialId,
      ),
    ).password,
    "android-updated-password",
  );
  assert.equal(
    git("--git-dir", bare, "show", "main:unrelated/keep.txt"),
    "Preserve me",
  );
  assert(
    !remoteRaw().includes("android-updated-password") &&
      !remoteRaw().includes("example.invalid"),
  );
  // Desktop writer changes the encrypted snapshot; Android imports with its device-cached vault key.
  snapshot.hosts.find((h) => h.id === "ssh-main").alias = "Desktop updated";
  commitRemote(envelope(snapshot));
  await sync();
  await until(
    () =>
      evaluate("profiles.find(p=>p.id==='ssh-main')?.name==='Desktop updated'"),
    "Automatic pull failed",
  );
  await status("synced");
  // Disable automatic work while making independent edits on both sides.
  await configure({ ...config(), enabled: false });
  await status("disabled");
  await saveProfile({
    id: "ssh-main",
    name: "Local conflict",
    host: "example.invalid",
    port: 22,
    username: "desktop-user",
  });
  snapshot = remoteSnapshot();
  snapshot.hosts.find((h) => h.id === "ssh-main").alias = "Remote conflict";
  commitRemote(envelope(snapshot));
  await configure(config());
  await status("conflict");
  // A racing third edit must invalidate the user's previously displayed choice.
  snapshot.hosts.find((h) => h.id === "ssh-main").alias = "Remote raced";
  commitRemote(envelope(snapshot));
  await sync("local");
  await status("conflict");
  assert.equal(
    remoteSnapshot().hosts.find((h) => h.id === "ssh-main").alias,
    "Remote raced",
  );
  await sync("remote");
  await status("synced");
  assert(
    await evaluate("profiles.find(p=>p.id==='ssh-main').name==='Remote raced'"),
  );
  assert(
    adb("shell", "run-as", pkg, "ls", "files/sync-backups").endsWith(".enc"),
  );
  await evaluate("Android.restoreSyncBackup()");
  await status("disabled");
  await until(
    () =>
      evaluate("profiles.find(p=>p.id==='ssh-main').name==='Local conflict'"),
    "Encrypted backup restore failed",
  );
  await configure(config());
  await status("conflict");
  await sync("remote");
  await status("synced");

  // Process restart retains encrypted settings, token and the already-unwrapped vault key.
  await launch();
  await status("synced");
  // Switch SSH authentication from password to a separately imported Git key.
  await configure({
    ...config(),
    token: "",
    clearCredentials: true,
    privateKey: identity,
  });
  await status("synced");
  // Tampered ciphertext is never applied; malformed/unsupported input doesn't erase local profiles.
  const valid = JSON.parse(remoteRaw()),
    bad = structuredClone(valid);
  bad.payload.tag = Buffer.alloc(16).toString("base64");
  commitRemote(bad);
  await sync();
  await status("error");
  assert(
    await evaluate("profiles.find(p=>p.id==='ssh-main').name==='Remote raced'"),
  );
  commitRemote(valid);
  await sync();
  await status("synced");
  // Reject authenticated but structurally invalid snapshots before applying any local changes.
  const malformed = remoteSnapshot();
  malformed.groups[0].parentId = "folder";
  commitRemote(envelope(malformed));
  await sync();
  await status("error");
  assert(
    await evaluate("profiles.find(p=>p.id==='ssh-main').name==='Remote raced'"),
  );
  commitRemote(valid);
  await sync();
  await status("synced");
  const invalidPort = remoteSnapshot();
  invalidPort.hosts[0].port = "22";
  commitRemote(envelope(invalidPort));
  await sync();
  await status("error");
  commitRemote(valid);
  await sync();
  await status("synced");
  // Simulate a writer racing between fetch and push. Fast-forward-only push must not overwrite it.
  await configure({ ...config(), enabled: false });
  await status("disabled");
  await saveProfile({
    id: "ssh-main",
    name: "Push raced local",
    host: "example.invalid",
    port: 22,
    username: "desktop-user",
  });
  raceOnReceive = () => {
    const racing = remoteSnapshot();
    racing.hosts.find((h) => h.id === "ssh-main").alias =
      "Concurrent remote writer";
    commitRemote(envelope(racing));
  };
  await configure(config());
  await status("error");
  assert.equal(
    remoteSnapshot().hosts.find((h) => h.id === "ssh-main").alias,
    "Concurrent remote writer",
  );
  assert(
    await evaluate(
      "profiles.find(p=>p.id==='ssh-main').name==='Push raced local'",
    ),
  );
  await sync();
  await status("conflict");
  await sync("local");
  await status("synced");
  assert.equal(
    remoteSnapshot().hosts.find((h) => h.id === "ssh-main").alias,
    "Push raced local",
  );
  for (const client of clients) client.end();
  await new Promise((resolve) => server.close(resolve));
  await sync();
  await status("error");
  assert(
    await evaluate(
      "profiles.find(p=>p.id==='ssh-main').name==='Push raced local'",
    ),
  );
  await startServer();
  await sync();
  await status("synced");
  // Empty branch initialization uses an explicit master password and produces a desktop-readable vault.
  await launch(true);
  await saveProfile({
    id: "android-only",
    name: "New Android server",
    host: "phone.example.invalid",
    port: 22,
    username: "mobile",
    password: "mobile-server-secret",
  });
  await configure({
    ...config(),
    branch: "from-android",
    privateKey: identity,
    token: "",
  });
  await trust();
  await status("password-required");
  const mobileMaster = "Mobile-Ｖault-password";
  await sync("", mobileMaster);
  await status("synced");
  const mobile = decode(remoteRaw("from-android"), mobileMaster).snapshot;
  assert.equal(mobile.hosts[0].alias, "New Android server");
  assert.equal(mobile.hosts[0].protocol, "ssh");
  assert(!remoteRaw("from-android").includes("mobile-server-secret"));
  const encrypted = execFileSync(adbBin, [
    "-s",
    serial,
    "shell",
    "run-as",
    pkg,
    "cat",
    "files/profiles.enc",
  ]);
  assert(
    !encrypted.includes(Buffer.from(identity)) &&
      !encrypted.includes(Buffer.from(mobileMaster)) &&
      !encrypted.includes(Buffer.from("mobile-server-secret")),
  );
  console.log(
    "PASS: desktop-compatible scrypt/AES-GCM import/export, wrong passwords, SSH password/key Git transport, automatic push/pull, shared credentials, unsupported metadata, conflicts/races, encrypted backup restore/restart, tamper/schema rejection, fast-forward push races, offline recovery, new branch initialization and NFKC password normalization.",
  );
} finally {
  socket?.close();
  for (const client of clients) client.end();
  server?.close();
  adb("shell", "am", "force-stop", pkg);
  adb("shell", "pm", "clear", pkg);
  if (port) adb("reverse", "--remove", `tcp:${port}`);
  adb("forward", "--remove", "tcp:9224");
  rmSync(root, { recursive: true, force: true });
}
