#!/usr/bin/env node
// Secrets travel only over adb stdin into the app sandbox, never through argv or the APK.
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";

const [mode, adb, serial, value] = process.argv.slice(2);
const pkg = "kr.balkeunter.brightterm";
function remote(command, input) {
  const result = spawnSync(adb, ["-s", serial, "shell", command], {
    input,
    encoding: "utf8",
    timeout: 15000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      "adb 앱 설정 전송 실패. 개발용 APK와 USB 디버깅 연결을 확인하세요.",
    );
  return result.stdout.trim();
}
function loadConfig(path) {
  if (!existsSync(path)) return null;
  let c;
  try {
    c = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(
      "로컬 배포 설정 JSON을 읽을 수 없습니다. 형식을 확인하세요.",
    );
  }
  if (typeof c.accessToken !== "string")
    throw new Error("배포 설정의 accessToken은 문자열이어야 합니다.");
  if (!c.accessToken.trim()) return null;
  let uri;
  try {
    uri = new URL(c.remote);
  } catch {
    throw new Error("배포 설정의 remote에 HTTPS Git 주소를 넣으세요.");
  }
  if (
    uri.protocol !== "https:" ||
    !uri.hostname ||
    uri.username ||
    uri.password ||
    uri.search ||
    uri.hash
  )
    throw new Error("remote는 토큰을 포함하지 않는 HTTPS Git 주소여야 합니다.");
  if (typeof c.username !== "string" || !c.username.trim())
    throw new Error("배포 설정에 GitHub 사용자명을 넣으세요.");
  const branch = c.branch || "main";
  if (
    typeof branch !== "string" ||
    !branch ||
    branch.startsWith("/") ||
    branch.endsWith("/") ||
    branch.includes("..") ||
    branch.includes("@{") ||
    branch.includes("//") ||
    /[\x00-\x20\x7f~^:?*\[\\]/.test(branch) ||
    branch
      .split("/")
      .some((x) => x.startsWith(".") || x.endsWith(".") || x.endsWith(".lock"))
  )
    throw new Error("배포 설정의 branch가 올바르지 않습니다.");
  if (c.enabled !== undefined && typeof c.enabled !== "boolean")
    throw new Error("배포 설정의 enabled는 true 또는 false여야 합니다.");
  return {
    enabled: c.enabled !== false,
    remote: c.remote.trim(),
    branch,
    username: c.username.trim(),
    token: c.accessToken.trim(),
    privateKey: "",
    passphrase: "",
    clearCredentials: true,
  };
}
try {
  if (mode === "prepare") {
    const config = loadConfig(value);
    if (!config) {
      console.error(
        "토큰 배포 설정 없음 또는 accessToken이 비어 있음: 앱에 저장된 인증 정보를 유지합니다.",
      );
      process.exit(0);
    }
    const id = randomUUID(),
      payload = JSON.stringify({ version: 1, id, config });
    if (Buffer.byteLength(payload) > 65536)
      throw new Error("배포 설정이 너무 큽니다.");
    remote(
      `run-as ${pkg} sh -c 'umask 077; mkdir -p files; rm -f files/deploy-result.json; cat > files/deploy-pending.json'`,
      payload,
    );
    process.stdout.write(id);
  } else if (mode === "confirm") {
    let answer;
    for (let i = 0; i < 30; i++) {
      const raw = remote(
        `run-as ${pkg} sh -c 'if [ -f files/deploy-result.json ]; then cat files/deploy-result.json; fi'`,
      );
      try {
        answer = raw ? JSON.parse(raw) : null;
      } catch {
        answer = null;
      }
      if (answer?.id === value) break;
      await pause(500);
    }
    if (answer?.id !== value || answer.success !== true)
      throw new Error(
        "앱의 Git 인증 사전 등록에 실패했습니다. 로컬 설정 파일을 확인하세요.",
      );
    remote(
      `run-as ${pkg} rm -f files/deploy-result.json files/deploy-pending.json`,
    );
    console.log("Git HTTPS 인증 설정 등록 완료 (기기 내부 암호화 저장).");
  } else throw new Error("지원하지 않는 배포 설정 명령입니다.");
} catch (error) {
  // Never print library exceptions, configuration contents, environment or child stdin.
  console.error(error.message);
  process.exitCode = 1;
}
