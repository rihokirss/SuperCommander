// Real Windows IPC: panes must remain usable while Explorer discovery is held.
import { startNativeTest } from "./native-test-instance.mjs";
import { expect } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
const instance = await startNativeTest("startup", process.argv[2]);
const { page, root } = instance;
try {
  await fs.writeFile(
    path.join(root, "startup-check.txt"),
    "owned startup fixture",
  );
  for (const index of [0, 1]) {
    const pane = page.locator(`[data-pane="${index}"]`);
    await pane.locator(".breadcrumbs").click();
    await pane.locator(".path-form input").fill(root);
    await pane.locator(".path-form input").press("Enter");
    await expect(
      pane.getByText("startup-check.txt", { exact: true }),
    ).toBeVisible();
  }
  await expect
    .poll(() =>
      page.evaluate(async (root) => {
        const b = await window.__TAURI_INTERNALS__.invoke("bootstrap", {
          includeNetwork: false,
        });
        return b.settings.panes.every(
          (p) =>
            p.tabs.find((t) => t.id === p.activeTab).location.path === root,
        );
      }, root),
    )
    .toBe(true);
  await page.addInitScript(() => {
    const real = window.fetch;
    const state = (window.__startupGate = {
      held: 0,
      done: false,
      release: undefined,
      fastMs: [],
    });
    window.fetch = function (input, init) {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      );
      if (url.hostname === "ipc.localhost" && url.pathname === "/bootstrap") {
        const args = JSON.parse(init?.body || "{}");
        if (args.includeNetwork === true) {
          state.held++;
          return new Promise((resolve, reject) => {
            state.release = () =>
              real
                .call(window, input, init)
                .then(resolve, reject)
                .finally(() => {
                  state.done = true;
                });
          });
        }
        const begin = performance.now();
        return real.call(window, input, init).then((result) => {
          state.fastMs.push(performance.now() - begin);
          return result;
        });
      }
      return real.call(window, input, init);
    };
  });
  await page.reload();
  await expect
    .poll(() => page.evaluate(() => window.__startupGate?.held))
    .toBe(1);
  const left = page.locator('[data-pane="0"]');
  await expect(
    left.getByText("startup-check.txt", { exact: true }),
  ).toBeVisible();
  await left.getByRole("grid").focus();
  await page.keyboard.press("Alt+s");
  await expect(left.locator(".quick-find input")).toBeFocused();
  await left.locator(".quick-find input").fill("startup-check");
  await page.keyboard.press("Enter");
  await expect(left.locator(".file-row.focused")).toContainText(
    "startup-check.txt",
  );
  await expect
    .poll(() => page.evaluate(() => window.__startupGate.done))
    .toBe(false);
  console.log(
    "PASS usable file panes and Alt+S while real Explorer discovery is blocked",
  );
  await page.evaluate(() => window.__startupGate.release());
  await expect
    .poll(() => page.evaluate(() => window.__startupGate.done), {
      timeout: 30000,
    })
    .toBe(true);
  const timings = await page.evaluate(async () => {
    const samples = [];
    for (let i = 0; i < 3; i++) {
      const start = performance.now();
      await window.__TAURI_INTERNALS__.invoke("bootstrap", {
        includeNetwork: false,
      });
      samples.push(Math.round(performance.now() - start));
    }
    return {
      fastBootstrapMs: samples,
      initialBootstrapMs: window.__startupGate.fastMs,
      domReadyMs:
        performance.getEntriesByType("navigation")[0].domContentLoadedEventEnd,
    };
  });
  console.log(
    "PASS deferred Explorer request completes; startup timings:",
    JSON.stringify(timings),
  );
} finally {
  await instance.close();
}
