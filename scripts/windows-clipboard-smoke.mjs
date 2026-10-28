// Owns a dedicated CI desktop clipboard. Never run against a user's desktop.
import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";

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
  for (const cut of [false, true]) {
    const name = cut ? "guarded-cut.txt" : "guarded-copy.txt";
    const selected = path.join(src, name);
    await fs.writeFile(selected, "before");
    await left.getByRole("grid").focus();
    await page.keyboard.press("Control+r");
    await left.getByText(name, { exact: true }).click();
    await page.keyboard.press(cut ? "Control+x" : "Control+c");
    await expect
      .poll(async () => (await rpc("read_file_clipboard"))?.paths?.[0])
      .toBe(selected);
    const selection = await rpc("read_file_clipboard");
    assert.equal(selection.bindings.length, 1);
    const props = await fs.stat(selected);
    await fs.rename(selected, selected + ".kept");
    await fs.writeFile(selected, "edited");
    await fs.utimes(selected, props.atime, props.mtime);
    const failures = await page.locator(".job-row.failed").count();
    await right.getByRole("grid").focus();
    await page.keyboard.press("Control+v");
    await expect(page.locator(".job-row.failed")).toHaveCount(failures + 1);
    await assert.rejects(fs.access(path.join(dst, name)));
    assert.equal(await fs.readFile(selected, "utf8"), "edited");
    assert.equal(await fs.readFile(selected + ".kept", "utf8"), "before");
    if (cut) await expect.poll(() => rpc("read_file_clipboard")).toBe(null);
  }
  console.log(
    "PASS clipboard object bindings reject same-size/same-time replacements before copy/cut output and clear only the stale cut receipt",
  );

  const directory = path.join(src, "Guarded folder");
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, "original.txt"), "original child");
  await left.getByRole("grid").focus();
  await page.keyboard.press("Control+r");
  await left.getByText("Guarded folder", { exact: true }).click();
  await page.keyboard.press("Control+x");
  await expect
    .poll(async () => (await rpc("read_file_clipboard"))?.paths?.[0])
    .toBe(directory);
  await fs.rename(directory, directory + ".kept");
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, "foreign.txt"), "keep foreign child");
  const failures = await page.locator(".job-row.failed").count();
  await right.getByRole("grid").focus();
  await page.keyboard.press("Control+v");
  await expect(page.locator(".job-row.failed")).toHaveCount(failures + 1);
  await assert.rejects(fs.access(path.join(dst, "Guarded folder")));
  assert.equal(
    await fs.readFile(path.join(directory, "foreign.txt"), "utf8"),
    "keep foreign child",
  );
  await expect.poll(() => rpc("read_file_clipboard")).toBe(null);

  await left.getByRole("grid").focus();
  await left.getByText("Guarded folder", { exact: true }).click();
  await page.keyboard.press("Control+c");
  await expect
    .poll(async () => (await rpc("read_file_clipboard"))?.paths?.[0])
    .toBe(directory);
  await fs.writeFile(
    path.join(directory, "added.txt"),
    "live child added before paste",
  );
  await right.getByRole("grid").focus();
  await page.keyboard.press("Control+v");
  await expect
    .poll(() =>
      fs
        .readFile(path.join(dst, "Guarded folder", "added.txt"), "utf8")
        .catch(() => ""),
    )
    .toBe("live child added before paste");
  const current = await rpc("read_file_clipboard");
  const cancelled = randomUUID();
  await rpc("cancel_search", { id: cancelled });
  await assert.rejects(
    rpc("write_file_clipboard", {
      id: cancelled,
      value: { source: "local", paths: [directory], cut: false, revision: 0 },
    }),
    /Cancelled/,
  );
  assert.deepEqual(await rpc("read_file_clipboard"), current);
  console.log(
    "PASS replaced directory guards, live native folder children and cancellation before clipboard capture registration",
  );

  for (const name of ["queued-cut.txt", "latest-copy.txt"])
    await fs.writeFile(path.join(src, name), name);
  await left.getByRole("grid").focus();
  await page.keyboard.press("Control+r");
  await left.getByText("queued-cut.txt", { exact: true }).click();
  await page.keyboard.press("Control+x");
  await expect
    .poll(async () => (await rpc("read_file_clipboard"))?.paths?.[0])
    .toBe(path.join(src, "queued-cut.txt"));
  await page.evaluate(() => {
    const bridge = window.__TAURI_INTERNALS__,
      original = bridge.invoke;
    let resume;
    const gate = new Promise((resolve) => {
      resume = resolve;
    });
    bridge.invoke = async (command, args) => {
      if (command === "enqueue_job") await gate;
      return original(command, args);
    };
    window.__resumeClipboardPaste = () => {
      resume();
    };
    window.__finishedClipboardCuts = [];
    const gated = bridge.invoke;
    bridge.invoke = async (command, args) => {
      const result = await gated(command, args);
      if (command === "finish_file_paste")
        window.__finishedClipboardCuts.push(args.clipboard.paths);
      return result;
    };
  });
  await right.getByRole("grid").focus();
  await page.keyboard.press("Control+v");
  await expect(page.locator(".job-row.queued").first()).toContainText(
    "queued-cut.txt",
  );
  await left.getByText("latest-copy.txt", { exact: true }).click();
  await page.keyboard.press("Control+c");
  await expect
    .poll(async () => (await rpc("read_file_clipboard"))?.paths?.[0])
    .toBe(path.join(src, "latest-copy.txt"));
  await page.evaluate(() => window.__resumeClipboardPaste());
  await expect
    .poll(() =>
      fs.readFile(path.join(dst, "queued-cut.txt"), "utf8").catch(() => ""),
    )
    .toBe("queued-cut.txt");
  await expect
    .poll(() =>
      fs.access(path.join(src, "queued-cut.txt")).then(
        () => true,
        () => false,
      ),
    )
    .toBe(false);
  await expect
    .poll(async () => (await rpc("read_file_clipboard"))?.paths?.[0])
    .toBe(path.join(src, "latest-copy.txt"));
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__finishedClipboardCuts.some((paths) =>
          paths.some((path) => path.endsWith("queued-cut.txt")),
        ),
      ),
    )
    .toBe(true);
  console.log(
    "PASS a new Ctrl+C remains available while a previous paste is preparing; late cut completion retains the newer clipboard",
  );
  const previous = await rpc("read_file_clipboard");
  await page.evaluate(() => {
    const bridge = window.__TAURI_INTERNALS__,
      original = bridge.invoke;
    let resume;
    const gate = new Promise((resolve) => {
      resume = resolve;
    });
    bridge.invoke = async (command, args) => {
      if (command === "write_file_clipboard") await gate;
      return original(command, args);
    };
    window.__resumeClipboardCapture = () => {
      bridge.invoke = original;
      resume();
    };
  });
  await left.getByText("guarded-copy.txt", { exact: true }).click();
  await page.keyboard.press("Control+c");
  await expect(page.locator(".clipboard-check")).toBeVisible();
  const check = await page.locator(".clipboard-check").boundingBox(),
    footer = await page.locator(".statusbar").boundingBox();
  assert.ok(check.height <= footer.height);
  await page.screenshot({ path: "artifacts/native-clipboard-check.png" });
  await page.keyboard.press("Escape");
  await expect(left.locator(".file-row.selected")).toHaveCount(1);
  await page.evaluate(() => window.__resumeClipboardCapture());
  await expect(page.locator(".clipboard-check")).toHaveCount(0);
  await expect(page.locator(".toast")).toContainText("Cancelled");
  assert.deepEqual(await rpc("read_file_clipboard"), previous);
  console.log(
    "PASS clipboard-check status and Escape cancellation preserve marks and the prior native clipboard",
  );
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
