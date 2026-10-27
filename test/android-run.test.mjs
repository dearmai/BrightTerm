import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  chmodSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test("android-run selects devices explicitly and never launches after an install failure", () => {
  const root = mkdtempSync(join(tmpdir(), "bt-adb-test-")),
    adb = join(root, "adb with spaces"),
    log = join(root, "calls"),
    apk = join(root, "Bright Term.apk");
  writeFileSync(apk, "test");
  writeFileSync(
    adb,
    `#!/usr/bin/env node
const fs=require('node:fs');const args=process.argv.slice(2);fs.appendFileSync(process.env.BT_ADB_LOG,JSON.stringify(args)+'\\n');
if(args[0]==='devices')console.log(process.env.BT_ADB_DEVICES);
else if(args.includes('install')){console.log('install');process.exit(Number(process.env.BT_INSTALL_EXIT||0));}
else console.log(process.env.BT_LAUNCH_ERROR?'Error: Activity class does not exist.':'Status: ok');
`,
  );
  chmodSync(adb, 0o755);
  function run(devices, serial = "", extras = {}) {
    writeFileSync(log, "");
    const result = spawnSync("bash", ["scripts/android-run.sh"], {
      encoding: "utf8",
      env: {
        ...process.env,
        ADB: adb,
        ANDROID_APK: apk,
        ANDROID_SERIAL: serial,
        ANDROID_DEPLOY_CONFIG: join(root, "no-config.json"),
        BT_ADB_LOG: log,
        BT_ADB_DEVICES: "List of devices attached\n" + devices,
        ...extras,
      },
    });
    return {
      ...result,
      calls: readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    };
  }
  try {
    let result = run("phone-1\tdevice\n");
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls[1], ["-s", "phone-1", "install", "-r", apk]);
    assert(result.calls[2].includes("am"));
    for (const devices of [
      "",
      "phone-1\tunauthorized\n",
      "phone-1\tdevice\nphone-2\tdevice\n",
    ]) {
      result = run(devices);
      assert.notEqual(result.status, 0);
      assert.equal(result.calls.length, 1);
    }
    result = run("phone-1\tdevice\nphone-2\tdevice\n", "phone-2");
    assert.equal(result.status, 0);
    assert.equal(result.calls[1][1], "phone-2");
    result = run("phone-1\tdevice\n", "missing");
    assert.notEqual(result.status, 0);
    assert.equal(result.calls.length, 1);
    result = run("phone-1\tdevice\n", "phone-1", { BT_INSTALL_EXIT: "1" });
    assert.notEqual(result.status, 0);
    assert.equal(result.calls.length, 2);
    result = run("phone-1\tdevice\n", "phone-1", { BT_LAUNCH_ERROR: "1" });
    assert.notEqual(result.status, 0);
    assert(
      result.calls.every(
        (call) => !call.includes("uninstall") && !call.includes("clear"),
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
