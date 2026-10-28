// A test owns its process, WebView profile and settings from startup to teardown.
import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// Tauri's invoke/ipc properties are non-writable. Delay the real custom-protocol
// fetch, and require evidence that the chosen command actually entered the gate.
export async function holdNativeCommand(page, command) {
  const key = `__scNativeGate_${randomUUID().replaceAll("-", "")}`;
  await page.evaluate(
    ({ key, command }) => {
      const original = window.fetch;
      let resume;
      const waiting = new Promise((resolve) => {
        resume = resolve;
      });
      const state = {
        seen: 0,
        release: () => {
          window.fetch = original;
          resume();
        },
      };
      const wrapped = async (input, init) => {
        const url = new URL(
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url,
        );
        if (
          url.hostname === "ipc.localhost" &&
          decodeURIComponent(url.pathname.slice(1)) === command
        ) {
          state.seen++;
          await waiting;
        }
        return original.call(window, input, init);
      };
      window[key] = state;
      window.fetch = wrapped;
      if (window.fetch !== wrapped)
        throw Error("The native IPC fetch gate was not installed");
    },
    { key, command },
  );
  return {
    entered: () =>
      expect
        .poll(() => page.evaluate((key) => window[key].seen, key))
        .toBeGreaterThan(0),
    release: () =>
      page.evaluate((key) => {
        window[key].release();
        delete window[key];
      }, key),
  };
}

export async function startNativeTest(name, executable) {
  assert.equal(process.platform, "win32");
  const exe = path.resolve(executable || "target/release/supercommander.exe");
  await fs.access(exe);
  // Never attach to somebody else's already-running debugging endpoint.
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(9224, "127.0.0.1", resolve);
  });
  await new Promise((resolve) => probe.close(resolve));
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), `SuperCommander-${name}-`),
  );
  const child = spawn(exe, [], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      SUPERCOMMANDER_DATA_DIR: path.join(root, "Settings"),
      WEBVIEW2_USER_DATA_FOLDER: path.join(root, "WebView"),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:
        "--remote-debugging-port=9224 --remote-debugging-address=127.0.0.1",
    },
  });
  let output = "",
    startupError,
    browser;
  child.on("error", (error) => {
    startupError = error;
  });
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (data) => {
      output = (output + data).slice(-16384);
    });
  async function close() {
    await browser?.close().catch(() => {});
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = new Promise((resolve) => child.once("exit", resolve));
      child.kill();
      await Promise.race([stopped, delay(5000)]);
    }
    await fs.rm(root, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 200,
    });
  }
  try {
    for (let attempt = 0; attempt < 120; attempt++) {
      if (startupError) throw startupError;
      if (child.exitCode !== null)
        throw Error(`Test app exited: ${child.exitCode}`);
      try {
        browser = await chromium.connectOverCDP("http://127.0.0.1:9224", {
          timeout: 1000,
        });
        break;
      } catch {
        await delay(250);
      }
    }
    assert.ok(browser, "The test app did not expose its debugging endpoint");
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
    // CDP can be ready before WebView navigation and settings initialization finish.
    // Wait for this owned process to finish loading, without relaunching it.
    await expect(page.locator(".app-shell")).toBeVisible({ timeout: 30000 });
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            window.__TAURI_INTERNALS__
              .invoke("bootstrap", { includeNetwork: false })
              .then((value) => value.settings?.panes?.length),
          ),
        { timeout: 30000 },
      )
      .toBe(2);
    return { browser, page, root, close };
  } catch (error) {
    console.error(`Native test startup: ${error}\n${output}`);
    await close();
    throw error;
  }
}
