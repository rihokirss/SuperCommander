// Owns its app, settings and files; never reads or writes the desktop clipboard.
import { expect } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { holdNativeCommand, startNativeTest } from "./native-test-instance.mjs";

const instance = await startNativeTest("rename", process.argv[2]);
const { page, root } = instance;
const rpc = (command, args = {}) =>
  page.evaluate(
    ({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args),
    { command, args },
  );
const rules = {
  find: "",
  replace: "",
  regex: false,
  caseMode: "keep",
  numbering: false,
  start: 1,
  prefix: "new-",
};
const folder = path.join(root, "Files");
let remoteFolder, remoteSource;
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
try {
  await fs.mkdir(folder);
  await fs.writeFile(path.join(folder, "a.txt"), "before");
  await fs.writeFile(path.join(folder, "b.txt"), "second");
  const settings = (await rpc("bootstrap")).settings;
  const config = path.join(root, "ssh_config");
  await fs.writeFile(config, "");
  async function configure(theme) {
    const location = { source: "local", path: folder };
    await rpc("save_settings", {
      value: {
        ...settings,
        language: "en",
        theme,
        density: "compact",
        sshConfigPath: config,
        panes: settings.panes.map((p) => ({
          ...p,
          activeTab: p.tabs[0].id,
          tabs: [
            { ...p.tabs[0], location, history: [location], historyIndex: 0 },
          ],
        })),
      },
    });
    await page.reload();
    await expect(page.locator(".file-row").first()).toBeVisible();
  }
  await configure("dark");
  const left = page.locator('[data-pane="0"]');
  const dialog = page.getByRole("dialog", { name: "Rename", exact: true });
  async function openRename(name, replacement) {
    await left.getByText(name, { exact: true }).click();
    await page.keyboard.press("F2");
    await dialog
      .getByRole("textbox", { name: "New name", exact: true })
      .fill(replacement);
    await expect(
      dialog.getByRole("button", { name: "Apply", exact: true }),
    ).toBeEnabled();
  }
  await openRename("a.txt", "renamed.txt");
  const old = path.join(folder, "a.txt");
  const time = (await fs.stat(old)).mtime;
  await fs.rename(old, path.join(folder, "kept-original.txt"));
  await fs.writeFile(old, "edited");
  await fs.utimes(old, time, time);
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("source changed");
  await assert.rejects(fs.access(path.join(folder, "renamed.txt")));
  assert.equal(await fs.readFile(old, "utf8"), "edited");
  await page.keyboard.press("F5");
  await expect(
    dialog.getByRole("button", { name: "Apply", exact: true }),
  ).toBeEnabled();
  await page.keyboard.press("Control+Enter");
  await expect(dialog).toHaveCount(0);
  await expect(left.getByText("renamed.txt", { exact: true })).toBeVisible();
  await openRename("renamed.txt", "RENAMED.TXT");
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  assert.ok((await fs.readdir(folder)).includes("RENAMED.TXT"));
  assert.ok(!(await fs.readdir(folder)).includes("renamed.txt"));
  console.log(
    "PASS reviewed replacement guard, Ctrl+Enter apply, safe native case-only rename",
  );

  await openRename("RENAMED.TXT", "cancelled.txt");
  const previewGate = await holdNativeCommand(page, "rename_preview");
  await dialog
    .getByRole("textbox", { name: "New name", exact: true })
    .fill("pending.txt");
  await previewGate.entered();
  await page.keyboard.press("Enter");
  await expect(
    dialog.getByRole("button", { name: "Apply", exact: true }),
  ).toBeDisabled();
  await assert.rejects(fs.access(path.join(folder, "pending.txt")));
  await previewGate.release();
  await expect(
    dialog.getByRole("button", { name: "Apply", exact: true }),
  ).toBeEnabled();
  await page.evaluate(() => {
    const original = window.fetch;
    window.__renameFinished = 0;
    window.fetch = async (input, init) => {
      const result = await original.call(window, input, init);
      if (
        new URL(typeof input === "string" ? input : input.url).pathname ===
        "/rename_apply"
      )
        window.__renameFinished++;
      return result;
    };
  });
  const applyGate = await holdNativeCommand(page, "rename_apply");
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await applyGate.entered();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await applyGate.release();
  await expect.poll(() => page.evaluate(() => window.__renameFinished)).toBe(1);
  await fs.access(path.join(folder, "RENAMED.TXT"));
  await assert.rejects(fs.access(path.join(folder, "pending.txt")));
  const cancelledId = randomUUID();
  await rpc("cancel_search", { id: cancelledId });
  await assert.rejects(
    rpc("rename_preview", {
      id: cancelledId,
      source: "local",
      paths: [path.join(folder, "RENAMED.TXT")],
      rules,
    }),
    /Cancelled/,
  );
  console.log(
    "PASS Enter cannot bypass pending preview; Escape cancels apply before worker registration",
  );

  for (let i = 0; i < 200; i++)
    await fs.writeFile(
      path.join(folder, `entry-${String(i).padStart(3, "0")}.txt`),
      `entry ${i}`,
    );
  const originals = await fs.readdir(folder);
  await page.setViewportSize({ width: 960, height: 640 });
  for (const theme of ["dark", "light"]) {
    await configure(theme);
    await left.getByRole("grid").focus();
    await page.keyboard.press("Control+a");
    await page.keyboard.press("F2");
    await dialog
      .getByRole("textbox", { name: "Prefix", exact: true })
      .fill("done-");
    const apply = dialog.getByRole("button", { name: "Apply", exact: true });
    await expect(apply).toBeEnabled();
    const grid = dialog.getByRole("grid", { name: "Rename", exact: true });
    await expect(grid).toHaveAttribute(
      "aria-rowcount",
      String(originals.length + 1),
    );
    assert.ok(
      (await grid.locator(".rename-row").count()) < 35,
      "The entire review must not be mounted at once",
    );
    await grid.focus();
    await page.keyboard.press("End");
    await expect(grid).toHaveAttribute(
      "aria-activedescendant",
      `rename-row-${originals.length - 1}`,
    );
    await expect(
      grid.locator(`#rename-row-${originals.length - 1}`),
    ).toBeVisible();
    await page.keyboard.press("PageUp");
    await expect(grid).not.toHaveAttribute(
      "aria-activedescendant",
      `rename-row-${originals.length - 1}`,
    );
    await page.keyboard.press("Home");
    await expect(grid).toHaveAttribute("aria-activedescendant", "rename-row-0");
    await page.keyboard.press("F1");
    const help = page.getByRole("dialog", {
      name: "Keyboard shortcuts",
      exact: true,
    });
    await expect(help).toContainText("Enter / Ctrl+Enter");
    await page.keyboard.press("Escape");
    await expect(help).toHaveCount(0);
    await expect(dialog).toBeVisible();
    assert.ok(
      await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth),
      "Review must fit supported window width",
    );
    await expect(
      dialog.getByRole("heading", { name: "Rename", exact: true }),
    ).toBeInViewport();
    await expect(apply).toBeInViewport();
    assert.ok(
      await dialog.evaluate((el) => el.scrollHeight <= el.clientHeight),
      "The normal bulk dialog must fit vertically without hiding its heading or actions",
    );
    await page.screenshot({ path: `artifacts/native-rename-${theme}.png` });
    if (theme === "light") {
      await page.keyboard.press("Control+Enter");
      await expect(dialog).toHaveCount(0);
    } else {
      await page.keyboard.press("Escape");
    }
  }
  for (const name of originals)
    assert.equal(
      await fs.readFile(path.join(folder, `done-${name}`), "utf8"),
      name === "RENAMED.TXT"
        ? "edited"
        : name === "kept-original.txt"
          ? "before"
          : name === "b.txt"
            ? "second"
            : `entry ${Number(name.slice(6, 9))}`,
    );
  console.log(
    "PASS full virtualized bulk review, End/PageUp/Home, contextual help, dark/light 960x640 and all reviewed names applied",
  );

  const fixture = await fs
    .readFile(
      fileURLToPath(new URL("../artifacts/sftp-fixture.json", import.meta.url)),
      "utf8",
    )
    .then(JSON.parse)
    .catch(() => null);
  if (fixture) {
    const name = `rename-${randomUUID()}`;
    remoteFolder = path.join(path.dirname(fixture.keyPath), name);
    await fs.mkdir(remoteFolder);
    const remotePath =
      fixture.path.slice(0, fixture.path.lastIndexOf("/")) + "/" + name;
    await fs.writeFile(
      path.join(remoteFolder, "remote.txt"),
      "remote contents",
    );
    const profile = {
      id: randomUUID(),
      name: "Owned rename fixture",
      host: fixture.host,
      port: fixture.port,
      username: fixture.username,
      keyPath: fixture.keyPath,
      saveSecret: false,
    };
    await rpc("connect_sftp", {
      profile,
      secret: "",
      expected: fixture.fingerprint,
      configPath: config,
    });
    remoteSource = "sftp:" + profile.id;
    const preview = await rpc("rename_preview", {
      id: randomUUID(),
      source: remoteSource,
      paths: [remotePath + "/remote.txt"],
      rules,
    });
    await rpc("rename_apply", { id: randomUUID(), plan: preview.id });
    assert.equal(
      await fs.readFile(path.join(remoteFolder, "new-remote.txt"), "utf8"),
      "remote contents",
    );
    const stale = await rpc("rename_preview", {
      id: randomUUID(),
      source: remoteSource,
      paths: [remotePath + "/new-remote.txt"],
      rules,
    });
    await rpc("disconnect_sftp", { source: remoteSource });
    await rpc("connect_sftp", {
      profile,
      secret: "",
      expected: fixture.fingerprint,
      configPath: config,
    });
    await assert.rejects(
      rpc("rename_apply", { id: randomUUID(), plan: stale.id }),
      /Connection changed/,
    );
    await fs.access(path.join(remoteFolder, "new-remote.txt"));
    await assert.rejects(
      fs.access(path.join(remoteFolder, "new-new-remote.txt")),
    );
    console.log(
      "PASS actual SSH rename and reviewed connection replacement rejection",
    );
  }
  assert.deepEqual(errors, []);
} catch (error) {
  await page
    .screenshot({ path: "artifacts/native-rename-failed.png" })
    .catch(() => {});
  console.error(
    await page
      .locator("body")
      .ariaSnapshot()
      .catch(() => ""),
  );
  throw error;
} finally {
  if (remoteSource)
    await rpc("disconnect_sftp", { source: remoteSource }).catch(() => {});
  if (remoteFolder) await fs.rm(remoteFolder, { recursive: true, force: true });
  await instance.close();
}
