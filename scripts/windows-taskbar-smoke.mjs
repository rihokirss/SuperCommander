import { startNativeTest } from "./native-test-instance.mjs";
import { expect } from "@playwright/test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";

const app = await startNativeTest("taskbar", process.argv[2]);
const { page, child, root, exe } = app;
const powershell = path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const helper = path.join(root, "snapshot.ps1");
await fs.writeFile(helper, `param([int]$AppProcessId)
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class TaskbarTest {
 public delegate bool Callback(IntPtr hwnd, IntPtr data);
 [DllImport("user32.dll")] public static extern bool EnumWindows(Callback callback, IntPtr data);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
 [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
 [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hwnd, uint command);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int length);
 [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")] public static extern IntPtr GetWindowLong(IntPtr hwnd, int index);
}
'@
$script:result = $null
$callback = [TaskbarTest+Callback]{ param($hwnd,$unused)
 [uint32]$ownerProcess=0
 [void][TaskbarTest]::GetWindowThreadProcessId($hwnd,[ref]$ownerProcess)
 if($ownerProcess -eq $AppProcessId) {
  $title=[Text.StringBuilder]::new(256)
  [void][TaskbarTest]::GetWindowText($hwnd,$title,256)
  if($title.ToString() -eq 'SuperCommander') {
   $style=[TaskbarTest]::GetWindowLong($hwnd,-20).ToInt64()
   $visible=[TaskbarTest]::IsWindowVisible($hwnd)
   $script:result=@{ visible=$visible; minimized=[TaskbarTest]::IsIconic($hwnd); taskbar=$visible -and [TaskbarTest]::GetWindow($hwnd,4) -eq [IntPtr]::Zero -and (($style -band 0x80) -eq 0 -or ($style -band 0x40000) -ne 0) }
  }
 }
 return $true
}
[void][TaskbarTest]::EnumWindows($callback,[IntPtr]::Zero)
$script:result | ConvertTo-Json -Compress
`);
const run = promisify(execFile);
async function snapshot() {
  const result = await run(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helper, String(child.pid)]);
  return JSON.parse(result.stdout.trim());
}
let secondary;
try {
  await page.locator('[data-pane="0"] .file-grid').focus();
  await page.keyboard.press("Control+Backquote");
  const terminal = page.locator(".terminal-panel:visible");
  await expect(terminal.locator(".xterm-rows")).toContainText("PS ", { timeout: 30000 });
  await terminal.locator(".xterm-helper-textarea").focus();
  await page.keyboard.type("$sc_taskbar = 'SESSION_PRESERVED'");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Minimize", exact: true }).click();
  await expect.poll(async () => {
    const state = await snapshot();
    return state?.minimized && state.visible && state.taskbar;
  }, { timeout: 15000 }).toBe(true);
  assert.equal(child.exitCode, null, "Minimizing stopped the app process");

  secondary = spawn(exe, [], {
    stdio: "ignore",
    env: { ...process.env, SUPERCOMMANDER_DATA_DIR: path.join(root, "Settings"), WEBVIEW2_USER_DATA_FOLDER: path.join(root, "SecondaryWebView") },
  });
  await expect.poll(() => secondary.exitCode, { timeout: 15000 }).not.toBeNull();
  assert.equal(secondary.exitCode, 0);
  await expect.poll(async () => {
    const state = await snapshot();
    return state?.visible && !state.minimized && state.taskbar;
  }, { timeout: 15000 }).toBe(true);
  assert.equal(child.exitCode, null, "Relaunch replaced the original process");
  await terminal.locator(".xterm-helper-textarea").focus();
  await page.keyboard.type("Write-Output ('SC_RESTORE:' + $sc_taskbar)");
  await page.keyboard.press("Enter");
  await expect(terminal.locator(".xterm-rows")).toContainText("SC_RESTORE:SESSION_PRESERVED");
  console.log("PASS taskbar visibility while minimized, single-instance restore and preserved terminal session");
} finally {
  if (secondary?.exitCode === null) secondary.kill();
  await app.close();
}
