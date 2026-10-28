// Owns its process, settings, WebView profile and test files. No desktop clipboard.
import { expect } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { startNativeTest } from "./native-test-instance.mjs";

const instance = await startNativeTest("recovery", process.argv[2]);
const { page, root } = instance;
const rpc = (command, args = {}) =>
  page.evaluate(
    ({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args),
    { command, args },
  );
const local = (path) => ({ source: "local", path });
const sourceFolder = path.join(root, "Saved"),
  targetFolder = path.join(root, "Target");
const connections = new Set(),
  errors = [];
let remoteFolder;
page.on("pageerror", (error) => errors.push(error.message));
async function record(folder, original, data, kind = "backup") {
  const payload = path.join(folder, `.supercommander-${randomUUID()}.${kind}`);
  if (data === null) await fs.mkdir(payload);
  else await fs.writeFile(payload, data);
  const journal = payload + ".recovery.json";
  await fs.writeFile(
    journal,
    JSON.stringify({
      version: 1,
      kind,
      original: path.join(folder, original),
      preserved: payload,
      created: 1793142000,
      checksum:
        data === null ? null : createHash("sha256").update(data).digest("hex"),
    }),
  );
  return { payload, journal };
}
async function events() {
  await page.evaluate(async () => {
    const bridge = window.__TAURI_INTERNALS__;
    window.__recoveryEvents = {};
    const handler = bridge.transformCallback((event) => {
      window.__recoveryEvents[event.payload.id] = event.payload;
    });
    await bridge.invoke("plugin:event|listen", {
      event: "job-progress",
      target: { kind: "Any" },
      handler,
    });
  });
}
async function lastJob(operation) {
  await expect
    .poll(
      () =>
        page.evaluate(
          (op) =>
            Object.values(window.__recoveryEvents).filter(
              (e) => e.state === "completed" && (!op || e.id),
            ).length,
          operation,
        ),
      { timeout: 30000 },
    )
    .toBeGreaterThan(0);
  const jobs = await page.evaluate(() =>
    Object.values(window.__recoveryEvents),
  );
  const failed = jobs.filter((e) => e.state === "failed");
  assert.deepEqual(failed, []);
  return jobs;
}
async function waitFile(file, contents) {
  await expect
    .poll(() => fs.readFile(file, "utf8").catch(() => "<missing>"), {
      timeout: 30000,
    })
    .toBe(contents);
}
async function streamed(command, args) {
  return page.evaluate(
    async ({ command, args }) => {
      const bridge = window.__TAURI_INTERNALS__;
      const batches = [];
      const callback = bridge.transformCallback((message) => {
        if (message.message) batches.push(message.message);
      });
      try {
        const result = await bridge.invoke(command, {
          ...args,
          channel: `__CHANNEL__:${callback}`,
        });
        return { result, batches };
      } finally {
        bridge.unregisterCallback(callback);
      }
    },
    { command, args },
  );
}
async function openRecovery() {
  await page.locator('[data-pane="0"] .file-grid').focus();
  await page.keyboard.press("Control+Shift+r");
  const dialog = page.getByRole("dialog", {
    name: "Recovery & previous versions",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Scan for saved copies", exact: true }),
  ).toBeEnabled();
  return dialog;
}
async function confirm(dialog) {
  await dialog
    .getByRole("button", { name: "Review restoration", exact: true })
    .click();
  const review = page.getByRole("dialog", {
    name: "Review restoration",
    exact: true,
  });
  await expect(review).toBeVisible();
  await review.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(review).toHaveCount(0);
}
try {
  await fs.mkdir(sourceFolder);
  await fs.mkdir(targetFolder);
  const old = await record(sourceFolder, "Document.txt", "previous contents\n");
  await fs.writeFile(
    path.join(sourceFolder, "Document.txt"),
    "current contents\n",
  );
  const directory = await record(
    sourceFolder,
    "Project",
    null,
    "delete-directory",
  );
  await fs.mkdir(path.join(directory.payload, "Empty"));
  for (let i = 0; i < 125; i++)
    await fs.writeFile(
      path.join(directory.payload, `entry-${String(i).padStart(3, "0")}.txt`),
      `item ${i}`,
    );
  await fs.writeFile(
    path.join(directory.payload, "zz-last.txt"),
    "final reviewed entry",
  );
  const orphan = path.join(
    sourceFolder,
    `.supercommander-${randomUUID()}.part`,
  );
  await fs.writeFile(orphan, "unfinished but useful data");
  const missing = await record(sourceFolder, "Missing.txt", "gone");
  await fs.rm(missing.payload);
  const config = path.join(root, "ssh_config");
  await fs.writeFile(config, "");
  const settings = (await rpc("bootstrap")).settings;
  function panes(left) {
    return settings.panes.map((pane, index) => {
      const location = index === 0 ? left : local(targetFolder);
      return {
        ...pane,
        activeTab: pane.tabs[0].id,
        tabs: [
          { ...pane.tabs[0], location, history: [location], historyIndex: 0 },
        ],
      };
    });
  }
  await rpc("save_settings", {
    value: {
      ...settings,
      language: "en",
      theme: "dark",
      sshConfigPath: config,
      panes: panes(local(sourceFolder)),
    },
  });
  await page.reload();
  await events();
  let dialog = await openRecovery();
  await expect(dialog.locator(".recovery-row")).toHaveCount(4);
  await dialog
    .locator(".recovery-row")
    .filter({ hasText: "Document.txt" })
    .click();
  await page.keyboard.press("F3");
  const text = page.locator(".file-workbench textarea");
  await expect(text).toHaveValue("previous contents\n");
  await expect(text).not.toBeEditable();
  await page.keyboard.press("F10");
  await expect(text).toHaveCount(0);
  await expect(dialog.locator(".recovery-row")).toHaveCount(4);
  await dialog
    .getByRole("checkbox", {
      name: "Replace matching files (keep current versions)",
      exact: true,
    })
    .check();
  await page.screenshot({
    path: fileURLToPath(
      new URL("../artifacts/native-recovery.png", import.meta.url),
    ),
  });
  await confirm(dialog);
  await waitFile(
    path.join(sourceFolder, "Document.txt"),
    "previous contents\n",
  );
  assert.equal(await fs.readFile(old.payload, "utf8"), "previous contents\n");
  await fs.access(old.journal);
  const jobs = await lastJob();
  const restored = jobs.find((job) => job.preservedCount === 1);
  assert.ok(
    restored,
    "Restoring over a current version retains it in Transfers",
  );
  assert.equal(restored.preserved[0].source, "local");
  assert.equal(
    await fs.readFile(restored.preserved[0].path, "utf8"),
    "current contents\n",
  );
  await page.keyboard.press("Escape");
  const versions = page
    .locator(".job-row details")
    .filter({ has: page.locator("summary", { hasText: "Previous versions" }) });
  await versions.locator("summary").click();
  await versions
    .getByRole("button", { name: "Recovery & previous versions", exact: true })
    .click();
  dialog = page.getByRole("dialog", {
    name: "Recovery & previous versions",
    exact: true,
  });
  await expect(
    dialog.getByRole("textbox", { name: "Restore as", exact: true }),
  ).toHaveValue("Document.txt");
  await dialog.locator(".recovery-row").filter({ hasText: "Project" }).click();
  await dialog
    .getByRole("textbox", { name: "Restore as", exact: true })
    .fill("Recovered Project");
  await dialog
    .getByRole("combobox", { name: "Destination", exact: true })
    .click();
  await page.getByRole("option", { name: /Other pane's folder/ }).click();
  await dialog
    .getByRole("button", { name: "Review restoration", exact: true })
    .click();
  const review = page.getByRole("dialog", {
    name: "Review restoration",
    exact: true,
  });
  await review.locator(".recovery-review-list").focus();
  await page.keyboard.press("End");
  await expect(review.locator(".recovery-review-row").last()).toContainText(
    "zz-last.txt",
  );
  await page.screenshot({
    path: fileURLToPath(
      new URL("../artifacts/native-recovery-review.png", import.meta.url),
    ),
  });
  await page.keyboard.press("Control+Enter");
  await expect(review).toHaveCount(0);
  await waitFile(
    path.join(targetFolder, "Recovered Project", "zz-last.txt"),
    "final reviewed entry",
  );
  assert.ok(
    (
      await fs.stat(path.join(targetFolder, "Recovered Project", "Empty"))
    ).isDirectory(),
  );
  assert.ok((await fs.stat(directory.payload)).isDirectory());
  await dialog
    .getByRole("button", { name: "Scan for saved copies", exact: true })
    .click();
  await dialog
    .locator(".recovery-row")
    .filter({ hasText: "Missing.txt" })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Review restoration", exact: true }),
  ).toBeDisabled();
  await page.keyboard.press("Delete");
  await page.evaluate(() => {
    const bridge = window.__TAURI_INTERNALS__,
      original = bridge.invoke;
    let resume;
    const gate = new Promise((resolve) => {
      resume = resolve;
    });
    bridge.invoke = async (command, args) => {
      if (command === "remove_recovery") await gate;
      return original(command, args);
    };
    window.__resumeRecovery = () => {
      bridge.invoke = original;
      resume();
    };
  });
  await page
    .getByRole("dialog", { name: "Remove saved copy", exact: true })
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Remove saved copy", exact: true }),
  ).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "Scan for saved copies", exact: true }),
  ).toBeEnabled();
  await page.evaluate(() => window.__resumeRecovery());
  await expect
    .poll(() =>
      fs.access(missing.journal).then(
        () => true,
        () => false,
      ),
    )
    .toBe(false);
  await dialog
    .getByRole("button", { name: "Scan for saved copies", exact: true })
    .click();
  await dialog
    .locator(".recovery-row")
    .filter({ hasText: "Original name unknown" })
    .click();
  await dialog
    .getByRole("textbox", { name: "Restore as", exact: true })
    .fill("Recovered-part.txt");
  await confirm(dialog);
  await waitFile(
    path.join(sourceFolder, "Recovered-part.txt"),
    "unfinished but useful data",
  );
  await fs.access(orphan);
  console.log(
    "PASS native discovery, read-only retained F3, reviewed restoration, previous-version queue link, complete folder review, empty folders, orphan copies and missing-record cleanup",
  );

  // A changed record invalidates a prepared plan before it can enter the queue.
  const scan = await streamed("scan_recovery", {
    id: randomUUID(),
    location: local(sourceFolder),
    recursive: false,
  });
  const item = scan.batches
    .flatMap((batch) => batch.items)
    .find((item) => item.key === old.journal);
  assert.ok(item);
  const planned = await streamed("plan_recovery", {
    id: randomUUID(),
    source: "local",
    options: {
      key: item.key,
      revision: item.revision,
      connection: item.connection,
      destination: local(targetFolder),
      name: "Must-not-exist.txt",
      replace: false,
    },
  });
  await fs.appendFile(old.journal, " ");
  await assert.rejects(
    rpc("enqueue_recovery", { id: randomUUID(), plan: planned.result.id }),
    /changed/,
  );
  await assert.rejects(
    fs.access(path.join(targetFolder, "Must-not-exist.txt")),
  );
  const cancelledScanId = randomUUID();
  await rpc("cancel_search", { id: cancelledScanId });
  const cancelledScan = await streamed("scan_recovery", {
    id: cancelledScanId,
    location: local(sourceFolder),
    recursive: true,
  });
  assert.ok(
    cancelledScan.batches.some((batch) => batch.done && batch.cancelled),
  );
  assert.equal(cancelledScan.batches.flatMap((batch) => batch.items).length, 0);
  const fresh = await streamed("scan_recovery", {
    id: randomUUID(),
    location: local(sourceFolder),
    recursive: false,
  });
  const freshItem = fresh.batches
    .flatMap((batch) => batch.items)
    .find((item) => item.key === old.journal);
  const cancelledPlanId = randomUUID();
  await rpc("cancel_search", { id: cancelledPlanId });
  await assert.rejects(
    streamed("plan_recovery", {
      id: cancelledPlanId,
      source: "local",
      options: {
        key: freshItem.key,
        revision: freshItem.revision,
        connection: freshItem.connection,
        destination: local(targetFolder),
        name: "Must-not-cancel.txt",
        replace: false,
      },
    }),
    /Cancelled/,
  );
  await assert.rejects(
    fs.access(path.join(targetFolder, "Must-not-cancel.txt")),
  );
  console.log(
    "PASS stale recovery records and cancellation before scan/plan registration cannot write restored files",
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
    await page.keyboard.press("Escape");
    const name = "recovery-" + randomUUID();
    remoteFolder = path.join(path.dirname(fixture.keyPath), name);
    await fs.mkdir(remoteFolder);
    const remotePath =
      fixture.path.slice(0, fixture.path.lastIndexOf("/")) + "/" + name;
    const remoteCopy = await record(
      remoteFolder,
      "Remote.txt",
      "saved remote contents",
    );
    await fs.writeFile(
      path.join(remoteFolder, "current.txt"),
      "remote normal file",
    );
    const profile = {
      id: randomUUID(),
      name: "Owned recovery fixture",
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
    const source = "sftp:" + profile.id;
    connections.add(source);
    const remote = { source, path: remotePath };
    await rpc("save_settings", {
      value: {
        ...settings,
        language: "en",
        theme: "dark",
        sshConfigPath: config,
        profiles: [profile],
        trustedHosts: {
          [`${profile.host}:${profile.port}`]: fixture.fingerprint,
        },
        panes: panes(remote),
      },
    });
    await page.reload();
    await events();
    const left = page.locator('[data-pane="0"]');
    await left.locator(".breadcrumbs").click();
    await left
      .locator(".path-form input")
      .fill(
        `sftp://${profile.username}@${profile.host}:${profile.port}${remotePath}`,
      );
    await left.locator(".path-form input").press("Enter");
    await page
      .getByRole("dialog", { name: "New connection", exact: true })
      .getByRole("button", { name: "Connect", exact: true })
      .click();
    await expect(left.getByText("current.txt", { exact: true })).toBeVisible({
      timeout: 20000,
    });
    dialog = await openRecovery();
    await expect(dialog.locator(".recovery-row")).toHaveCount(1);
    await dialog
      .getByRole("textbox", { name: "Restore as", exact: true })
      .fill("Recovered-remote.txt");
    await dialog
      .getByRole("combobox", { name: "Destination", exact: true })
      .click();
    await page.getByRole("option", { name: /Other pane's folder/ }).click();
    await confirm(dialog);
    await waitFile(
      path.join(targetFolder, "Recovered-remote.txt"),
      "saved remote contents",
    );
    await fs.access(remoteCopy.payload);
    await fs.access(remoteCopy.journal);
    const scanned = await streamed("scan_recovery", {
      id: randomUUID(),
      location: remote,
      recursive: false,
    });
    const remoteItem = scanned.batches.flatMap((batch) => batch.items)[0];
    const tree = await record(
      remoteFolder,
      "Remote tree",
      null,
      "delete-directory",
    );
    await fs.mkdir(path.join(tree.payload, "nested"));
    await fs.writeFile(
      path.join(tree.payload, "saved.txt"),
      "preserve remote tree",
    );
    const trees = await streamed("scan_recovery", {
      id: randomUUID(),
      location: remote,
      recursive: false,
    });
    const treeItem = trees.batches
      .flatMap((batch) => batch.items)
      .find((item) => item.entry?.isDir);
    assert.ok(treeItem);
    async function treePlan(destination, name) {
      return (
        await streamed("plan_recovery", {
          id: randomUUID(),
          source,
          options: {
            key: treeItem.key,
            revision: treeItem.revision,
            connection: treeItem.connection,
            destination,
            name,
            replace: false,
          },
        })
      ).result;
    }
    const aliasPlan = await treePlan(
      local(path.join(tree.payload, "nested")),
      "Must-not-copy",
    );
    const aliasId = randomUUID();
    await rpc("enqueue_recovery", { id: aliasId, plan: aliasPlan.id });
    await expect
      .poll(
        () =>
          page.evaluate((id) => window.__recoveryEvents[id]?.state, aliasId),
        { timeout: 30000 },
      )
      .toBe("failed");
    const aliasEvent = await page.evaluate(
      (id) => window.__recoveryEvents[id],
      aliasId,
    );
    assert.ok(
      aliasEvent.errors.some((error) =>
        error.includes("outside the saved copy"),
      ),
    );
    assert.deepEqual(await fs.readdir(path.join(tree.payload, "nested")), []);
    await waitFile(
      path.join(tree.payload, "saved.txt"),
      "preserve remote tree",
    );
    const goodPlan = await treePlan(
      local(targetFolder),
      "Recovered remote tree",
    );
    await rpc("enqueue_recovery", { id: randomUUID(), plan: goodPlan.id });
    await waitFile(
      path.join(targetFolder, "Recovered remote tree", "saved.txt"),
      "preserve remote tree",
    );
    assert.ok(
      (
        await fs.stat(
          path.join(targetFolder, "Recovered remote tree", "nested"),
        )
      ).isDirectory(),
    );
    const plan = await streamed("plan_recovery", {
      id: randomUUID(),
      source,
      options: {
        key: remoteItem.key,
        revision: remoteItem.revision,
        connection: remoteItem.connection,
        destination: local(targetFolder),
        name: "Must-not-reconnect.txt",
        replace: false,
      },
    });
    await rpc("disconnect_sftp", { source });
    await rpc("connect_sftp", {
      profile,
      secret: "",
      expected: fixture.fingerprint,
      configPath: config,
    });
    await assert.rejects(
      rpc("enqueue_recovery", { id: randomUUID(), plan: plan.result.id }),
      /connection changed/,
    );
    await assert.rejects(
      fs.access(path.join(targetFolder, "Must-not-reconnect.txt")),
    );
    console.log(
      "PASS real SSH discovery of Windows-namespace records, file/tree recovery, UNC/SFTP descendant alias rejection and replacement-session rejection",
    );
  }
  assert.deepEqual(errors, []);
} catch (error) {
  await page
    .screenshot({
      path: fileURLToPath(
        new URL("../artifacts/native-recovery-failed.png", import.meta.url),
      ),
    })
    .catch(() => {});
  console.error(
    await page
      .getByRole("dialog")
      .allTextContents()
      .catch(() => []),
  );
  throw error;
} finally {
  for (const source of connections)
    await rpc("disconnect_sftp", { source }).catch(() => {});
  await instance.close();
  if (remoteFolder)
    await fs.rm(remoteFolder, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 200,
    });
}
