// Run with Windows Node; launches its own app, profile and temporary files.
import { expect } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { startNativeTest } from "./native-test-instance.mjs";

const instance = await startNativeTest("smoke", process.argv[2]);
const { page, root: temp } = instance;
const ownedSources = new Set();
let ownedRemoteFolder;
const rpc = (command, args = {}) =>
  page.evaluate(
    ({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args),
    { command, args },
  );
try {
  const src = path.join(temp, "Source"),
    dst = path.join(temp, "Destination");
  await fs.mkdir(src);
  await fs.mkdir(dst);
  await fs.writeFile(path.join(src, "Õunad.txt"), "Tere, maailm!");
  await fs.writeFile(path.join(src, "move-me.txt"), "move payload");
  await fs.writeFile(
    path.join(src, "quick-edit.txt"),
    Buffer.from("\ufeffFirst line\r\nSecond line\r\n"),
  );
  await fs.writeFile(
    path.join(src, "preview.html"),
    "<script>window.SC_UNSAFE=true</script>",
  );
  await fs.writeFile(
    path.join(src, "pixel.png"),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jNAAAAABJRU5ErkJggg==",
      "base64",
    ),
  );
  function pdf() {
    const text = "BT /F1 18 Tf 50 700 Td (SuperCommander PDF preview) Tj ET";
    const objects = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
      `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    ];
    let out = "%PDF-1.4\n";
    const offsets = [0];
    for (let i = 0; i < objects.length; i++) {
      offsets.push(Buffer.byteLength(out));
      out += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
    }
    const start = Buffer.byteLength(out);
    out += `xref\n0 6\n0000000000 65535 f \n${offsets
      .slice(1)
      .map((n) => String(n).padStart(10, "0") + " 00000 n \n")
      .join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
    return out;
  }
  await fs.writeFile(path.join(src, "test.pdf"), pdf());
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  assert.equal(
    (await rpc("bootstrap")).networkError,
    null,
    "Windows saved network locations should load without an error",
  );
  async function choose(label, option) {
    await page.getByRole("combobox", { name: label, exact: true }).click();
    await page.getByRole("option", { name: option, exact: true }).click();
  }
  async function navigate(index, value) {
    const pane = page.locator(`[data-pane="${index}"]`);
    await pane.locator(".breadcrumbs").click();
    await pane.locator(".path-form input").fill(value);
    await pane.locator(".path-form input").press("Enter");
    await expect(pane.locator(".breadcrumbs")).toHaveAttribute("title", value);
    return pane;
  }
  async function finished(count) {
    await expect(page.locator(".job-row.completed")).toHaveCount(count, {
      timeout: 20000,
    });
    assert.equal(
      await page.locator(".job-row.failed").count(),
      0,
      await page.locator(".queue-scroll").innerText(),
    );
  }
  let completed = 0;
  await page.reload();
  await expect(page.locator(".app-shell")).toBeVisible({ timeout: 20000 });
  // Keep the interaction assertions independent of the user's Windows language.
  const settingsButton = page.locator(".toolbar-right .icon-button").last();
  await settingsButton.click();
  await page.getByRole("combobox", { name: /^(Language|Keel)$/ }).click();
  await page.getByRole("option", { name: "English", exact: true }).click();
  await choose("Row spacing", "Compact");
  await page.keyboard.press("Escape");
  const left = await navigate(0, src);
  const right = await navigate(1, dst);
  await expect(left.getByText("Õunad.txt", { exact: true })).toBeVisible();
  assert.equal(await left.locator(".pane-error").count(), 0);
  console.log("PASS native bootstrap, streamed listing, Unicode paths");
  await left.getByRole("grid").focus();
  await page.keyboard.press("F9");
  const actionsMenu = page.getByRole("menu", { name: "Actions", exact: true });
  await expect(actionsMenu.getByRole("menuitem").first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(actionsMenu.getByRole("menuitem").nth(1)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(left.getByRole("grid")).toBeFocused();
  await page.keyboard.press("F1");
  const help = page.getByRole("dialog", {
    name: "Keyboard shortcuts",
    exact: true,
  });
  await help
    .getByRole("textbox", { name: "Search shortcuts", exact: true })
    .fill("Ctrl+L");
  await expect(help).toContainText("Go to path");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+l");
  await expect(left.locator(".path-form input")).toBeFocused();
  await page.keyboard.press("Escape");
  console.log(
    "PASS native F9 keyboard menu, searchable F1 reference, Ctrl+L and focus restoration",
  );
  const paging = path.join(src, "Paging");
  await fs.mkdir(paging);
  await Promise.all(
    Array.from({ length: 200 }, (_, i) =>
      fs.writeFile(
        path.join(paging, `file-${String(i).padStart(3, "0")}.txt`),
        "",
      ),
    ),
  );
  await navigate(0, paging);
  await expect(left.locator(".parent-entry")).toBeVisible();
  await left.getByRole("grid").focus();
  await page.keyboard.press("Home");
  await page.keyboard.press("PageDown");
  const pageIndex = Number(
    await left.locator(".file-row.focused").getAttribute("aria-rowindex"),
  );
  assert.ok(pageIndex > 3 && pageIndex < 200);
  await page.keyboard.press("End");
  await expect(left.locator(".file-row.focused")).toContainText("file-199.txt");
  await page.keyboard.press("Home");
  await expect(left.locator(".parent-entry")).toHaveClass(/focused/);
  await expect
    .poll(() => left.locator(".file-scroll").evaluate((e) => e.scrollTop))
    .toBe(0);
  await page.keyboard.press("Enter");
  await expect(left.locator(".breadcrumbs")).toHaveAttribute("title", src);
  console.log(
    "PASS parent navigation and immediate Page Up/Down, Home/End in a virtualized 200-file folder",
  );
  await left.getByRole("grid").focus();
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowDown");
  const firstName = await left
    .locator(".file-row:not(.parent-entry)")
    .first()
    .locator(".file-name")
    .innerText();
  await page.keyboard.press("Insert");
  await expect(left.locator(".file-row.selected")).toHaveCount(1);
  await expect(left.locator(".file-row.selected")).toContainText(firstName);
  await expect(left.locator(".file-row.focused")).not.toContainText(firstName);
  assert.equal(
    (await left.locator(".file-row").first().boundingBox()).height,
    26,
  );
  console.log(
    "PASS MC Insert advances without losing marks; compact 26px rows",
  );

  await left.getByText("Õunad.txt", { exact: true }).click();
  await left.getByText("Õunad.txt", { exact: true }).click({ button: "right" });
  await expect(
    page.getByRole("menu", { name: "File actions", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("F5");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Copy", exact: true })
    .click();
  await finished(++completed);
  assert.equal(
    await fs.readFile(path.join(dst, "Õunad.txt"), "utf8"),
    "Tere, maailm!",
  );
  console.log("PASS copy through UI and real Rust IPC");
  await left.getByRole("grid").focus();
  await page.keyboard.press("Control+Shift+f");
  const folderFilter = left.getByRole("textbox", {
    name: "Filter this folder…",
    exact: true,
  });
  await folderFilter.fill("Õunad");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Control+r");
  await expect(left.locator(".path-toolbar svg.spin")).toHaveCount(0);
  await expect(folderFilter).toHaveValue("Õunad");
  await expect(left.locator(".file-row.selected")).toContainText("Õunad.txt");
  await expect(left.locator(".file-row.focused")).toContainText("Õunad.txt");
  await page.keyboard.press("Control+Shift+f");
  await page.keyboard.press("Escape");
  console.log(
    "PASS refresh preserves the filename filter, marks and keyboard cursor",
  );
  await fs.writeFile(path.join(src, "drag-me.txt"), "drag payload");
  const dragRow = left.getByText("drag-me.txt", { exact: true });
  await expect(dragRow).toBeVisible();
  const dragBounds = await dragRow.boundingBox();
  const dropBounds = await right.locator(".file-scroll").boundingBox();
  await page.mouse.move(dragBounds.x + 5, dragBounds.y + 5);
  await page.mouse.down();
  await page.mouse.move(dropBounds.x + 80, dropBounds.y + 80, { steps: 12 });
  await page.mouse.up();
  await finished(++completed);
  assert.equal(
    await fs.readFile(path.join(dst, "drag-me.txt"), "utf8"),
    "drag payload",
  );
  console.log("PASS native pointer drag between panes");

  await left.getByText("move-me.txt", { exact: true }).click();
  await page.keyboard.press("F6");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Move", exact: true })
    .click();
  await finished(++completed);
  assert.equal(
    await fs.readFile(path.join(dst, "move-me.txt"), "utf8"),
    "move payload",
  );
  await assert.rejects(fs.stat(path.join(src, "move-me.txt")));
  console.log("PASS safe cross-folder move");

  await left.getByText("Õunad.txt", { exact: true }).click();
  await page.keyboard.press("F2");
  await page
    .getByRole("dialog")
    .getByRole("textbox", { name: "New name" })
    .fill("renamed.txt");
  await expect(
    page
      .getByRole("dialog")
      .getByRole("button", { name: "Apply", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Apply", exact: true })
    .click();
  await expect(left.getByText("renamed.txt", { exact: true })).toBeVisible();
  console.log("PASS rename preview and apply");
  await left.getByText("quick-edit.txt", { exact: true }).click();
  await page.keyboard.press("F4");
  let fileEditor = page.getByRole("dialog");
  await expect(
    fileEditor.getByRole("textbox", { name: "File contents", exact: true }),
  ).toHaveValue("First line\nSecond line\n");
  await fileEditor
    .getByRole("textbox", { name: "File contents", exact: true })
    .fill("Õunad\nSecond line\nEdited in SuperCommander\n");
  await page.keyboard.press("F5");
  await page.keyboard.press("Control+r");
  await expect(
    fileEditor.getByRole("textbox", { name: "File contents", exact: true }),
  ).toHaveValue("Õunad\nSecond line\nEdited in SuperCommander\n");
  await page.keyboard.press("F2");
  await expect(fileEditor).toContainText("Saved");
  assert.equal(
    await fs.readFile(path.join(src, "quick-edit.txt"), "utf8"),
    "\ufeffÕunad\r\nSecond line\r\nEdited in SuperCommander\r\n",
  );
  await page.keyboard.press("Control+f");
  await fileEditor
    .getByRole("textbox", { name: "Find text", exact: true })
    .fill("Second");
  await page.keyboard.press("Enter");
  assert.equal(
    await fileEditor
      .locator("textarea")
      .evaluate((el) => el.value.slice(el.selectionStart, el.selectionEnd)),
    "Second",
  );
  await page.keyboard.press("F8");
  await expect(fileEditor.locator(".text-surface")).toHaveClass(/wrapped/);
  await page.keyboard.press("F10");
  console.log(
    "PASS F4 editor, F2 atomic save, UTF-8 BOM/CRLF preservation, find, word wrap and F10",
  );

  await left.getByText("preview.html", { exact: true }).click();
  await page.keyboard.press("F3");
  await expect(
    page
      .getByRole("dialog")
      .getByRole("textbox", { name: "File viewer", exact: true }),
  ).toHaveValue(/<script>/);
  assert.equal(await page.evaluate(() => window.SC_UNSAFE), undefined);
  await page.keyboard.press("Escape");
  await left.getByText("pixel.png", { exact: true }).click();
  await page.keyboard.press("F3");
  await expect(
    page.getByRole("dialog").locator(".preview-body>img"),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await left.getByText("test.pdf", { exact: true }).click();
  await page.keyboard.press("F3");
  await expect(page.getByRole("dialog").locator("canvas")).toBeVisible({
    timeout: 20000,
  });
  await expect(page.getByRole("dialog").locator(".pdf-controls")).toContainText(
    "1 / 1",
  );
  await page.keyboard.press("Escape");
  console.log("PASS inert HTML, image and PDF previews");

  await left.getByText("renamed.txt", { exact: true }).click();
  await page.locator(".titlebar-tools .menu-anchor>button").click();
  await page.getByRole("menuitem", { name: /^Create ZIP/ }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Create ZIP", exact: true })
    .click();
  await finished(++completed);
  await expect(left.getByText("renamed.zip", { exact: true })).toBeVisible();
  await left.getByText("renamed.zip", { exact: true }).click();
  await page.locator(".titlebar-tools .menu-anchor>button").click();
  await page.getByRole("menuitem", { name: /^Extract ZIP/ }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Extract ZIP", exact: true })
    .click();
  await finished(++completed);
  assert.equal(
    await fs.readFile(path.join(dst, "renamed.txt"), "utf8"),
    "Tere, maailm!",
  );
  console.log("PASS ZIP creation and extraction");

  await left.getByRole("grid").focus();
  await page.keyboard.press("Control+f");
  await page
    .getByRole("dialog")
    .getByRole("textbox", { name: "Filename contains" })
    .fill("renamed");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Search", exact: true })
    .click();
  await expect(page.getByRole("dialog").locator(".search-result")).toHaveCount(
    2,
  );
  await page.keyboard.press("Escape");
  console.log("PASS recursive filename search");

  const fixtureFile = fileURLToPath(
    new URL("../artifacts/sftp-fixture.json", import.meta.url),
  );
  let fixture;
  try {
    fixture = JSON.parse(await fs.readFile(fixtureFile, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  if (fixture) {
    const name = `smoke-${randomUUID()}`;
    ownedRemoteFolder = path.join(path.dirname(fixture.keyPath), name);
    await fs.mkdir(ownedRemoteFolder);
    await fs.writeFile(
      path.join(ownedRemoteFolder, "remote-only.txt"),
      "A file from the SSH server",
    );
    fixture = {
      ...fixture,
      path: fixture.path.slice(0, fixture.path.lastIndexOf("/")) + "/" + name,
    };
    const sshConfig = path.join(temp, "config");
    await fs.writeFile(
      sshConfig,
      `# preserved fixture comment\nHost sc-test\n    HostName 127.0.0.1\n    User ${fixture.username}\n    Port ${fixture.port}\n    IdentityFile "${fixture.keyPath.replaceAll("\\", "/")}"\n`,
    );
    await page
      .getByRole("button", { name: "SSH connection catalog", exact: true })
      .click();
    let editor = page.getByRole("dialog");
    await editor
      .getByRole("textbox", { name: "SSH config file", exact: true })
      .fill(sshConfig);
    await editor.getByRole("button", { name: "Load", exact: true }).click();
    await expect(
      editor.getByRole("textbox", {
        name: "SSH connection catalog",
        exact: true,
      }),
    ).toHaveValue(/Host sc-test/);
    const initial = await editor
      .getByRole("textbox", { name: "SSH connection catalog", exact: true })
      .inputValue();
    await editor
      .getByRole("textbox", { name: "SSH connection catalog", exact: true })
      .fill(initial + "\n# edited in SuperCommander\n");
    await editor
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect(
      editor.getByRole("button", { name: "Save changes", exact: true }),
    ).toBeDisabled();
    await expect(
      editor.getByRole("button", { name: "Use this catalog", exact: true }),
    ).toBeEnabled();
    assert.ok(
      (await fs.readFile(sshConfig, "utf8")).includes(
        "# edited in SuperCommander",
      ),
    );
    assert.ok((await fs.readdir(temp)).some((name) => name.endsWith(".bak")));
    await page.keyboard.press("Escape");
    await expect(
      page
        .locator(".sidebar")
        .getByRole("button", { name: "sc-test", exact: true }),
    ).toBeVisible();
    console.log(
      "PASS SSH catalog editor saves only the temporary config and preserves a backup",
    );
    await right.locator(".breadcrumbs").click();
    await right
      .locator(".path-form input")
      .fill(fixture.uri.replace("sftp://", "ssh://"));
    await right.locator(".path-form input").press("Enter");
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Connection name", { exact: true }).fill("sc-form");
    await dialog
      .getByLabel("SSH private key path (optional)", { exact: true })
      .fill(fixture.keyPath);
    await dialog
      .getByRole("button", { name: "Save connection", exact: true })
      .click();
    await expect(dialog).toContainText("Connection saved in SSH config");
    const savedConfig = await fs.readFile(sshConfig, "utf8");
    const savedCatalog = await rpc("read_ssh_config", { path: sshConfig });
    for (const host of savedCatalog.hosts)
      ownedSources.add(`sftp:${host.profile.id}`);
    assert.equal(savedConfig.match(/^Host sc-form$/gm)?.length, 1);
    assert.ok(savedConfig.includes("# preserved fixture comment"));
    await dialog.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(dialog.locator(".host-trust code")).toHaveText(
      fixture.fingerprint,
      { timeout: 20000 },
    );
    await dialog
      .getByRole("button", { name: "Trust and connect", exact: true })
      .click();
    await expect(
      right.getByText("remote-only.txt", { exact: true }),
    ).toBeVisible({ timeout: 20000 });
    await expect(left.locator(".breadcrumbs")).toHaveAttribute("title", src);
    await expect(right.locator(".breadcrumbs")).toHaveAttribute(
      "title",
      fixture.uri,
    );
    await right.locator(".breadcrumbs").click();
    await right
      .locator(".path-form input")
      .fill(`ssh://sc-form${fixture.path}`);
    await right.locator(".path-form input").press("Enter");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(
      right.getByText("remote-only.txt", { exact: true }),
    ).toBeVisible();
    await right.getByText("remote-only.txt", { exact: true }).click();
    await page.keyboard.press("F4");
    fileEditor = page.getByRole("dialog");
    await expect(
      fileEditor.getByRole("textbox", { name: "File contents", exact: true }),
    ).toHaveValue("A file from the SSH server");
    const editorSource = `sftp:${savedCatalog.hosts.find((host) => host.alias === "sc-form").profile.id}`;
    const editorLocation = {
      source: editorSource,
      path: `${fixture.path}/remote-only.txt`,
    };
    const remoteDocument = await rpc("read_document", {
      location: editorLocation,
    });
    assert.equal(typeof remoteDocument.connection, "string");
    await assert.rejects(
      rpc("write_document", {
        location: editorLocation,
        text: "must not be saved",
        revision: remoteDocument.revision,
        format: {
          encoding: remoteDocument.encoding,
          lineEnding: remoteDocument.lineEnding,
        },
        connection: "closed-session",
      }),
      /SSH connection changed/,
    );
    await fileEditor
      .getByRole("textbox", { name: "File contents", exact: true })
      .fill("Edited through the existing SSH connection");
    await page.keyboard.press("Control+s");
    await expect(fileEditor).toContainText("Saved");
    await page.keyboard.press("Control+Shift+s");
    const remoteSaveAs = page.getByRole("dialog", {
      name: "Save As",
      exact: true,
    });
    await remoteSaveAs
      .getByRole("combobox", { name: "Save location", exact: true })
      .click();
    await page
      .getByRole("option", { name: "Local files", exact: true })
      .click();
    const savedLocalCopy = path.join(dst, "remote-editor-copy.txt");
    await remoteSaveAs
      .getByRole("textbox", { name: "File path", exact: true })
      .fill(savedLocalCopy);
    await remoteSaveAs
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect(remoteSaveAs).toHaveCount(0);
    assert.equal(
      await fs.readFile(savedLocalCopy, "utf8"),
      "Edited through the existing SSH connection",
    );
    console.log(
      "PASS remote editor Save As to a local file preserves the remote original",
    );
    await page.keyboard.press("F10");
    await right.getByRole("grid").focus();
    await page.keyboard.press("Control+o");
    const sshTerminal = page.locator(
      '.terminal-panel[data-terminal-source^="sftp:"]',
    );
    await expect(sshTerminal).toBeVisible();
    await sshTerminal.locator(".xterm-helper-textarea").focus();
    await page.keyboard.type(
      "sc_session=SSH_PRESERVED; printf 'SC_REMOTE_%s\\n' \"$(uname -s)\"",
      { delay: 3 },
    );
    await page.keyboard.press("Enter");
    await expect(sshTerminal.locator(".xterm-rows")).toContainText(
      "SC_REMOTE_Linux",
      { timeout: 15000 },
    );
    await page.keyboard.press("Control+o");
    await page.keyboard.press("Control+o");
    await sshTerminal.locator(".xterm-helper-textarea").focus();
    await page.keyboard.type("printf '%s\\n' \"$sc_session\"");
    await page.keyboard.press("Enter");
    await expect(sshTerminal.locator(".xterm-rows")).toContainText(
      "SSH_PRESERVED",
    );
    await sshTerminal
      .locator("header")
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await expect(
      right.getByText("remote-only.txt", { exact: true }),
    ).toBeVisible();
    console.log(
      "PASS remote quick edit and the server's persistent interactive shell on the same SSH session",
    );
    await page.locator(".titlebar-tools .menu-anchor>button").click();
    await page
      .getByRole("menuitem", { name: "Port forwarding", exact: true })
      .click();
    let forward = page.getByRole("dialog");
    await forward
      .getByLabel("Target port", { exact: true })
      .fill(String(fixture.targetPort));
    await forward
      .getByRole("button", { name: "Create tunnel", exact: true })
      .click();
    await expect(forward.locator(".forward-row")).toHaveCount(1);
    const localPort = Number(
      await forward.locator(".forward-row").getAttribute("data-local-port"),
    );
    assert.equal(
      await (
        await fetch(`http://127.0.0.1:${localPort}/`, {
          signal: AbortSignal.timeout(5000),
        })
      ).text(),
      "SUPERCOMMANDER_TUNNEL_OK",
    );
    await forward
      .getByRole("button", { name: "Create tunnel", exact: true })
      .click();
    await expect(forward.locator(".forward-row")).toHaveCount(2);
    await forward.getByRole("checkbox").nth(0).click();
    await expect(forward.getByRole("checkbox").nth(0)).toBeChecked();
    await expect
      .poll(
        async () =>
          (await fs.readFile(sshConfig, "utf8")).match(/LocalForward/g)
            ?.length || 0,
      )
      .toBe(1);
    await expect(forward.getByRole("checkbox").nth(1)).toBeEnabled();
    await forward.getByRole("checkbox").nth(1).click();
    await expect
      .poll(
        async () =>
          (await fs.readFile(sshConfig, "utf8")).match(/LocalForward/g)
            ?.length || 0,
      )
      .toBe(2);
    const ports = await forward
      .locator(".forward-row")
      .evaluateAll((rows) => rows.map((r) => Number(r.dataset.localPort)));
    await expect(
      forward.getByRole("button", { name: "Stop", exact: true }).first(),
    ).toBeEnabled();
    await forward
      .getByRole("button", { name: "Stop", exact: true })
      .first()
      .click();
    await expect(
      forward.getByRole("button", { name: "Start", exact: true }),
    ).toBeVisible();
    await forward.getByRole("button", { name: "Start", exact: true }).click();
    await expect(
      forward.getByRole("button", { name: "Stop", exact: true }),
    ).toHaveCount(2);
    const docs = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "docs",
      "screenshots",
    );
    await fs.mkdir(docs, { recursive: true });
    await forward.screenshot({ path: path.join(docs, "port-forwarding.png") });
    await page.keyboard.press("Escape");
    await page.locator(".titlebar-tools .menu-anchor>button").click();
    await page
      .getByRole("menuitem", { name: "Disconnect", exact: true })
      .click();
    await page.locator(".sidebar-item").filter({ hasText: "sc-form" }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Connect", exact: true })
      .click();
    await expect(right.locator(".pane-context")).toContainText(
      fixture.username + "@",
      { timeout: 20000 },
    );
    for (const port of ports)
      assert.equal(
        await (
          await fetch(`http://127.0.0.1:${port}/`, {
            signal: AbortSignal.timeout(5000),
          })
        ).text(),
        "SUPERCOMMANDER_TUNNEL_OK",
      );
    await right.locator(".breadcrumbs").click();
    await right
      .locator(".path-form input")
      .fill(`ssh://sc-form${fixture.path}`);
    await right.locator(".path-form input").press("Enter");
    await expect(
      right.getByText("remote-only.txt", { exact: true }),
    ).toBeVisible();
    console.log(
      "PASS connection form uses SSH config as its only profile store; alias reuses the live SSH connection; localhost tunnel carries HTTP",
    );
    await expect(right.locator(".pane-context")).toContainText(
      fixture.username + "@",
    );
    await left.getByText("renamed.txt", { exact: true }).click();
    await page.keyboard.press("Alt+F5");
    const localArchive = page.getByRole("dialog", {
      name: "Create ZIP",
      exact: true,
    });
    await localArchive
      .getByRole("textbox", { name: "Archive filename", exact: true })
      .fill("with-ssh-pane.zip");
    await localArchive
      .getByRole("button", { name: "Create ZIP", exact: true })
      .click();
    await finished(++completed);
    await fs.access(path.join(src, "with-ssh-pane.zip"));
    await expect(right.locator(".pane-context")).toContainText(
      fixture.username + "@",
    );
    console.log(
      "PASS local Alt+F5 archive creation while the other pane retains its actual authenticated SSH session",
    );
    await left.getByText("drag-me.txt", { exact: true }).click();
    await page.keyboard.press("F5");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Copy", exact: true })
      .click();
    await finished(++completed);
    await expect(right.getByText("drag-me.txt", { exact: true })).toBeVisible();
    await right.getByText("remote-only.txt", { exact: true }).click();
    await page.keyboard.press("F5");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Copy", exact: true })
      .click();
    await finished(++completed);
    assert.equal(
      await fs.readFile(path.join(src, "remote-only.txt"), "utf8"),
      "Edited through the existing SSH connection",
    );
    await page.locator(".titlebar-tools .menu-anchor>button").click();
    await page
      .getByRole("menuitem", { name: "Port forwarding", exact: true })
      .click();
    forward = page.getByRole("dialog");
    await forward
      .getByRole("button", { name: "Remove port", exact: true })
      .first()
      .click();
    await expect(forward.locator(".forward-row")).toHaveCount(1);
    await expect(
      forward.getByRole("button", { name: "Remove port", exact: true }),
    ).toBeEnabled();
    await forward
      .getByRole("button", { name: "Remove port", exact: true })
      .click();
    await expect(forward.locator(".forward-row")).toHaveCount(0);
    await assert.rejects(
      fetch(`http://127.0.0.1:${localPort}/`, {
        signal: AbortSignal.timeout(2000),
      }),
    );
    await page.keyboard.press("Escape");
    await page.locator(".titlebar-tools .menu-anchor>button").click();
    await page
      .getByRole("menuitem", { name: "Disconnect", exact: true })
      .click();
    await expect(right.locator(".pane-context")).not.toContainText(
      fixture.username + "@",
    );
    await navigate(1, dst);
    console.log(
      "PASS SSH path opens the requested panel; authenticated SFTP transfers in both directions",
    );
  }

  await page
    .locator(".queue-panel>header")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await left.getByRole("grid").focus();
  await page
    .locator(".titlebar-tools")
    .getByRole("button", { name: "Terminal", exact: true })
    .click();
  await expect(page.locator(".xterm-rows")).toContainText("PS ", {
    timeout: 20000,
  });
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.type("$v = 'SC_' + 'TERMINAL_OK'; Write-Output $v", {
    delay: 5,
  });
  await page.keyboard.press("Enter");
  await expect(page.locator(".xterm-rows")).toContainText("SC_TERMINAL_OK", {
    timeout: 20000,
  });
  await page
    .locator(".terminal-panel>header")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  console.log("PASS real PowerShell via ConPTY");
  await page.keyboard.press("Control+o");
  await expect(page.locator(".terminal-fullscreen")).toBeVisible();
  await expect(page.locator(".xterm-rows")).toContainText("PS ", {
    timeout: 20000,
  });
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.type("$scSession = 'SESSION_' + 'PRESERVED'", {
    delay: 5,
  });
  await page.keyboard.press("Enter");
  await page.keyboard.press("Control+o");
  await expect(page.locator(".pane-layout")).toBeVisible();
  await page.keyboard.press("Control+o");
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.type("Write-Output $scSession", { delay: 5 });
  await page.keyboard.press("Enter");
  await expect(page.locator(".xterm-rows")).toContainText("SESSION_PRESERVED");
  await page.keyboard.press("Control+o");
  console.log(
    "PASS Ctrl+O restores panels and preserves the live PowerShell session",
  );

  await left.getByText("renamed.txt", { exact: true }).click();
  await page.keyboard.press("F8");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Move to the Recycle Bin?", exact: true })
    .click();
  await finished(++completed);
  await assert.rejects(fs.stat(path.join(src, "renamed.txt")));
  console.log("PASS Windows Recycle Bin");
  assert.ok(
    (await page.locator(".job-row.completed").first().boundingBox()).height <=
      34,
  );
  await page
    .locator(".toolbar-right")
    .getByRole("button", { name: "Settings", exact: true })
    .click();
  await choose("Theme", "Light");
  await page.keyboard.press("Escape");
  await expect(page.locator(".app-shell")).toHaveAttribute(
    "data-theme",
    "light",
  );
  await expect(page.locator(".global-search")).toHaveCSS(
    "color",
    "rgb(109, 128, 157)",
  );
  console.log("PASS light theme and compact transfer rows");

  const shot =
    process.env.SC_SCREENSHOT ||
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "artifacts",
      "windows-smoke.png",
    );
  await fs.mkdir(path.dirname(shot), { recursive: true });
  await page.screenshot({ path: shot });
  console.log("SCREENSHOT", shot);
  assert.deepEqual(pageErrors, []);
  console.log("PASS no WebView JavaScript errors");
  console.log("WINDOWS SMOKE PASSED");
} finally {
  try {
    await page.keyboard.press("Escape").catch(() => {});
    for (const source of ownedSources)
      await rpc("disconnect_sftp", { source }).catch(() => {});
    const terminal = page.locator(".terminal-panel");
    if (await terminal.count()) {
      if (!(await terminal.isVisible()))
        await page
          .locator(".titlebar-tools")
          .getByRole("button", { name: "Terminal", exact: true })
          .click();
      await terminal
        .locator("header")
        .getByRole("button", { name: "Close", exact: true })
        .click()
        .catch(() => {});
    }
  } finally {
    try {
      if (ownedRemoteFolder)
        await fs.rm(ownedRemoteFolder, { recursive: true, force: true });
    } finally {
      await instance.close();
    }
  }
}
