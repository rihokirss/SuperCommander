import { expect } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startNativeTest } from "./native-test-instance.mjs";

const instance = await startNativeTest("search", process.argv[2]);
const { page, root } = instance;
const rpc = (command, args = {}) =>
  page.evaluate(
    ({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args),
    { command, args },
  );
const search = page.getByRole("dialog", { name: "Search", exact: true });
const left = page.locator('[data-pane="0"]');
const view = page.getByRole("textbox", { name: "File viewer", exact: true });
const edit = page.getByRole("textbox", { name: "File contents", exact: true });
const errors = [];
let remoteFile;
page.on("pageerror", (error) => errors.push(error.message));
async function start(name, content) {
  await search
    .getByRole("textbox", { name: "Filename contains", exact: true })
    .fill(name);
  await search
    .getByRole("textbox", { name: "Containing text", exact: true })
    .fill(content);
  await search.getByRole("button", { name: "Search", exact: true }).click();
  await expect(
    search.getByRole("button", { name: "Search", exact: true }),
  ).toBeEnabled({ timeout: 30000 });
}
async function choose(name) {
  await search
    .locator(".search-result")
    .filter({ has: page.locator("strong", { hasText: name }) })
    .click();
  await search.getByRole("listbox").focus();
}
try {
  const files = path.join(root, "Files");
  await fs.mkdir(path.join(files, "nested"), { recursive: true });
  const text = "First line\r\nÕunad 🚀 NEEDLE here\r\nLast\r\n";
  await fs.writeFile(path.join(files, "one.txt"), text);
  await fs.writeFile(
    path.join(files, "utf16.txt"),
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]),
  );
  await fs.writeFile(
    path.join(files, "nested", "child.log"),
    "First\nNEEDLE child\n",
  );
  await fs.writeFile(
    path.join(files, "large.log"),
    `${"x".repeat(64)}\n`.repeat(90000) + "NEEDLE hugeend",
  );
  await fs.writeFile(
    path.join(files, "binary.bin"),
    Buffer.from([0, 78, 69, 69, 68, 76, 69]),
  );
  const original = (await rpc("bootstrap")).settings;
  const location = { source: "local", path: files };
  const panes = original.panes.map((p) => ({
    ...p,
    activeTab: p.tabs[0].id,
    tabs: p.tabs.map((tab, i) =>
      i ? tab : { ...tab, location, history: [location], historyIndex: 0 },
    ),
  }));
  await rpc("save_settings", {
    value: { ...original, panes, language: "en", theme: "dark" },
  });
  await page.reload();
  await expect(left.getByText("one.txt", { exact: true })).toBeVisible();
  await left.getByRole("grid").focus();
  await page.keyboard.press("Control+f");
  await start("", "needle");
  await expect(search.locator(".search-result")).toHaveCount(4);
  await page.screenshot({
    path: fileURLToPath(
      new URL("../artifacts/native-search.png", import.meta.url),
    ),
    animations: "disabled",
  });
  await expect(search.locator(".search-skip")).toContainText("1");
  await choose("one.txt");
  await page.keyboard.press("F3");
  await expect(view).toHaveValue(/Õunad 🚀 NEEDLE/);
  await expect
    .poll(() =>
      view.evaluate((el) =>
        el.value.slice(el.selectionStart, el.selectionStart + 6),
      ),
    )
    .toBe("NEEDLE");
  await expect(page.locator(".file-workbench .text-toolbar")).toContainText(
    "Line 2",
  );
  await page.keyboard.press("F4");
  await expect(edit).toHaveValue(/^First line\nÕunad/);
  await expect
    .poll(() =>
      edit.evaluate((el) =>
        el.value.slice(el.selectionStart, el.selectionStart + 6),
      ),
    )
    .toBe("NEEDLE");
  await page.keyboard.press("F10");
  await expect(edit).toHaveCount(0);
  await expect(search.locator(".search-result")).toHaveCount(4);
  await expect(search.getByRole("listbox")).toBeFocused();
  console.log(
    "PASS UTF-8/UTF-16 recursive content search, binary skipping, exact Unicode line/column, F3/F4 and returning to results",
  );

  await choose("utf16.txt");
  await page.keyboard.press("F3");
  await expect(view).toHaveValue(/Õunad 🚀 NEEDLE/);
  await expect(page.locator(".file-workbench .text-toolbar")).toContainText(
    "UTF-16 LE",
  );
  await expect(page.locator(".file-workbench .text-toolbar")).toContainText(
    "CRLF",
  );
  await page.keyboard.press("F10");
  await start("large.log", "hugeend");
  await expect(search.locator(".search-result")).toHaveCount(1);
  await search.getByRole("listbox").focus();
  await page.keyboard.press("F3");
  await expect(view).toHaveValue("NEEDLE hugeend");
  await expect(page.locator(".file-workbench .text-toolbar")).toContainText(
    "Line 90001",
  );
  await page.keyboard.press("Control+PageUp");
  await expect(view).toHaveValue(/^x/);
  await page.keyboard.press("Control+PageDown");
  await expect(view).toHaveValue("NEEDLE hugeend");
  await page.keyboard.press("F6");
  const line = page.getByRole("spinbutton", {
    name: "Go to line",
    exact: true,
  });
  await line.fill("1");
  await line.press("Enter");
  await expect(view).toHaveValue(/^x/);
  await expect(page.locator(".file-workbench .text-toolbar")).toContainText(
    "Line 1,",
  );
  await page.keyboard.press("F10");
  await expect(search.locator(".search-result")).toHaveCount(1);
  console.log(
    "PASS matched line beyond 4 MiB, text-page shortcuts and F6 go-to-line across the file",
  );

  await start("child.log", "needle");
  await search.getByRole("listbox").focus();
  await page.keyboard.press("Enter");
  await expect(search).toHaveCount(0);
  await expect(left.locator(".file-row.focused.selected")).toContainText(
    "child.log",
  );
  await expect(left.getByRole("grid")).toBeFocused();
  await page.keyboard.press("Control+f");
  await start("child.log", "needle");
  await page.screenshot({
    path: fileURLToPath(
      new URL("../artifacts/native-search-reveal.png", import.meta.url),
    ),
    animations: "disabled",
  });
  await page.keyboard.press("Escape");
  assert.deepEqual(errors, []);
  let fixture;
  try {
    fixture = JSON.parse(
      await fs.readFile(
        fileURLToPath(
          new URL("../artifacts/sftp-fixture.json", import.meta.url),
        ),
        "utf8",
      ),
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (fixture) {
    remoteFile = path.join(
      path.dirname(fixture.keyPath),
      "files",
      "ssh-search.txt",
    );
    await fs.writeFile(remoteFile, "first\nÕunad 🚀 SSH needle\n");
    const config = path.join(root, "ssh_config");
    await fs.writeFile(config, "");
    await rpc("save_settings", {
      value: { ...(await rpc("bootstrap")).settings, sshConfigPath: config },
    });
    await page.reload();
    await left.locator(".breadcrumbs").click();
    await left.locator(".path-form input").fill(fixture.uri);
    await left.locator(".path-form input").press("Enter");
    const connect = page.getByRole("dialog");
    await connect
      .getByLabel("SSH private key path (optional)", { exact: true })
      .fill(fixture.keyPath);
    await connect.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(connect.locator(".host-trust code")).toHaveText(
      fixture.fingerprint,
      { timeout: 20000 },
    );
    await connect
      .getByRole("button", { name: "Trust and connect", exact: true })
      .click();
    await expect(connect).toHaveCount(0, { timeout: 20000 });
    await expect(
      left.getByText("ssh-search.txt", { exact: true }),
    ).toBeVisible();
    await left.getByRole("grid").focus();
    await page.keyboard.press("Control+f");
    await start("ssh-search.txt", "SSH needle");
    await expect(search.locator(".search-result")).toHaveCount(1);
    await search.getByRole("listbox").focus();
    await page.keyboard.press("F3");
    await expect(view).toHaveValue(/Õunad 🚀 SSH needle/);
    await page.keyboard.press("F10");
    const state = (await rpc("bootstrap")).settings.panes[0];
    const source = state.tabs.find((tab) => tab.id === state.activeTab).location
      .source;
    const remoteLocation = { source, path: `${fixture.path}/ssh-search.txt` };
    const previous = await rpc("get_properties", { location: remoteLocation });
    await rpc("disconnect_sftp", { source });
    await rpc("connect_sftp", {
      profile: {
        id: source.slice(5),
        name: "Search SSH",
        host: fixture.host,
        port: fixture.port,
        username: fixture.username,
        keyPath: fixture.keyPath,
        saveSecret: false,
      },
      secret: "",
      expected: fixture.fingerprint,
      configPath: config,
    });
    await assert.rejects(
      rpc("read_document", {
        location: remoteLocation,
        connection: previous.connection,
      }),
      /connection.*changed/i,
    );
    await search.getByRole("listbox").focus();
    await page.keyboard.press("F3");
    await expect(search.getByRole("alert")).toContainText("connection changed");
    await expect(view).toHaveCount(0);
    await start("ssh-search.txt", "SSH needle");
    await search.getByRole("listbox").focus();
    await page.keyboard.press("F4");
    await expect(edit).toHaveValue("first\nÕunad 🚀 SSH needle\n");
    const changed = "first\nÕunad 🚀 SSH needle changed through search\n";
    await edit.fill(changed);
    await page.keyboard.press("F2");
    await expect.poll(() => fs.readFile(remoteFile, "utf8")).toBe(changed);
    await page.keyboard.press("F10");
    await page.keyboard.press("Escape");
    await expect(
      left
        .locator(".file-row")
        .filter({ has: page.getByText("ssh-search.txt", { exact: true }) })
        .locator(".file-size"),
    ).toHaveText(`${Buffer.byteLength(changed)} B`);
    console.log(
      "PASS real SSH content search and viewing; stale connection results are rejected and a fresh search can edit",
    );
  }
  assert.deepEqual(errors, []);
  console.log(
    "PASS native reveal focuses and marks the file in its containing folder; no WebView errors",
  );
} finally {
  try {
    await instance.close();
  } finally {
    if (remoteFile) await fs.rm(remoteFile, { force: true });
  }
}
