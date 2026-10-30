// Exercise normal, maximized, minimized and off-screen placement in owned test windows.
import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";

assert.equal(process.platform, "win32");
const exe = path.resolve(
  process.argv[2] || "target/release/supercommander.exe",
);
const probe = net.createServer();
await new Promise((resolve, reject) => {
  probe.once("error", reject);
  probe.listen(9224, "127.0.0.1", resolve);
});
await new Promise((resolve) => probe.close(resolve));
const root = await fs.mkdtemp(
  path.join(os.tmpdir(), "SuperCommander-window-state-"),
);
const settingsDir = path.join(root, "Settings");
const powershell = path.join(
  process.env.SystemRoot,
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);
const command = promisify(execFile);
const helper = path.join(root, "window.ps1");
await fs.writeFile(
  helper,
  `param([string]$Action, [int]$AppProcessId, [long]$WindowHandle)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SCWindowTest {
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int x, y; }
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int left, top, right, bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct Placement { public uint length, flags, showCmd; public Point min, max; public Rect normal; }
  [DllImport("user32.dll")] public static extern bool GetWindowPlacement(IntPtr hwnd, ref Placement placement);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int w, int h, uint flags);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int command);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint flags);
}
'@
$window = if ($WindowHandle -ne 0) { [IntPtr]::new($WindowHandle) } else { (Get-Process -Id $AppProcessId).MainWindowHandle }
if ($window -eq [IntPtr]::Zero) { throw 'No test window handle' }
switch ($Action) {
 'move' { if (-not [SCWindowTest]::SetWindowPos($window, [IntPtr]::Zero, 64, 50, 1100, 700, 20)) { throw 'SetWindowPos failed' } }
 'maximize' { [void][SCWindowTest]::ShowWindow($window, 3) }
 'restore' { [void][SCWindowTest]::ShowWindow($window, 9) }
 'minimize' { [void][SCWindowTest]::ShowWindow($window, 6) }
 'close' { if (-not [SCWindowTest]::PostMessage($window, 16, [IntPtr]::Zero, [IntPtr]::Zero)) { throw 'Close request failed' } }
 'snapshot' {
   $placement = New-Object SCWindowTest+Placement
   $placement.length = [uint32][Runtime.InteropServices.Marshal]::SizeOf([type]'SCWindowTest+Placement')
   if (-not [SCWindowTest]::GetWindowPlacement($window, [ref]$placement)) { throw 'GetWindowPlacement failed' }
   [pscustomobject]@{ handle = $window.ToInt64(); show = $placement.showCmd; minimized = [SCWindowTest]::IsIconic($window); visible = [SCWindowTest]::IsWindowVisible($window); left = $placement.normal.left; top = $placement.normal.top; right = $placement.normal.right; bottom = $placement.normal.bottom; onScreen = ([SCWindowTest]::MonitorFromWindow($window,0) -ne [IntPtr]::Zero) } | ConvertTo-Json -Compress
 }
}
`,
);
let child,
  browser,
  windowHandle = 0;
