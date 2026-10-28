// Owns its process, settings and files. Does not use the desktop clipboard.
import { expect } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { startNativeTest } from "./native-test-instance.mjs";

const instance = await startNativeTest("archives", process.argv[2]);
const { page, root } = instance;
const rpc = (command, args = {}) =>
  page.evaluate(
    ({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args),
    { command, args },
  );
const source = path.join(root, "Source"),
  destination = path.join(root, "Destination"),
  outside = path.join(root, "Outside");
const example = path.join(source, "Example"),
  document = path.join(example, "dated.txt");
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
try {
  await fs.mkdir(path.join(example, "Empty"), { recursive: true });
  await fs.mkdir(destination);
  await fs.mkdir(outside);
  await fs.writeFile(document, "Owned archive sample\n");
  const time = new Date("2024-01-02T03:04:06.123Z");
  for (const file of [document, path.join(example, "Empty"), example])
    await fs.utimes(file, time, time);
  await fs.chmod(document, 0o444);
  const originalTime = (await fs.stat(document, { bigint: true })).mtimeNs;
  const settings = (await rpc("bootstrap")).settings;
  const config = path.join(root, "ssh_config");
  await fs.writeFile(config, "");
  await rpc("save_settings", {
    value: {
      ...settings,
      language: "en",
      density: "compact",
      theme: "dark",
      sshConfigPath: config,
      panes: settings.panes.map((pane, i) => {
        const location = { source: "local", path: i ? destination : source };
        return {
          ...pane,
          activeTab: pane.tabs[0].id,
          tabs: [
            { ...pane.tabs[0], location, history: [location], historyIndex: 0 },
          ],
        };
      }),
    },
  });
  await page.reload();
  await page.evaluate(async () => {
    const bridge = window.__TAURI_INTERNALS__;
    window.__archiveEvents = {};
    const handler = bridge.transformCallback((e) => {
      window.__archiveEvents[e.payload.id] = e.payload;
    });
    await bridge.invoke("plugin:event|listen", {
      event: "job-progress",
      target: { kind: "Any" },
      handler,
    });
  });
  const left = page.locator('[data-pane="0"]');
  await left.getByText("Example", { exact: true }).click();
  await page.keyboard.press("Alt+F5");
  let dialog = page.getByRole("dialog", { name: "Create ZIP", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Create ZIP", exact: true }).click();
  await expect(left.getByText("Example.zip", { exact: true })).toBeVisible({
    timeout: 30000,
  });
  const archive = path.join(source, "Example.zip");
  await left.getByText("Example.zip", { exact: true }).dblclick();
  await left.getByText("Example", { exact: true }).dblclick();
  const row = left.locator(".file-row").filter({ hasText: "dated.txt" });
  await expect(row).toContainText("2024");
  await left.getByText("dated.txt", { exact: true }).click();
  await page.keyboard.press("F3");
  await expect(page.locator(".file-workbench textarea")).toHaveValue(
    "Owned archive sample\n",
  );
  await page.keyboard.press("F10");
  await left.getByRole("grid").focus();
  for (const key of ["F4", "F8"]) {
    await page.keyboard.press(key);
    await expect(page.locator(".toast")).toContainText("Read-only archive");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  }
  await page.keyboard.press("F5");
  await page
    .getByRole("dialog", { name: "Copy", exact: true })
    .getByRole("button", { name: "Copy", exact: true })
    .click();
  const copied = path.join(destination, "dated.txt");
  await expect
    .poll(() => fs.readFile(copied, "utf8").catch(() => ""), { timeout: 30000 })
    .toBe("Owned archive sample\n");
  assert.equal((await fs.stat(copied, { bigint: true })).mtimeNs, originalTime);
  await left.getByRole("grid").focus();
  await page.keyboard.press("Backspace");
  await expect(left.getByText("Example", { exact: true })).toBeVisible();
  await left.getByRole("grid").focus();
  await page.keyboard.press("Backspace");
  await expect(left.getByText("Example.zip", { exact: true })).toBeVisible();
  await left.getByText("Example.zip", { exact: true }).click();
  await page.keyboard.press("Alt+F6");
  dialog = page.getByRole("dialog", { name: "Extract ZIP", exact: true });
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole("button", { name: "Extract ZIP", exact: true })
    .click();
  const extracted = path.join(destination, "Example", "dated.txt");
  await expect
    .poll(() => fs.readFile(extracted, "utf8").catch(() => ""), {
      timeout: 30000,
    })
    .toBe("Owned archive sample\n");
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            Object.values(window.__archiveEvents).filter(
              (event) => event.state === "completed",
            ).length,
        ),
      { timeout: 30000 },
    )
    .toBe(3);
  assert.equal(
    (await fs.stat(extracted, { bigint: true })).mtimeNs,
    originalTime,
  );
  assert.equal(
    (
      await fs.stat(path.join(destination, "Example", "Empty"), {
        bigint: true,
      })
    ).mtimeNs,
    (await fs.stat(path.join(example, "Empty"), { bigint: true })).mtimeNs,
  );
  assert.equal((await fs.stat(extracted)).mode & 0o222, 0);
  console.log(
    "PASS native Alt+F5/Alt+F6, ZIP browsing/F3/F5 and F4/F8 guards, UTC timestamps, empty directories and read-only files",
  );

  async function job(operation, paths, target, cancel = false) {
    const id = randomUUID();
    if (cancel) await rpc("cancel_job", { id });
    await rpc("enqueue_job", {
      request: {
        id,
        operation,
        source: "local",
        paths,
        destination: { source: "local", path: target },
        conflict: "replace",
      },
    });
    await expect
      .poll(
        () => page.evaluate((id) => window.__archiveEvents[id]?.state, id),
        { timeout: 30000 },
      )
      .toMatch(/^(completed|failed|cancelled)$/);
    return page.evaluate((id) => window.__archiveEvents[id], id);
  }
  // Replacing an extracted file retains its previous version and record.
  await fs.chmod(extracted, 0o666);
  await fs.writeFile(extracted, "previous extracted contents");
  let event = await job("extract", [archive], destination);
  assert.equal(event.state, "completed", JSON.stringify(event.errors));
  assert.equal(event.preservedCount, 1);
  assert.equal(
    await fs.readFile(event.preserved[0].path, "utf8"),
    "previous extracted contents",
  );
  await fs.access(event.preserved[0].record);
  const alias = path.join(source, "source-alias.zip");
  await fs.link(document, alias);
  event = await job("zip", [document], alias);
  assert.equal(event.state, "failed");
  assert.equal(await fs.readFile(document, "utf8"), "Owned archive sample\n");
  const cancelled = path.join(source, "cancelled.zip");
  event = await job("zip", [document], cancelled, true);
  assert.equal(event.state, "cancelled");
  await assert.rejects(fs.access(cancelled));
  console.log(
    "PASS retained previous versions, physical source aliases and cancellation before enqueue",
  );

  const guarded = path.join(root, "Guarded");
  await fs.mkdir(guarded);
  const junction = path.join(guarded, "Example");
  await fs.symlink(outside, junction, "junction");
  event = await job("extract", [archive], guarded);
  assert.equal(event.state, "failed", JSON.stringify(event.errors));
  assert.deepEqual(await fs.readdir(outside), []);
  await fs.rmdir(junction);
  console.log(
    "PASS Windows junction cannot redirect extraction outside the destination",
  );
  for (const theme of ["dark", "light"]) {
    await page.locator(".toolbar-right .icon-button").last().click();
    await page.getByRole("combobox", { name: "Theme", exact: true }).click();
    await page
      .getByRole("option", {
        name: theme === "dark" ? "Dark" : "Light",
        exact: true,
      })
      .click();
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 960, height: 640 });
    await left.getByText("Example.zip", { exact: true }).click();
    await page.keyboard.press("Alt+F6");
    await expect(dialog).toBeVisible();
    assert.ok(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth));
    await page.screenshot({ path: `artifacts/native-archive-${theme}.png` });
    await page.keyboard.press("Escape");
  }
  assert.deepEqual(errors, []);
} catch (error) {
  await page
    .screenshot({ path: "artifacts/native-archive-failed.png" })
    .catch(() => {});
  console.error(
    await page
      .locator("body")
      .ariaSnapshot()
      .catch(() => ""),
  );
  throw error;
} finally {
  for (const file of [
    document,
    path.join(destination, "Example", "dated.txt"),
    path.join(source, "source-alias.zip"),
    path.join(destination, "dated.txt"),
  ])
    await fs.chmod(file, 0o666).catch(() => {});
  await instance.close();
}
