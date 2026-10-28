// Own temporary files only; never writes the clipboard or the user's SSH config.
import { expect } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startNativeTest } from "./native-test-instance.mjs";

const instance = await startNativeTest("properties", process.argv[2]);
const { page, root } = instance;
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(error.message));
const rpc = (command, args = {}) =>
  page.evaluate(
    ({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args),
    { command, args },
  );
const alpha = path.join(root, "alpha.txt"),
  beta = path.join(root, "beta.txt");
const folder = path.join(root, "Assets");
const left = page.locator('[data-pane="0"]'),
  right = page.locator('[data-pane="1"]');
const dialog = page.getByRole("dialog", { name: "Properties", exact: true });
const manager = page.getByRole("dialog", {
  name: "Manage bookmarks",
  exact: true,
});
const location = (p) => ({ source: "local", path: p });
const properties = (p) => rpc("get_properties", { location: location(p) });
async function change(p, changes) {
  const info = await properties(p);
  return rpc("apply_properties", {
    location: location(p),
    revision: info.revision,
    changes,
  });
}
async function inspect(name) {
  await left.getByText(name, { exact: true }).click();
  await left.getByRole("grid").focus();
  await page.keyboard.press("Alt+Enter");
  await expect(
    dialog.getByRole("button", { name: "Refresh", exact: true }),
  ).toBeEnabled();
}
async function close() {
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
}
async function openPath(pane, value) {
  await pane.locator(".breadcrumbs").click();
  await pane.locator(".path-form input").fill(value);
  await pane.locator(".path-form input").press("Enter");
}
let ownedSource, directSource;
try {
  await fs.mkdir(folder);
  await fs.writeFile(alpha, "Alpha contents");
  await fs.writeFile(beta, "Beta contents");
  await fs.writeFile(path.join(folder, "asset.txt"), "12345");
  await fs.symlink(root, path.join(folder, "cycle"), "junction");
  const original = (await rpc("bootstrap")).settings;
  const panes = original.panes.map((p) => ({
    ...p,
    activeTab: p.tabs[0].id,
    tabs: p.tabs.map((tab, i) =>
      i
        ? tab
        : {
            ...tab,
            location: location(root),
            history: [location(root)],
            historyIndex: 0,
          },
    ),
  }));
  await rpc("save_settings", {
    value: {
      ...original,
      panes,
      language: "en",
      theme: "dark",
      workspaceCollapsed: false,
      collapsedGroups: [],
      bookmarks: [],
      showHidden: true,
    },
  });
  await page.reload();
  await expect(left.getByText("alpha.txt", { exact: true })).toBeVisible();
  await inspect("alpha.txt");
  await dialog
    .getByRole("checkbox", { name: "Read-only (files)", exact: true })
    .check();
  await dialog
    .getByRole("checkbox", { name: "Hidden attribute", exact: true })
    .check();
  await dialog
    .getByRole("button", { name: "Apply changes", exact: true })
    .click();
  await expect
    .poll(async () => {
      const info = await properties(alpha);
      return [info.readonly, info.hidden];
    })
    .toEqual([true, true]);
  await expect(
    dialog.getByRole("button", { name: "Apply changes", exact: true }),
  ).toBeDisabled();
  await close();
  await change(alpha, { readonly: false, hidden: false });
  await inspect("alpha.txt");
  await change(alpha, { hidden: true });
  await dialog
    .getByRole("checkbox", { name: "Read-only (files)", exact: true })
    .check();
  await dialog
    .getByRole("button", { name: "Apply changes", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText("changed");
  assert.equal((await properties(alpha)).readonly, false);
  const external = "Alpha contents updated externally";
  // Windows rejects CREATE_ALWAYS for an existing hidden file; open it in place.
  await fs.writeFile(alpha, external, { flag: "r+" });
  await dialog.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(dialog.locator(".property-facts")).toContainText(
    `${Buffer.byteLength(external)} B`,
  );
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await close();
  await change(alpha, { hidden: false });
  await fs.writeFile(alpha, "Alpha contents");
  console.log(
    "PASS native Windows read-only/hidden apply, refresh state and stale revision rejection",
  );

  await inspect("Assets");
  await expect(
    dialog.getByRole("checkbox", { name: "Read-only (files)", exact: true }),
  ).toHaveCount(0);
  await dialog
    .getByRole("button", { name: "Calculate folder size", exact: true })
    .click();
  await expect(dialog.locator(".property-facts")).toContainText("5 B");
  await expect(dialog.locator(".property-facts")).toContainText("1 link");
  const junction = await properties(path.join(folder, "cycle"));
  assert.equal(junction.file.isSymlink, true);
  assert.deepEqual(junction.editable, {
    readonly: false,
    hidden: false,
    mode: false,
  });
  await dialog
    .getByRole("checkbox", { name: "Hidden attribute", exact: true })
    .check();
  await dialog
    .getByRole("button", { name: "Apply changes", exact: true })
    .click();
  await expect.poll(async () => (await properties(folder)).hidden).toBe(true);
  assert.equal(
    (await properties(path.join(folder, "asset.txt"))).hidden,
    false,
  );
  await close();
  await change(folder, { hidden: false });
  await change(alpha, { readonly: true });
  await left.getByRole("grid").focus();
  await page.keyboard.press("Control+Shift+a");
  await left.getByText("alpha.txt", { exact: true }).click();
  await left
    .getByText("beta.txt", { exact: true })
    .click({ modifiers: ["Control"] });
  await page.keyboard.press("Alt+Enter");
  await expect(dialog.locator(".property-kind small")).toHaveText("2 items");
  const readonly = dialog.getByRole("checkbox", {
    name: "Read-only (files)",
    exact: true,
  });
  await expect
    .poll(() => readonly.evaluate((el) => el.indeterminate))
    .toBe(true);
  await readonly.click();
  await dialog
    .getByRole("button", { name: "Apply changes", exact: true })
    .click();
  await expect.poll(async () => (await properties(beta)).readonly).toBe(true);
  await readonly.uncheck();
  await dialog
    .getByRole("button", { name: "Apply changes", exact: true })
    .click();
  await expect
    .poll(async () => [
      (await properties(alpha)).readonly,
      (await properties(beta)).readonly,
    ])
    .toEqual([false, false]);
  await close();
  assert.equal(await fs.readFile(alpha, "utf8"), "Alpha contents");
  assert.equal(await fs.readFile(beta, "utf8"), "Beta contents");
  console.log(
    "PASS folder size, nonrecursive hidden attribute and mixed batch attributes without content changes",
  );
  await inspect("alpha.txt");
  await page.screenshot({
    path: fileURLToPath(
      new URL("../artifacts/native-properties.png", import.meta.url),
    ),
    animations: "disabled",
  });
  await close();

  await left.getByRole("grid").focus();
  await page.keyboard.press("Control+d");
  await page.keyboard.press("Control+Shift+d");
  await manager
    .getByRole("button", { name: `Edit ${path.basename(root)}`, exact: true })
    .click();
  await manager
    .getByRole("textbox", { name: "Bookmark name", exact: true })
    .fill("Project files");
  await manager
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await manager
    .getByRole("textbox", { name: "Bookmark name", exact: true })
    .fill("Assets");
  await manager
    .getByRole("textbox", { name: "Folder path or SSH address", exact: true })
    .fill(folder);
  await manager
    .getByRole("button", { name: "Add bookmark", exact: true })
    .click();
  await manager
    .getByRole("button", { name: "Move bookmark up Assets", exact: true })
    .click();
  await page.screenshot({
    path: fileURLToPath(
      new URL("../artifacts/native-bookmarks.png", import.meta.url),
    ),
    animations: "disabled",
  });
  await close();
  await expect
    .poll(async () =>
      (await rpc("bootstrap")).settings.bookmarks.map((b) => b.name),
    )
    .toEqual(["Assets", "Project files"]);
  await page.reload();
  const bookmark = page.locator(".bookmark-item").filter({ hasText: "Assets" });
  await bookmark.focus();
  await page.keyboard.press("Control+Enter");
  await expect(right.locator(".breadcrumbs")).toHaveAttribute("title", folder);
  await expect(right.getByText("asset.txt", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "Collapse workspace", exact: true })
    .click();
  await bookmark.locator("svg").hover();
  await bookmark.focus();
  await expect(page.getByRole("tooltip")).toHaveCount(1);
  await expect(bookmark).not.toHaveAttribute("title");
  await page
    .getByRole("button", { name: "Expand workspace", exact: true })
    .click();
  console.log(
    "PASS persistent named/reordered bookmarks, Ctrl+Enter other pane and one collapsed tooltip",
  );

  // ZIP creation deliberately rejects links; the size/link test above is complete.
  await fs.unlink(path.join(folder, "cycle"));
  await openPath(left, root);
  await left.getByText("Assets", { exact: true }).click();
  await page.locator(".menu-anchor>button").click();
  await page.getByRole("menuitem", { name: /^Create ZIP\s*Alt\+F5$/ }).click();
  const zipDialog = page.getByRole("dialog");
  const archive = path.join(root, "Assets.zip");
  await zipDialog
    .getByRole("textbox", { name: "Destination", exact: true })
    .fill(root);
  await zipDialog
    .getByRole("button", { name: "Create ZIP", exact: true })
    .click();
  await expect
    .poll(() =>
      fs.stat(archive).then(
        (s) => s.size,
        () => 0,
      ),
    )
    .toBeGreaterThan(0);
  await openPath(left, root);
  await left.getByText("Assets.zip", { exact: true }).dblclick();
  await left.getByText("Assets", { exact: true }).dblclick();
  await left.getByRole("grid").focus();
  await page.keyboard.press("Control+d");
  await expect
    .poll(async () =>
      (await rpc("bootstrap")).settings.bookmarks.some(
        (b) => b.source === `zip:${archive}` && b.path === "/Assets",
      ),
    )
    .toBe(true);
  await page.reload();
  const zipBookmark = page
    .locator(".bookmark-item")
    .filter({ hasText: "Assets" })
    .last();
  await zipBookmark.click();
  await expect(left.getByText("asset.txt", { exact: true })).toBeVisible();
  await inspect("asset.txt");
  await expect(
    dialog.getByRole("button", { name: "Apply changes", exact: true }),
  ).toBeDisabled();
  await close();
  console.log(
    "PASS ZIP subfolder bookmark reopens the archive after reload, with read-only properties",
  );

  const fixtureFile = fileURLToPath(
    new URL("../artifacts/sftp-fixture.json", import.meta.url),
  );
  let fixture;
  try {
    fixture = JSON.parse(await fs.readFile(fixtureFile, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (fixture) {
    const config = path.join(root, "ssh_config");
    await fs.writeFile(
      config,
      `Host sc-properties\n HostName 127.0.0.1\n User ${fixture.username}\n Port ${fixture.port}\n IdentityFile "${fixture.keyPath.replaceAll("\\", "/")}"\n`,
    );
    const settings = (await rpc("bootstrap")).settings;
    await rpc("save_settings", {
      value: { ...settings, sshConfigPath: config },
    });
    await page.reload();
    const catalog = await rpc("read_ssh_config", { path: config });
    ownedSource = `sftp:${catalog.hosts[0].profile.id}`;
    await openPath(right, `ssh://sc-properties${fixture.path}`);
    const connect = page.getByRole("dialog");
    await connect.getByRole("button", { name: "Connect", exact: true }).click();
    if (await connect.locator(".host-trust").count()) {
      await expect(connect.locator(".host-trust code")).toHaveText(
        fixture.fingerprint,
      );
      await connect
        .getByRole("button", { name: "Trust and connect", exact: true })
        .click();
    } else {
      await expect
        .poll(
          async () =>
            (await connect.locator(".host-trust").count()) ||
            (await right.getByText("remote-only.txt", { exact: true }).count()),
        )
        .toBeGreaterThan(0);
      if (await connect.locator(".host-trust").count()) {
        await expect(connect.locator(".host-trust code")).toHaveText(
          fixture.fingerprint,
        );
        await connect
          .getByRole("button", { name: "Trust and connect", exact: true })
          .click();
      }
    }
    await expect(
      right.getByText("remote-only.txt", { exact: true }),
    ).toBeVisible({ timeout: 20000 });
    await right.getByRole("grid").focus();
    await page.keyboard.press("Control+d");
    const uri = `sftp://sc-properties${fixture.path}`;
    await expect
      .poll(async () =>
        (await rpc("bootstrap")).settings.bookmarks.some((b) => b.path === uri),
      )
      .toBe(true);
    const remoteLocation = {
      source: ownedSource,
      path: `${fixture.path}/remote-only.txt`,
    };
    const originalMode = (
      await rpc("get_properties", { location: remoteLocation })
    ).mode;
    await right.getByText("remote-only.txt", { exact: true }).click();
    await page.keyboard.press("Alt+Enter");
    const octal = dialog.getByRole("textbox", {
      name: "Octal permissions",
      exact: true,
    });
    await expect(octal).toHaveValue(originalMode.toString(8).padStart(4, "0"));
    await page.screenshot({
      path: fileURLToPath(
        new URL("../artifacts/native-permissions.png", import.meta.url),
      ),
      animations: "disabled",
    });
    await dialog
      .getByRole("checkbox", { name: "Owner · Execute", exact: true })
      .setChecked(!(originalMode & 0o100));
    await dialog
      .getByRole("button", { name: "Apply changes", exact: true })
      .click();
    await expect
      .poll(
        async () =>
          (await rpc("get_properties", { location: remoteLocation })).mode,
      )
      .toBe(originalMode ^ 0o100);
    await octal.fill("0600");
    await dialog
      .getByRole("button", { name: "Apply changes", exact: true })
      .click();
    await expect
      .poll(
        async () =>
          (await rpc("get_properties", { location: remoteLocation })).mode,
      )
      .toBe(0o600);
    await octal.fill(originalMode.toString(8).padStart(4, "0"));
    await dialog
      .getByRole("button", { name: "Apply changes", exact: true })
      .click();
    await expect
      .poll(
        async () =>
          (await rpc("get_properties", { location: remoteLocation })).mode,
      )
      .toBe(originalMode);
    await close();
    // A direct, unsaved connection must also be reusable through its URI bookmark.
    await openPath(right, fixture.uri);
    const directConnect = page.getByRole("dialog");
    await directConnect
      .getByLabel("SSH private key path (optional)", { exact: true })
      .fill(fixture.keyPath);
    await directConnect
      .getByRole("button", { name: "Connect", exact: true })
      .click();
    await expect(directConnect).toHaveCount(0, { timeout: 20000 });
    await expect(
      right.getByText("remote-only.txt", { exact: true }),
    ).toBeVisible({ timeout: 20000 });
    await right.getByRole("grid").focus();
    await page.keyboard.press("Control+d");
    await expect
      .poll(async () =>
        (await rpc("bootstrap")).settings.bookmarks.some(
          (b) => b.path === fixture.uri,
        ),
      )
      .toBe(true);
    const rightPane = (await rpc("bootstrap")).settings.panes[1];
    directSource = rightPane.tabs.find((t) => t.id === rightPane.activeTab)
      .location.source;
    assert.ok(directSource.startsWith("sftp:") && directSource !== ownedSource);
    await openPath(right, root);
    await page
      .locator(".bookmark-item")
      .getByText(path.posix.basename(fixture.path), { exact: true })
      .last()
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(
      right.getByText("remote-only.txt", { exact: true }),
    ).toBeVisible();
    console.log(
      "PASS direct SSH bookmark reuses its existing authenticated connection",
    );
    await page.reload();
    await page
      .locator(".bookmark-item")
      .getByText(path.posix.basename(fixture.path), { exact: true })
      .first()
      .click();
    await expect(
      page.getByRole("dialog").getByLabel("Connection name", { exact: true }),
    ).toHaveValue("sc-properties");
    await close();
    console.log(
      "PASS real SSH permission changes and persistent alias bookmark requesting authentication after reload",
    );
  }
  const saved = (await rpc("bootstrap")).settings;
  await rpc("save_settings", {
    value: {
      ...saved,
      bookmarks: [
        ...saved.bookmarks,
        {
          name: "Case upper",
          path: "\\\\wsl.localhost\\Ubuntu\\tmp\\Folder",
          kind: "bookmark",
        },
        {
          name: "Case lower",
          path: "\\\\wsl.localhost\\Ubuntu\\tmp\\folder",
          kind: "bookmark",
        },
      ],
    },
  });
  await page.reload();
  await expect(
    page.locator(".bookmark-item").getByText("Case upper", { exact: true }),
  ).toBeVisible();
  await expect(
    page.locator(".bookmark-item").getByText("Case lower", { exact: true }),
  ).toBeVisible();
  console.log(
    "PASS reload preserves differently cased UNC bookmarks without contacting their shares",
  );
  assert.deepEqual(pageErrors, [], "No WebView JavaScript errors");
} finally {
  try {
    await page.keyboard.press("Escape").catch(() => {});
    if (ownedSource)
      await rpc("disconnect_sftp", { source: ownedSource }).catch(() => {});
    if (directSource)
      await rpc("disconnect_sftp", { source: directSource }).catch(() => {});
    // Cleanup read-only flags even after a failed assertion.
    for (const p of [alpha, beta])
      await change(p, { readonly: false, hidden: false }).catch(() => {});
    await change(folder, { hidden: false }).catch(() => {});
  } finally {
    await instance.close();
  }
}
