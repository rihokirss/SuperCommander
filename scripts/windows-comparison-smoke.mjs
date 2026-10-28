// Own process, settings and disposable files; no user clipboard or working window.
import { expect } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { startNativeTest } from "./native-test-instance.mjs";

const instance = await startNativeTest("comparison", process.argv[2]);
const { page, root } = instance;
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const rpc = (command, args = {}) =>
  page.evaluate(
    ({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args),
    { command, args },
  );
const options = {
  content: true,
  recursive: true,
  showHidden: false,
  caseSensitive: true,
  exclude: "",
  maxEntries: 200000,
  timeTolerance: 2,
};
const local = (p) => ({ source: "local", path: p });
const leftPath = path.join(root, "Left"),
  rightPath = path.join(root, "Right");
const connections = new Set();
let uncRoot;
async function compare(left, right, overrides = {}, id = randomUUID()) {
  return page.evaluate(
    async ({ id, left, right, options }) => {
      const bridge = window.__TAURI_INTERNALS__;
      const callback = bridge.transformCallback(() => {});
      try {
        return await bridge.invoke("compare_directories", {
          id,
          left,
          right,
          options,
          channel: `__CHANNEL__:${callback}`,
        });
      } finally {
        bridge.unregisterCallback(callback);
      }
    },
    { id, left, right, options: { ...options, ...overrides } },
  );
}
async function enqueue(result, selections) {
  const id = randomUUID();
  await rpc("enqueue_comparison", {
    id,
    comparison: result.id,
    choices: selections.map(([name, direction]) => ({
      id: result.plan.rows.find((row) => row.path === name).id,
      direction,
    })),
  });
  await expect
    .poll(
      () => page.evaluate((id) => window.__comparisonEvents[id]?.state, id),
      { timeout: 30000 },
    )
    .toMatch(/^(completed|failed|cancelled)$/);
  return page.evaluate((id) => window.__comparisonEvents[id], id);
}
async function navigate(pane, value) {
  await pane.locator(".breadcrumbs").click();
  await pane.locator(".path-form input").fill(value);
  await pane.locator(".path-form input").press("Enter");
}
try {
  await fs.mkdir(leftPath);
  await fs.mkdir(rightPath);
  await fs.mkdir(path.join(leftPath, "new", "empty"), { recursive: true });
  await fs.mkdir(path.join(leftPath, "shared"));
  await fs.mkdir(path.join(rightPath, "shared"));
  await fs.writeFile(
    path.join(leftPath, "left-only.txt"),
    "left reviewed contents",
  );
  await fs.writeFile(
    path.join(rightPath, "right-only.txt"),
    "right reviewed contents",
  );
  await fs.writeFile(
    path.join(leftPath, "new", "child.txt"),
    "new nested data",
  );
  await fs.writeFile(
    path.join(leftPath, "shared", "left-child.txt"),
    "left child",
  );
  await fs.writeFile(
    path.join(rightPath, "shared", "right-child.txt"),
    "right child",
  );
  for (const [directory, content] of [
    [leftPath, "before"],
    [rightPath, "edited"],
  ]) {
    const file = path.join(directory, "same-time.txt");
    await fs.writeFile(file, content);
    await fs.utimes(file, 1700000000, 1700000000);
    await fs.writeFile(
      path.join(directory, "same.bin"),
      Buffer.from([0, 255, 12, 3]),
    );
  }
  for (let i = 0; i < 120; i++)
    await fs.writeFile(
      path.join(leftPath, `review-${String(i).padStart(3, "0")}.txt`),
      `review ${i}`,
    );
  await fs.writeFile(
    path.join(leftPath, "zz-review-last.txt"),
    "last visible review entry",
  );
  const original = (await rpc("bootstrap")).settings;
  const config = path.join(root, "ssh_config");
  await fs.writeFile(config, "");
  const panes = original.panes.map((pane, index) => {
    const location = local(index === 0 ? leftPath : rightPath);
    return {
      ...pane,
      activeTab: pane.tabs[0].id,
      tabs: [
        { ...pane.tabs[0], location, history: [location], historyIndex: 0 },
      ],
    };
  });
  await rpc("save_settings", {
    value: {
      ...original,
      language: "en",
      theme: "dark",
      sshConfigPath: config,
      panes,
    },
  });
  await page.reload();
  await expect(page.locator(".app-shell")).toBeVisible();
  // Navigation uses the application's own validated settings model.
  const left = page.locator('[data-pane="0"]'),
    right = page.locator('[data-pane="1"]');
  await navigate(left, leftPath);
  await navigate(right, rightPath);
  await page.evaluate(async () => {
    const bridge = window.__TAURI_INTERNALS__;
    window.__comparisonEvents = {};
    const handler = bridge.transformCallback((event) => {
      window.__comparisonEvents[event.payload.id] = event.payload;
    });
    await bridge.invoke("plugin:event|listen", {
      event: "job-progress",
      target: { kind: "Any" },
      handler,
    });
  });
  await left.locator(".file-grid").focus();
  await page.keyboard.press("Shift+F2");
  const dialog = page.getByRole("dialog", {
    name: "Compare folders",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Compare F5", exact: true }).click();
  const filter = dialog.getByRole("textbox", {
    name: "Filter paths…",
    exact: true,
  });
  await expect(
    dialog.locator('.comparison-row[data-path="left-only.txt"]'),
  ).toBeVisible();
  await filter.fill("left-only.txt");
  await dialog.getByRole("listbox").focus();
  await page.keyboard.press("F3");
  await expect(page.locator(".file-workbench textarea")).toHaveValue(
    "left reviewed contents",
  );
  await page.keyboard.press("F10");
  await expect(page.locator(".file-workbench textarea")).toHaveCount(0);
  await expect(filter).toHaveValue("left-only.txt");
  await dialog.getByRole("listbox").focus();
  await page.keyboard.press("F4");
  await expect(page.locator(".file-workbench textarea")).toHaveValue(
    "left reviewed contents",
  );
  await expect(page.locator(".file-workbench textarea")).toBeFocused();
  await page.locator(".file-workbench textarea").fill("saved from comparison");
  await page.keyboard.press("Control+s");
  await expect(page.locator(".file-workbench .text-toolbar")).toContainText(
    "Saved",
  );
  assert.equal(
    await fs.readFile(path.join(leftPath, "left-only.txt"), "utf8"),
    "saved from comparison",
  );
  await expect(page.locator(".file-workbench textarea")).toBeEditable();
  await page.keyboard.press("F10");
  await expect(page.locator(".file-workbench textarea")).toHaveCount(0);
  await expect(dialog.locator(".comparison-notice")).toContainText(
    "Compare again",
  );
  await expect(
    dialog.getByRole("button", { name: /Review copies/ }),
  ).toBeDisabled();
  await filter.fill("");
  await dialog.getByRole("listbox").focus();
  await page.keyboard.press("F5");
  await expect(dialog.locator(".comparison-notice")).toHaveCount(0);
  await filter.fill("same-time.txt");
  const changed = dialog.locator('.comparison-row[data-path="same-time.txt"]');
  await expect(changed).toContainText("Different");
  await dialog.getByRole("listbox").focus();
  await page.keyboard.press("Alt+ArrowRight");
  await expect(changed.getByRole("checkbox")).toBeChecked();
  await filter.fill("shared");
  await dialog.getByRole("listbox").focus();
  await page.keyboard.press("Home");
  await page.keyboard.press("Alt+ArrowRight");
  await expect(
    dialog
      .locator('.comparison-row[data-path="shared/left-child.txt"]')
      .getByRole("checkbox"),
  ).toBeChecked();
  await filter.fill("");
  await dialog.getByRole("listbox").focus();
  await page.screenshot({
    path: fileURLToPath(
      new URL("../artifacts/native-comparison.png", import.meta.url),
    ),
    animations: "disabled",
  });
  await page.keyboard.press("Control+Enter");
  const review = page.getByRole("dialog", {
    name: "Review copies",
    exact: true,
  });
  await expect(review).toContainText(leftPath);
  await expect(review).toContainText(rightPath);
  await review.locator(".comparison-review-list").focus();
  await page.keyboard.press("End");
  await expect(
    review
      .locator(".comparison-review-row")
      .filter({ hasText: "zz-review-last.txt" }),
  ).toBeInViewport();
  await page.screenshot({
    path: fileURLToPath(
      new URL("../artifacts/native-comparison-review.png", import.meta.url),
    ),
    animations: "disabled",
  });
  await page.keyboard.press("Control+Enter");
  await expect(review).toHaveCount(0);
  await expect(page.locator(".job-row.completed")).toHaveCount(1, {
    timeout: 60000,
  });
  assert.equal(
    await fs.readFile(path.join(rightPath, "left-only.txt"), "utf8"),
    "saved from comparison",
  );
  assert.equal(
    await fs.readFile(path.join(leftPath, "right-only.txt"), "utf8"),
    "right reviewed contents",
  );
  assert.equal(
    await fs.readFile(path.join(rightPath, "same-time.txt"), "utf8"),
    "before",
  );
  assert.equal(
    await fs.readFile(path.join(rightPath, "new", "child.txt"), "utf8"),
    "new nested data",
  );
  assert.ok(
    (await fs.stat(path.join(rightPath, "new", "empty"))).isDirectory(),
  );
  const completed = await page.evaluate(() =>
    Object.values(window.__comparisonEvents).find(
      (e) => e.state === "completed",
    ),
  );
  assert.equal(completed.preservedCount, 1);
  assert.equal(
    await fs.readFile(completed.preserved[0].path, "utf8"),
    "edited",
  );
  assert.equal(
    JSON.parse(await fs.readFile(completed.preserved[0].record, "utf8"))
      .original,
    path.join(rightPath, "same-time.txt"),
  );
  assert.ok(
    (await fs.readdir(path.join(rightPath, "new"))).every(
      (name) => !name.startsWith(".supercommander-"),
    ),
  );
  console.log(
    "PASS native Shift+F2, exact-content comparison, retained F3/F4, save invalidation, folder directions, complete virtualized review, bidirectional copy and retained previous versions",
  );

  await fs.writeFile(path.join(leftPath, "stale.txt"), "before");
  let result = await compare(local(leftPath), local(rightPath));
  await fs.writeFile(path.join(leftPath, "stale.txt"), "edited");
  const stale = result.plan.rows.find((row) => row.path === "stale.txt");
  await assert.rejects(
    rpc("enqueue_comparison", {
      id: randomUUID(),
      comparison: result.id,
      choices: [{ id: stale.id, direction: "left_to_right" }],
    }),
    /changed since comparison/,
  );
  await assert.rejects(fs.stat(path.join(rightPath, "stale.txt")), {
    code: "ENOENT",
  });
  const early = randomUUID();
  await rpc("cancel_search", { id: early });
  await assert.rejects(
    compare(local(leftPath), local(rightPath), {}, early),
    /Cancelled/,
  );
  result = await compare(local(leftPath), local(rightPath), { maxEntries: 1 });
  assert.ok(result.plan.progress.limited);
  await assert.rejects(
    rpc("enqueue_comparison", {
      id: randomUUID(),
      comparison: result.id,
      choices: [{ id: 0, direction: "left_to_right" }],
    }),
    /expired/,
  );
  result = await compare(local(leftPath), local(rightPath));
  const cancelId = randomUUID();
  await rpc("cancel_job", { id: cancelId });
  await assert.rejects(
    rpc("enqueue_comparison", {
      id: cancelId,
      comparison: result.id,
      choices: [
        {
          id: result.plan.rows.find((row) => row.path === "stale.txt").id,
          direction: "left_to_right",
        },
      ],
    }),
    /Cancelled/,
  );
  await assert.rejects(fs.stat(path.join(rightPath, "stale.txt")), {
    code: "ENOENT",
  });
  console.log(
    "PASS stale reviewed data, partial comparison and cancellation before comparison/preparation cannot write files",
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
    const name = "comparison-" + randomUUID();
    uncRoot = path.join(path.dirname(fixture.keyPath), name);
    await fs.mkdir(uncRoot);
    const remoteRoot =
      fixture.path.slice(0, fixture.path.lastIndexOf("/")) + "/" + name;
    await fs.writeFile(
      path.join(uncRoot, "remote.txt"),
      "remote reviewed payload",
    );
    await fs.writeFile(
      path.join(leftPath, "to-remote.txt"),
      "local reviewed payload",
    );
    const profile = {
      id: randomUUID(),
      name: "Owned comparison fixture",
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
    const remote = { source, path: remoteRoot };
    result = await compare(local(leftPath), remote);
    const event = await enqueue(result, [
      ["remote.txt", "right_to_left"],
      ["to-remote.txt", "left_to_right"],
    ]);
    assert.equal(event.state, "completed", event.errors.join("\n"));
    assert.equal(
      await fs.readFile(path.join(leftPath, "remote.txt"), "utf8"),
      "remote reviewed payload",
    );
    assert.equal(
      await fs.readFile(path.join(uncRoot, "to-remote.txt"), "utf8"),
      "local reviewed payload",
    );
    await fs.writeFile(
      path.join(leftPath, "reconnect.txt"),
      "session-bound data",
    );
    result = await compare(local(leftPath), remote);
    await rpc("disconnect_sftp", { source });
    await rpc("connect_sftp", {
      profile,
      secret: "",
      expected: fixture.fingerprint,
      configPath: config,
    });
    await assert.rejects(
      rpc("enqueue_comparison", {
        id: randomUUID(),
        comparison: result.id,
        choices: [
          {
            id: result.plan.rows.find((row) => row.path === "reconnect.txt").id,
            direction: "left_to_right",
          },
        ],
      }),
      /connection changed/,
    );
    await assert.rejects(fs.stat(path.join(uncRoot, "reconnect.txt")), {
      code: "ENOENT",
    });
    console.log(
      "PASS real SSH content comparison, copies both ways and stale connection rejection after reconnect",
    );
  }
  assert.deepEqual(errors, []);
} catch (error) {
  await page
    .screenshot({
      path: fileURLToPath(
        new URL("../artifacts/native-comparison-failed.png", import.meta.url),
      ),
      animations: "disabled",
    })
    .catch(() => {});
  console.error(
    "Comparison dialogs:",
    await page
      .getByRole("dialog")
      .evaluateAll((nodes) =>
        nodes.map((node) => ({
          name: node.getAttribute("aria-label"),
          text: node.innerText.slice(-600),
        })),
      )
      .catch(() => []),
  );
  throw Error(error.message);
} finally {
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
