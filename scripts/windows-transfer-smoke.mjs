// Own process/profile/files; optional WSL fixture exercises actual UNC ↔ SFTP aliases.
import { expect } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { startNativeTest } from "./native-test-instance.mjs";
const instance = await startNativeTest("transfers", process.argv[2]);
const { page, root } = instance;
const rpc = (command, args = {}) =>
  page.evaluate(
    ({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args),
    { command, args },
  );
const left = page.locator('[data-pane="0"]');
const right = page.locator('[data-pane="1"]');
const errors = [];
const connections = new Set();
let uncRoot;
page.on("pageerror", (e) => errors.push(e.message));
async function navigate(pane, value) {
  await pane.locator(".breadcrumbs").click();
  await pane.locator(".path-form input").fill(value);
  await pane.locator(".path-form input").press("Enter");
}
async function job(
  operation,
  source,
  paths,
  destination,
  conflict = "replace",
) {
  const id = randomUUID();
  await rpc("enqueue_job", {
    request: {
      id,
      operation,
      source,
      paths,
      destination,
      conflict,
      sourceConnection: null,
      destinationConnection: null,
    },
  });
  await expect
    .poll(() => page.evaluate((id) => window.__transferEvents[id]?.state, id), {
      timeout: 30000,
    })
    .toMatch(/^(completed|failed|cancelled)$/);
  return page.evaluate((id) => window.__transferEvents[id], id);
}
try {
  const src = path.join(root, "Source"),
    dest = path.join(root, "Destination");
  await fs.mkdir(src);
  await fs.mkdir(dest);
  await fs.writeFile(path.join(src, "move.txt"), "local UI move");
  await fs.mkdir(path.join(src, "folder", "nested"), { recursive: true });
  await fs.writeFile(
    path.join(src, "folder", "nested", "file.txt"),
    "tree payload",
  );
  const original = (await rpc("bootstrap")).settings;
  const config = path.join(root, "ssh_config");
  await fs.writeFile(config, "");
  await rpc("save_settings", {
    value: { ...original, language: "en", sshConfigPath: config },
  });
  await page.reload();
  await expect(page.locator(".app-shell")).toBeVisible();
  await page.evaluate(async () => {
    window.__transferEvents = {};
    const bridge = window.__TAURI_INTERNALS__;
    const handler = bridge.transformCallback((event) => {
      window.__transferEvents[event.payload.id] = event.payload;
    });
    await bridge.invoke("plugin:event|listen", {
      event: "job-progress",
      target: { kind: "Any" },
      handler,
    });
  });
  await navigate(left, src);
  await navigate(right, dest);
  await expect(left.getByText("move.txt", { exact: true })).toBeVisible();
  await left.getByText("move.txt", { exact: true }).click();
  await page.keyboard.press("F6");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Move", exact: true })
    .click();
  await expect(page.locator(".job-row.completed")).toHaveCount(1);
  assert.equal(
    await fs.readFile(path.join(dest, "move.txt"), "utf8"),
    "local UI move",
  );
  await assert.rejects(fs.stat(path.join(src, "move.txt")), { code: "ENOENT" });
  let event = await job("move", "local", [path.join(src, "folder")], {
    source: "local",
    path: dest,
  });
  assert.equal(event.state, "completed", event.errors.join("\n"));
  assert.equal(
    await fs.readFile(path.join(dest, "folder", "nested", "file.txt"), "utf8"),
    "tree payload",
  );
  await assert.rejects(fs.stat(path.join(src, "folder")), { code: "ENOENT" });
  const cancelledFile = path.join(src, "cancelled.txt");
  await fs.writeFile(cancelledFile, "untouched by early cancellation");
  for (const operation of ["copy", "move", "delete"]) {
    const id = randomUUID();
    await rpc("cancel_job", { id });
    await rpc("enqueue_job", {
      request: {
        id,
        operation,
        source: "local",
        paths: [cancelledFile],
        destination: { source: "local", path: dest },
        conflict: "replace",
      },
    });
    await expect
      .poll(() => page.evaluate((id) => window.__transferEvents[id]?.state, id))
      .toBe("cancelled");
    assert.equal(
      await fs.readFile(cancelledFile, "utf8"),
      "untouched by early cancellation",
    );
    await assert.rejects(fs.stat(path.join(dest, "cancelled.txt")), {
      code: "ENOENT",
    });
  }
  const protectedFile = path.join(src, "protected.txt");
  await fs.writeFile(protectedFile, "protected payload");
  const location = { source: "local", path: protectedFile };
  const before = await rpc("get_properties", { location });
  await rpc("apply_properties", {
    location,
    revision: before.revision,
    changes: { readonly: true, hidden: true },
  });
  event = await job("copy", "local", [protectedFile], {
    source: "local",
    path: dest,
  });
  assert.equal(event.state, "completed", event.errors.join("\n"));
  const attributes = await rpc("get_properties", {
    location: { source: "local", path: path.join(dest, "protected.txt") },
  });
  assert.equal(attributes.readonly, true);
  assert.equal(attributes.hidden, true);
  assert.equal(attributes.file.modified, before.file.modified);
  event = await job("move", "local", [protectedFile], {
    source: "local",
    path: dest,
  });
  assert.equal(event.state, "failed");
  assert.equal(await fs.readFile(protectedFile, "utf8"), "protected payload");
  const writableDest = path.join(root, "Writable destination");
  await fs.mkdir(writableDest);
  event = await job("move", "local", [protectedFile], {
    source: "local",
    path: writableDest,
  });
  assert.equal(event.state, "failed");
  assert.match(event.errors.join("\n"), /Source is read-only/);
  assert.equal(await fs.readFile(protectedFile, "utf8"), "protected payload");
  assert.deepEqual(await fs.readdir(writableDest), []);
  await page.screenshot({
    path: fileURLToPath(
      new URL("../artifacts/native-transfers.png", import.meta.url),
    ),
    animations: "disabled",
  });
  console.log(
    "PASS native F6/directory moves, cancellation before enqueue for copy/move/delete, preserved timestamps/hidden/read-only attributes and read-only move protection",
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
    const name = "transfer-" + randomUUID();
    uncRoot = path.join(path.dirname(fixture.keyPath), name);
    const remoteRoot =
      fixture.path.slice(0, fixture.path.lastIndexOf("/")) + "/" + name;
    await fs.mkdir(uncRoot);
    await fs.writeFile(
      path.join(uncRoot, "alias.txt"),
      "must survive UNC and SFTP",
    );
    const profile = {
      id: randomUUID(),
      name: "Owned transfer fixture",
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
    for (const operation of ["copy", "move"]) {
      event = await job(operation, source, [remoteRoot + "/alias.txt"], {
        source: "local",
        path: uncRoot,
      });
      assert.equal(event.state, "failed", JSON.stringify(event));
      assert.equal(
        await fs.readFile(path.join(uncRoot, "alias.txt"), "utf8"),
        "must survive UNC and SFTP",
      );
      event = await job(operation, "local", [path.join(uncRoot, "alias.txt")], {
        source,
        path: remoteRoot,
      });
      assert.equal(event.state, "failed", JSON.stringify(event));
      assert.equal(
        await fs.readFile(path.join(uncRoot, "alias.txt"), "utf8"),
        "must survive UNC and SFTP",
      );
      assert.deepEqual(await fs.readdir(uncRoot), ["alias.txt"]);
    }
    const folder = path.join(uncRoot, "folder");
    await fs.mkdir(path.join(folder, "child"), { recursive: true });
    for (const populated of [false, true]) {
      if (populated)
        await fs.writeFile(path.join(folder, "payload.txt"), "folder survives");
      for (const target of [uncRoot, path.join(folder, "child")]) {
        event = await job("move", source, [remoteRoot + "/folder"], {
          source: "local",
          path: target,
        });
        assert.equal(event.state, "failed", JSON.stringify(event));
        if (populated)
          assert.equal(
            await fs.readFile(path.join(folder, "payload.txt"), "utf8"),
            "folder survives",
          );
        assert.deepEqual(await fs.readdir(path.join(folder, "child")), []);
      }
    }
    event = await job("move", source, [remoteRoot + "/folder"], {
      source: "local",
      path: dest,
    });
    assert.equal(event.state, "completed", event.errors.join("\n"));
    assert.equal(
      await fs.readFile(path.join(dest, "folder", "payload.txt"), "utf8"),
      "folder survives",
    );
    await assert.rejects(fs.stat(folder), { code: "ENOENT" });
    // The reverse direction also exercises Windows directory claiming/cleanup.
    event = await job("move", "local", [path.join(dest, "folder")], {
      source,
      path: remoteRoot,
    });
    assert.equal(event.state, "completed", event.errors.join("\n"));
    assert.equal(
      await fs.readFile(path.join(folder, "payload.txt"), "utf8"),
      "folder survives",
    );
    assert.ok(
      (await fs.readdir(uncRoot)).every(
        (name) => !name.startsWith(".supercommander-"),
      ),
    );
    console.log(
      "PASS actual UNC ↔ SFTP same-file aliases, empty/populated directory aliases and descendants, normal directory moves both ways, and no abandoned staging files",
    );
  }
  assert.deepEqual(errors, []);
} finally {
  for (const source of connections)
    await rpc("disconnect_sftp", { source }).catch(() => {});
  try {
    await instance.close();
  } finally {
    if (uncRoot)
      await fs.rm(uncRoot, { recursive: true, force: true, maxRetries: 5 });
  }
}
