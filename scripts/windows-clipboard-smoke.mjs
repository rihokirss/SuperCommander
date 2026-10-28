// Owns a dedicated CI desktop clipboard. Never run against a user's desktop.
import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

assert.equal(process.platform, "win32");
assert.equal(
  process.env.CI,
  "true",
  "This test requires its own dedicated CI desktop and clipboard",
);
const exe = path.resolve(
  process.argv[2] || "target/release/supercommander.exe",
);
await fs.access(exe);
const root = await fs.mkdtemp(
  path.join(os.tmpdir(), "SuperCommander-clipboard-"),
);
const src = path.join(root, "Source"),
  dst = path.join(root, "Destination");
await fs.mkdir(src);
await fs.mkdir(dst);
await fs.mkdir(path.join(src, "Tree"));
await fs.writeFile(path.join(src, "Tree", "nested.txt"), "nested content");
for (const name of ["Õun🚀.txt", "move.txt", "external.txt"])
  await fs.writeFile(path.join(src, name), `original ${name}`);

// Paths are passed as data through the environment, never interpolated into PowerShell code.
function shell(script, file = "") {
  return execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-STA",
      "-EncodedCommand",
      Buffer.from(
        `$ErrorActionPreference='Stop'; [Console]::OutputEncoding = New-Object Text.UTF8Encoding; Add-Type -AssemblyName System.Windows.Forms; ${script}`,
        "utf16le",
      ).toString("base64"),
    ],
    { encoding: "utf8", env: { ...process.env, SC_CLIPBOARD_TEST_PATH: file } },
  ).trim();
}
const child = spawn(exe, [], {
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    SUPERCOMMANDER_DATA_DIR: path.join(root, "Settings"),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:
      "--remote-debugging-port=9224 --remote-debugging-address=127.0.0.1",
    WEBVIEW2_USER_DATA_FOLDER: path.join(root, "WebView"),
  },
});
let startupOutput = "",
  startupError,
  connectionError;
for (const stream of [child.stdout, child.stderr])
  stream.on("data", (data) => {
    startupOutput = (startupOutput + data).slice(-16384);
  });