async function waitForPort() {
  for (let attempt = 0; attempt < 60; attempt++) {
    const listener = net.createServer();
    const available = await new Promise((resolve) => {
      listener.once("error", () => resolve(false));
      listener.listen(9224, "127.0.0.1", () =>
        listener.close(() => resolve(true)),
      );
    });
    if (available) return;
    await delay(250);
  }
  throw Error("The previous test WebView did not release its debugging port");
}
async function win(action) {
  const { stdout } = await command(
    powershell,
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      helper,
      action,
      String(child.pid),
      String(windowHandle),
    ],
    { timeout: 10000 },
  );
  return action === "snapshot" ? JSON.parse(stdout.trim()) : undefined;
}
async function start() {
  await waitForPort();
  child = spawn(exe, [], {
    stdio: "ignore",
    env: {
      ...process.env,
      SUPERCOMMANDER_DATA_DIR: settingsDir,
      WEBVIEW2_USER_DATA_FOLDER: path.join(root, "WebView"),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:
        "--remote-debugging-port=9224 --remote-debugging-address=127.0.0.1",
    },
  });
  let error;
  child.on("error", (e) => {
    error = e;
  });
  for (let attempt = 0; attempt < 120; attempt++) {
    if (error) throw error;
    if (child.exitCode !== null)
      throw Error(`Test application exited: ${child.exitCode}`);
    try {
      browser = await chromium.connectOverCDP("http://127.0.0.1:9224", {
        timeout: 1000,
      });
      break;
    } catch {
      await delay(250);
    }
  }
  assert.ok(browser, "Test application did not start");
  await expect
    .poll(
      () =>
        browser
          .contexts()[0]
          .pages()
          .some((p) => p.url().includes("tauri.localhost")),
      { timeout: 30000 },
    )
    .toBe(true);
  const page = browser
    .contexts()[0]
    .pages()
    .find((p) => p.url().includes("tauri.localhost"));
  await expect(page.locator(".app-shell")).toBeVisible({ timeout: 30000 });
  await expect(page.locator(".titlebar")).toHaveCSS("height", "42px");
  windowHandle = (await win("snapshot")).handle;
  return page;
}
async function stop() {
  const exited =
    child.exitCode !== null
      ? Promise.resolve()
      : new Promise((resolve) => child.once("exit", resolve));
  await win("close");
  let timer;
  try {
    await Promise.race([
      exited,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(Error("Test window did not close")),
          10000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  await browser.close().catch(() => {});
  browser = undefined;
  child = undefined;
  windowHandle = 0;
}
function assertNormal(actual, expected) {
  for (const field of ["left", "top", "right", "bottom"])
    assert.ok(
      Math.abs(actual[field] - expected[field]) <= 2,
      `${field} did not restore`,
    );
}
try {
  const firstPage = await start();
  await firstPage.locator('[data-pane="0"] .file-grid').focus();
  await firstPage.keyboard.press("Control+Backquote");
  await expect(firstPage.locator(".terminal-panel:visible .xterm-rows")).toContainText("PS ", { timeout: 30000 });
  await expect.poll(async () => JSON.parse(await fs.readFile(path.join(settingsDir, "settings.json"), "utf8")).terminalOpen).toBe(true);
  await win("move");
  await delay(400);
  const normal = await win("snapshot");
  assert.equal(normal.show, 1);
  await stop();
  const statePath = path.join(settingsDir, "window-state.json");
  await fs.access(statePath);
  const reopened = await start();
  await expect(reopened.locator(".terminal-panel:visible .xterm-rows")).toContainText("PS ", { timeout: 30000 });
  await reopened.locator('[data-pane="0"] .file-grid').focus();
  await reopened.keyboard.press("Control+Backquote");
  await expect(reopened.locator(".terminal-panel:visible")).toHaveCount(0);
  await expect.poll(async () => JSON.parse(await fs.readFile(path.join(settingsDir, "settings.json"), "utf8")).terminalOpen).toBe(false);
  console.log("PASS docked terminal open state survives process restart");
  let current = await win("snapshot");
  assert.equal(current.show, 1);
  assertNormal(current, normal);
  console.log("PASS normal window position and size survive restart");
  await win("maximize");
  await expect.poll(async () => (await win("snapshot")).show).toBe(3);
  await stop();
  await start();
  await expect.poll(async () => (await win("snapshot")).show).toBe(3);
  await win("restore");
  await expect.poll(async () => (await win("snapshot")).show).toBe(1);
  current = await win("snapshot");
  assertNormal(current, normal);
  console.log(
    "PASS maximized state and previous normal position survive restart",
  );
  await win("maximize");
  await expect.poll(async () => (await win("snapshot")).show).toBe(3);
  const currentPage = browser.contexts()[0].pages().find((page) => page.url().includes("tauri.localhost"));
  await currentPage.getByRole("button", { name: "Minimize", exact: true }).click();
  await expect.poll(async () => (await win("snapshot")).minimized).toBe(true);
  assert.equal((await win("snapshot")).visible, true, "Minimizing hid the window from the taskbar");
  await stop();
  await start();
  await expect.poll(async () => (await win("snapshot")).show).toBe(3);
  await stop();
  console.log(
    "PASS minimizing before exit preserves the previous maximized state",
  );
  await fs.writeFile(
    statePath,
    JSON.stringify({
      left: 100000,
      top: 100000,
      right: 101100,
      bottom: 100700,
      maximized: false,
    }),
  );
  await start();
  current = await win("snapshot");
  assert.equal(
    current.onScreen,
    true,
    "Off-screen saved placement was not recovered",
  );
  await stop();
  await fs.writeFile(statePath, "{invalid json");
  await start();
  current = await win("snapshot");
  assert.equal(
    current.onScreen,
    true,
    "Invalid state prevented a visible startup",
  );
  await stop();
  console.log("PASS disconnected-monitor and invalid-state recovery");
} finally {
  await browser?.close().catch(() => {});
  if (child && child.exitCode === null) child.kill();
  await fs.rm(root, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 200,
  });
}
