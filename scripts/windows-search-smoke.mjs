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
async function reconnect(source, fixture, config) {
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
    "x HEADMARK 🚀 needle here\n" +
      `${"x".repeat(64)}\n`.repeat(89999) +
      "NEEDLE hugeend",
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
  await page.keyboard.press("F1");
  const viewerHelp = page.getByRole("dialog", {
    name: "Viewer and editor",
    exact: true,
  });
  await expect(viewerHelp).toBeVisible();
  await page.keyboard.press("F3");
  await expect(viewerHelp).toBeVisible();
  await expect(view).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(viewerHelp).toHaveCount(0);
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
  await page.keyboard.press("F8");
  await expect(page.locator(".text-surface")).toHaveClass(/wrapped/);
  await page.keyboard.press("F7");
  const find = page.getByRole("textbox", { name: "Find text", exact: true });
  const selectedText = () =>
    view.evaluate((el) => el.value.slice(el.selectionStart, el.selectionEnd));
  await find.fill("needle");
  await find.press("Enter");
  await expect.poll(selectedText).toBe("needle");
  await expect(page.locator(".file-workbench .text-toolbar")).toContainText(
    "Line 1, Column 14",
  );
  await page.screenshot({
    path: fileURLToPath(
      new URL("../artifacts/native-viewer-find.png", import.meta.url),
    ),
    animations: "disabled",
  });
  await page.keyboard.press("Control+g");
  await expect.poll(selectedText).toBe("NEEDLE");
  await expect(page.locator(".file-workbench .text-toolbar")).toContainText(
    "Line 90001, Column 1",
  );
  await expect(find).toHaveValue("needle");
  await expect(page.locator(".text-surface")).toHaveClass(/wrapped/);
  await page.keyboard.press("Control+g");
  await expect.poll(selectedText).toBe("needle");
  await expect(page.locator(".text-search [role=status]")).toHaveText(
    "Search wrapped",
  );
  await page.keyboard.press("Shift+F7");
  await expect.poll(selectedText).toBe("NEEDLE");
  await expect(page.locator(".text-search [role=status]")).toHaveText(
    "Search wrapped",
  );
  await find.fill("absent phrase");
  await find.press("Enter");
  await expect(page.locator(".text-search [role=status]")).toHaveText(
    "No matches in this file",
  );
  await expect(view).toHaveValue("NEEDLE hugeend");
  // Delay only dispatch, not the native implementation: exercise a query edit
  // cancelling a worker that has not registered yet, and ignore its late reply.
  await page.evaluate(() => {
    const fetch = window.fetch;
    window.fetch = (url, options) =>
      String(url).endsWith("/find_text")
        ? new Promise((resolve, reject) => {
            window.__releaseViewerFind = () => {
              window.fetch = fetch;
              return fetch.call(window, url, options).then(async (response) => {
                window.__viewerFindCancellation = await response.clone().text();
                resolve(response);
              }, reject);
            };
          })
        : fetch.call(window, url, options);
  });
  await find.fill("HEADMARK");
  await find.press("Enter");
  await expect
    .poll(() => page.evaluate(() => typeof window.__releaseViewerFind))
    .toBe("function");
  await expect(
    page
      .locator(".text-search")
      .getByRole("button", { name: "Cancel", exact: true }),
  ).toBeVisible();
  await find.fill("new query after cancellation");
  await expect(
    page
      .locator(".text-search")
      .getByRole("button", { name: "Cancel", exact: true }),
  ).toHaveCount(0);
  await page.evaluate(() => window.__releaseViewerFind());
  await expect
    .poll(() => page.evaluate(() => window.__viewerFindCancellation))
    .toContain("Cancelled");
  await expect(find).toHaveValue("new query after cancellation");
  await expect(view).toHaveValue("NEEDLE hugeend");
  await expect(page.locator(".file-workbench [role=alert]")).toHaveCount(0);
  const largeLocation = {
    source: "local",
    path: path.join(files, "large.log"),
  };
  for (const command of ["find_text", "get_preview"]) {
    const id = `pre-cancel-${command}`;
    await rpc("cancel_search", { id });
    await assert.rejects(
      rpc(command, {
        id,
        location: largeLocation,
        query: "absent",
        from: { line: 1, column: 1 },
        previous: false,
      }),
      /Cancelled/,
    );
  }
  for (const command of ["search_files", "calculate_size"]) {
    await page.evaluate(
      async ({ command, location }) => {
        const bridge = window.__TAURI_INTERNALS__;
        const id = `pre-cancel-${command}`;
        window.__cancelledWorkerBatches = [];
        let finish, timeout;
        const done = new Promise((resolve, reject) => {
          finish = resolve;
          timeout = setTimeout(
            () => reject(Error("Cancelled worker did not finish")),
            10000,
          );
        });
        const callback = bridge.transformCallback((raw) => {
          if (raw.message) window.__cancelledWorkerBatches.push(raw.message);
          if (raw.message?.done) finish();
        });
        try {
          await bridge.invoke("cancel_search", { id });
          await bridge.invoke(command, {
            id,
            location,
            source: location.source,
            paths: [location.path],
            filter: {},
            channel: `__CHANNEL__:${callback}`,
          });
          await done;
        } finally {
          clearTimeout(timeout);
          bridge.unregisterCallback(callback);
        }
      },
      { command, location: { source: "local", path: files } },
    );
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.__cancelledWorkerBatches.some(
            (batch) => batch.done && batch.cancelled,
          ),
        ),
      )
      .toBe(true);
    assert.ok(
      (await page.evaluate(() => window.__cancelledWorkerBatches)).every(
        (batch) => !(batch.found || batch.files || batch.bytes),
      ),
    );
  }
  await page.keyboard.press("F10");
  await expect(search.locator(".search-result")).toHaveCount(1);
  console.log(
    "PASS large-file paging/F6 and whole-file Find in both directions, wrapping, exact Unicode selection, retained query/wrap, no-match status and cancellation before worker registration",
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
    await page.keyboard.press("F7");
    await find.fill("SSH needle");
    await find.press("Enter");
    await expect.poll(selectedText).toBe("SSH needle");
    const state = (await rpc("bootstrap")).settings.panes[0];
    const source = state.tabs.find((tab) => tab.id === state.activeTab).location
      .source;
    const remoteLocation = { source, path: `${fixture.path}/ssh-search.txt` };
    const previous = await rpc("get_properties", { location: remoteLocation });
    await reconnect(source, fixture, config);
    await assert.rejects(
      rpc("read_document", {
        location: remoteLocation,
        connection: previous.connection,
      }),
      /connection.*changed/i,
    );
    await page.keyboard.press("Control+g");
    await expect(page.locator(".file-workbench [role=alert]")).toContainText(
      "connection changed",
    );
    await expect(view).toHaveValue(/Õunad 🚀 SSH needle/);
    await page.keyboard.press("F10");
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
    await left.getByText("ssh-search.txt", { exact: true }).click();
    await page.keyboard.press("F3");
    await expect(view).toHaveValue(/changed through search/);
    await reconnect(source, fixture, config);
    await page.keyboard.press("F4");
    await expect(edit).toBeVisible();
    await expect(edit).not.toBeEditable();
    await expect(page.locator(".file-workbench [role=alert]")).toContainText(
      "connection changed",
    );
    await page.keyboard.press("F10");
    assert.equal(await fs.readFile(remoteFile, "utf8"), changed);
    console.log(
      "PASS real SSH content search and whole-file viewer Find; reconnect blocks ongoing viewer searches, stale results and F3-to-F4 rebinding; fresh results can edit",
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
