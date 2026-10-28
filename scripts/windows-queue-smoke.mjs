// Disposable process/profile/files. This suite never uses the desktop clipboard.
import { expect } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { startNativeTest } from "./native-test-instance.mjs";
const instance = await startNativeTest("queue", process.argv[2]);
const { page, root } = instance;
const rpc = (command, args = {}) =>
  page.evaluate(
    ({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args),
    { command, args },
  );
const leftPath = path.join(root, "Left"),
  rightPath = path.join(root, "Right");
const left = page.locator('[data-pane="0"]'),
  right = page.locator('[data-pane="1"]');
const holds = new Set(),
  connections = new Set(),
  errors = [];
let uncRoot;
page.on("pageerror", (error) => errors.push(error.message));
async function enqueue(operation, source, paths, folder, conflict = "replace") {
  const id = randomUUID();
  await rpc("enqueue_job", {
    request: {
      id,
      operation,
      source,
      paths,
      destination: { source: "local", path: folder },
      conflict,
    },
  });
  return id;
}
async function wait(id, state = /^(completed|failed|cancelled)$/) {
  await expect
    .poll(() => page.evaluate((id) => window.__queueEvents[id]?.state, id), {
      timeout: 30000,
    })
    .toMatch(state);
  return page.evaluate((id) => window.__queueEvents[id], id);
}
async function hold(folder = rightPath) {
  const name = `hold-${randomUUID()}.txt`,
    file = path.join(root, name);
  await fs.writeFile(file, "hold original");
  await fs.writeFile(path.join(folder, name), "hold destination");
  const id = await enqueue("copy", "local", [file], folder, "ask");
  holds.add(id);
  await wait(id, /^conflict$/);
  return id;
}
async function resume(id) {
  await rpc("cancel_job", { id });
  await wait(id);
  holds.delete(id);
}
async function navigate(pane, location) {
  await pane.locator(".breadcrumbs").click();
  await pane.locator(".path-form input").fill(location);
  await pane.locator(".path-form input").press("Enter");
}
try {
  await fs.mkdir(leftPath);
  await fs.mkdir(rightPath);
  const config = path.join(root, "ssh_config");
  await fs.writeFile(config, "");
  const original = (await rpc("bootstrap")).settings;
  await rpc("save_settings", {
    value: { ...original, language: "en", sshConfigPath: config },
  });
  await page.reload();
  await expect(page.locator(".app-shell")).toBeVisible();
  await navigate(left, leftPath);
  await navigate(right, rightPath);
  await page.evaluate(async () => {
    const bridge = window.__TAURI_INTERNALS__;
    window.__queueEvents = {};
    window.__queueHistory = {};
    const handler = bridge.transformCallback((event) => {
      const e = event.payload;
      window.__queueEvents[e.id] = e;
      (window.__queueHistory[e.id] ||= []).push({
        state: e.state,
        bytes: e.bytes,
        current: e.current,
      });
    });
    await bridge.invoke("plugin:event|listen", {
      event: "job-progress",
      target: { kind: "Any" },
      handler,
    });
  });
  for (const operation of ["copy", "move", "delete", "trash"]) {
    const file = path.join(leftPath, `${operation}.txt`);
    await fs.writeFile(file, "before");
    const time = (await fs.stat(file)).mtime;
    const blocking = await hold();
    const id = await enqueue(operation, "local", [file], rightPath);
    const preserved = path.join(root, `original-${operation}.txt`);
    await fs.rename(file, preserved);
    await fs.writeFile(file, "edited");
    await fs.utimes(file, time, time);
    await resume(blocking);
    const event = await wait(id);
    assert.equal(event.state, "failed", JSON.stringify(event));
    assert.match(event.errors.join(" "), /after queuing/);
    assert.equal(await fs.readFile(file, "utf8"), "edited");
    assert.equal(await fs.readFile(preserved, "utf8"), "before");
    await assert.rejects(fs.stat(path.join(rightPath, `${operation}.txt`)), {
      code: "ENOENT",
    });
  }
  const folder = path.join(leftPath, "selected-folder");
  await fs.mkdir(folder);
  await fs.writeFile(path.join(folder, "one.txt"), "original");
  let blocking = await hold(),
    id = await enqueue("delete", "local", [folder], rightPath);
  await fs.writeFile(
    path.join(folder, "late.txt"),
    "created after confirmation",
  );
  await resume(blocking);
  assert.equal((await wait(id)).state, "failed");
  assert.equal(
    await fs.readFile(path.join(folder, "one.txt"), "utf8"),
    "original",
  );
  assert.equal(
    await fs.readFile(path.join(folder, "late.txt"), "utf8"),
    "created after confirmation",
  );
  const output = path.join(root, "Destination");
  await fs.mkdir(output);
  blocking = await hold(output);
  const file = path.join(leftPath, "redirect.txt");
  await fs.writeFile(file, "must stay here");
  id = await enqueue("move", "local", [file], output);
  await fs.rename(output, path.join(root, "Old-destination"));
  await fs.mkdir(output);
  await resume(blocking);
  assert.equal((await wait(id)).state, "failed");
  assert.equal(await fs.readFile(file, "utf8"), "must stay here");
  assert.deepEqual(await fs.readdir(output), []);
  console.log(
    "PASS native queued copy/move/delete/recycle reject replaced sources, late directory children and replacement destination folders",
  );
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
    const name = "queue-" + randomUUID();
    uncRoot = path.join(path.dirname(fixture.keyPath), name);
    await fs.mkdir(uncRoot);
    const remoteRoot =
      fixture.path.slice(0, fixture.path.lastIndexOf("/")) + "/" + name;
    const small = path.join(uncRoot, "small.txt"),
      large = path.join(uncRoot, "large.bin");
    await fs.writeFile(small, "before");
    const sparse = await fs.open(large, "w");
    await sparse.truncate(128 * 1024 * 1024);
    await sparse.close();
    const uri = `sftp://${fixture.username}@${fixture.host}:${fixture.port}${remoteRoot}`;
    await navigate(left, uri);
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
    await expect(left.getByText("large.bin", { exact: true })).toBeVisible();
    const settings = (await rpc("bootstrap")).settings,
      pane = settings.panes[0],
      source = pane.tabs.find((tab) => tab.id === pane.activeTab).location
        .source;
    connections.add(source);
    blocking = await hold();
    const time = (await fs.stat(small)).mtime;
    id = await enqueue("move", source, [remoteRoot + "/small.txt"], rightPath);
    await fs.writeFile(small, "edited");
    await fs.utimes(small, time, time);
    await resume(blocking);
    const changed = await wait(id);
    assert.equal(changed.state, "failed");
    assert.match(changed.errors.join(" "), /contents changed after queuing/);
    assert.equal(await fs.readFile(small, "utf8"), "edited");
    await left.getByText("large.bin", { exact: true }).click();
    await left.getByRole("grid").focus();
    await page.keyboard.press("F5");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Copy", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const checking = page.locator(".job-row.preparing");
    await expect(checking).toContainText("Checking source files");
    await page.screenshot({
      path: fileURLToPath(
        new URL("../artifacts/native-queue.png", import.meta.url),
      ),
      animations: "disabled",
    });
    await checking.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.locator(".job-row.cancelled")).toHaveCount(1, {
      timeout: 20000,
    });
    const cancelled = await page.evaluate(() =>
      Object.values(window.__queueEvents).find(
        (e) => e.state === "cancelled" && e.current.endsWith("large.bin"),
      ),
    );
    assert.ok(cancelled);
    const history = await page.evaluate(
      (id) => window.__queueHistory[id],
      cancelled.id,
    );
    assert.ok(
      history.every((e) => e.state !== "running"),
      JSON.stringify(history),
    );
    await assert.rejects(fs.stat(path.join(rightPath, "large.bin")), {
      code: "ENOENT",
    });
    assert.equal((await fs.stat(large)).size, 128 * 1024 * 1024);
    assert.ok(
      (await fs.readdir(rightPath)).every(
        (name) => !name.startsWith(".supercommander-"),
      ),
    );
    console.log(
      "PASS real SSH equal-size/equal-time edits and UI cancellation during source inspection before any output is written",
    );
  }
  assert.deepEqual(errors, []);
} catch (error) {
  await page
    .screenshot({
      path: fileURLToPath(
        new URL("../artifacts/native-queue-failed.png", import.meta.url),
      ),
      animations: "disabled",
    })
    .catch(() => {});
  throw Error(error.message);
} finally {
  for (const id of holds) await rpc("cancel_job", { id }).catch(() => {});
  for (const source of connections)
    await rpc("disconnect_sftp", { source }).catch(() => {});
  await instance.close();
  if (uncRoot)
    await fs.rm(uncRoot, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 200,
    });
}
