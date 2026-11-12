// e2e 끝내기 — 연결이 남아 있으면 앱이 "연결된 세션 n개, 종료할까요?" 확인 창을 띄워 닫히지 않는다.
// 창의 close 처리기를 건너뛰도록 표시하고 닫는다. 그래도 안 닫히면 프로세스를 끝낸다.
export async function closeApp(app) {
  if (!app) return
  try {
    await app.evaluate(({ BrowserWindow }) => {
      for (const w of BrowserWindow.getAllWindows()) w._forceClose = true
    })
  } catch { /* 이미 닫힘 */ }
  const proc = app.process()
  await Promise.race([app.close().catch(() => {}), new Promise((r) => setTimeout(r, 8000))])
  if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL')
}