child.on("error", (error) => {
  startupError = error;
});
let browser, page, original;
const rpc = (command, args = {}) =>
  page.evaluate(
    ({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args),
    { command, args },
  );
try {
  for (let attempt = 0; attempt < 180; attempt++) {
    if (startupError) throw startupError;
    if (child.exitCode !== null)
      throw new Error(`App exited during startup: ${child.exitCode}`);
    try {
      browser = await chromium.connectOverCDP("http://127.0.0.1:9224");
      break;
    } catch (error) {
      connectionError = error;
      await delay(250);
    }
  }
  assert.ok(browser, "Native app did not start its test WebView2 endpoint");
  await expect
    .poll(() =>
      browser
        .contexts()[0]
        .pages()
        .some((p) => p.url().includes("tauri.localhost")),
    )
    .toBe(true);
  page = browser
    .contexts()[0]
    .pages()
    .find((p) => p.url().includes("tauri.localhost"));
  // First-run Explorer/PowerShell discovery can outlast the default 5s on CI.
  await expect(page.locator(".app-shell")).toBeVisible({ timeout: 30000 });
  await expect
    .poll(async () => (await rpc("bootstrap")).settings?.panes?.length, {
      timeout: 30000,
    })
    .toBe(2);
  original = (await rpc("bootstrap")).settings;
  const panes = original.panes.map((p, i) => ({
    ...p,
    tabs: p.tabs.map((tab, index) => {
      const location = { source: "local", path: i ? dst : src };
      return index === 0
        ? { ...tab, location, history: [location], historyIndex: 0 }
        : tab;
    }),
    activeTab: p.tabs[0].id,
  }));
  await rpc("save_settings", {
    value: { ...original, language: "en", panes, workspaceCollapsed: false },
  });
  await page.reload();
  const left = page.locator('[data-pane="0"]'),
    right = page.locator('[data-pane="1"]');
  await left.getByText("Õun🚀.txt", { exact: true }).click();
  await page.keyboard.press("Control+c");
  await expect
    .poll(async () => (await rpc("read_file_clipboard"))?.cut)
    .toBe(false);
  assert.equal(
    shell("[Windows.Forms.Clipboard]::GetFileDropList()[0]"),
    path.join(src, "Õun🚀.txt"),
  );
  await page.keyboard.press("Tab");
  await page.keyboard.press("Control+v");
  await expect
    .poll(() =>
      fs.readFile(path.join(dst, "Õun🚀.txt"), "utf8").catch(() => ""),
    )
    .toBe("original Õun🚀.txt");
  assert.equal(
    await fs.readFile(path.join(src, "Õun🚀.txt"), "utf8"),
    "original Õun🚀.txt",
  );
  console.log(
    "PASS native Ctrl+C / Ctrl+V, independent shell file-drop consumer, Unicode and source preservation",
  );

  await left.getByText("Tree", { exact: true }).click();
  await page.keyboard.press("Control+Insert");
  await expect
    .poll(async () => (await rpc("read_file_clipboard"))?.paths?.[0])
    .toBe(path.join(src, "Tree"));
  await page.keyboard.press("Shift+Insert");
  await expect
    .poll(() =>
      fs
        .readFile(path.join(src, "Tree (1)", "nested.txt"), "utf8")
        .catch(() => ""),
    )
    .toBe("nested content");
  console.log(
    "PASS classic Insert clipboard shortcuts and safe same-directory tree duplication",
  );

  await left.getByText("move.txt", { exact: true }).click();
  await page.keyboard.press("Control+x");
  await expect(left.locator(".cut-entry")).toContainText("move.txt");
  await page.keyboard.press("Control+v");
  await expect(page.locator(".toast")).toContainText(
    "already in this directory",
  );
  assert.equal(
    await fs.readFile(path.join(src, "move.txt"), "utf8"),
    "original move.txt",
  );
  await page.keyboard.press("Escape");
  await expect(left.locator(".cut-entry")).toHaveCount(0);
  assert.equal(await rpc("read_file_clipboard"), null);
  await left.getByText("move.txt", { exact: true }).click();
  await page.keyboard.press("Control+x");
  await expect(left.locator(".cut-entry")).toContainText("move.txt");
  await fs.mkdir("artifacts", { recursive: true });
  await page.screenshot({ path: "artifacts/native-clipboard-cut.png" });
  await page.keyboard.press("Tab");
  await page.keyboard.press("Control+v");
  await expect
    .poll(() => fs.readFile(path.join(dst, "move.txt"), "utf8").catch(() => ""))
    .toBe("original move.txt");
  await expect
    .poll(() =>
      fs.access(path.join(src, "move.txt")).then(
        () => true,
        () => false,
      ),
    )
    .toBe(false);
  await expect.poll(() => rpc("read_file_clipboard")).toBe(null);
  await expect(left.locator(".cut-entry")).toHaveCount(0);
  console.log(
    "PASS native cut, same-directory rejection, Escape cancellation, queued move and clipboard consumption",
  );

  shell(
    `$files = New-Object System.Collections.Specialized.StringCollection;
    [void]$files.Add($env:SC_CLIPBOARD_TEST_PATH);
    $data = New-Object Windows.Forms.DataObject;
    $data.SetFileDropList($files);
    $effect = New-Object System.IO.MemoryStream;
    $effect.Write([byte[]](2,0,0,0),0,4); $effect.Position=0;
    $data.SetData('Preferred DropEffect',$false,$effect);
    [Windows.Forms.Clipboard]::SetDataObject($data,$true)`,
    path.join(src, "external.txt"),
  );
  const imported = await rpc("read_file_clipboard");
  assert.equal(imported.source, "local");
  assert.equal(imported.cut, true);
  assert.deepEqual(imported.paths, [path.join(src, "external.txt")]);
  await right.getByRole("grid").focus();
  await page.keyboard.press("Control+v");
  await expect
    .poll(() =>
      fs.readFile(path.join(dst, "external.txt"), "utf8").catch(() => ""),
    )
    .toBe("original external.txt");
  await expect
    .poll(() =>
      fs.access(path.join(src, "external.txt")).then(
        () => true,
        () => false,
      ),
    )
    .toBe(false);
  console.log(
    "PASS external Windows file-drop cut pasted through native WebView2 bridge",
  );

  await right.getByText("external.txt", { exact: true }).click();
  await page.keyboard.press("Control+Shift+c");
  await expect
    .poll(() => shell("[Windows.Forms.Clipboard]::GetText()"))
    .toBe(path.join(dst, "external.txt"));
  assert.equal(await rpc("read_file_clipboard"), null);
  console.log("PASS copy full path as native Unicode text");
} catch (error) {
  console.error(`Native startup output: ${startupOutput || "(none)"}`);
  console.error(`Last CDP connection error: ${connectionError}`);
  try {
    console.error(
      `CDP version endpoint: ${await fetch("http://127.0.0.1:9224/json/version").then((r) => r.text())}`,
    );
  } catch (error) {
    console.error(`CDP endpoint probe: ${error}`);
  }
  try {
    console.error(
      shell(
        "Get-CimInstance Win32_Process -Filter \"Name='msedgewebview2.exe' OR Name='supercommander.exe'\" | Select-Object ProcessId,SessionId,CommandLine | ConvertTo-Json -Compress",
      ),
    );
  } catch {
    /* Preserve the original failure if process diagnostics are unavailable. */
  }
  await fs.mkdir("artifacts", { recursive: true });
  await page
    ?.screenshot({ path: "artifacts/native-clipboard-failure.png" })
    .catch(() => {});
  throw error;
} finally {
  if (original) await rpc("save_settings", { value: original }).catch(() => {});
  await browser?.close();
  child.kill();
  await fs.rm(root, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 200,
  });
}
