// Own temporary files only. Restores settings, then verifies Save & Close by
// closing the development test window. Restart that test instance afterwards.
import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
assert.equal(process.platform, "win32");
const browser = await chromium.connectOverCDP("http://127.0.0.1:9223");
const page = browser
  .contexts()[0]
  .pages()
  .find((p) => p.url().includes("tauri.localhost"));
const rpc = (command, args = {}) =>
  page.evaluate(
    ({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args),
    { command, args },
  );
const original = (await rpc("bootstrap")).settings;
const root = await fs.mkdtemp(path.join(os.tmpdir(), "SuperCommander-editor-"));
const originalFile = path.join(root, "original.txt");
await fs.writeFile(originalFile, "\ufeffOriginal\r\n");
const existing = path.join(root, "existing.txt");
await fs.writeFile(existing, "old destination");
const panes = original.panes.map((p) => ({
  ...p,
  activeTab: p.tabs[0].id,
  tabs: p.tabs.map((tab, i) => {
    const location = { source: "local", path: root };
    return i === 0
      ? { ...tab, location, history: [location], historyIndex: 0 }
      : tab;
  }),
}));
const text = page.getByRole("textbox", { name: "File contents", exact: true });
const saveAs = page.getByRole("dialog", { name: "Save As", exact: true });
const prompt = page.getByRole("dialog", {
  name: "Save changes before closing?",
  exact: true,
});
async function choose(scope, label, value) {
  await scope.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name: value, exact: true }).click();
}
let restored = false;
try {
  await rpc("save_settings", {
    value: { ...original, language: "en", theme: "dark", panes },
  });
  await page.reload();
  const left = page.locator('[data-pane="0"]');
  await expect(left.getByText("original.txt", { exact: true })).toBeVisible();
  await left.getByRole("grid").focus();
  await page.keyboard.press("Shift+F4");
  await expect(text).toBeEditable();
  await text.fill("Õunad\n🚀\n");
  const editor = page.locator(".file-workbench");
  await choose(editor, "Encoding", "UTF-16 LE");
  await choose(editor, "Line endings", "LF (Unix)");
  await page.keyboard.press("F2");
  await expect(
    saveAs.getByRole("textbox", { name: "File path", exact: true }),
  ).toBeFocused();
  const created = path.join(root, "new-file.txt");
  await saveAs
    .getByRole("textbox", { name: "File path", exact: true })
    .fill(created);
  await saveAs
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(saveAs).toHaveCount(0);
  await expect
    .poll(() =>
      fs.readFile(created).then(
        (b) => b.toString("hex"),
        () => "",
      ),
    )
    .toBe(
      Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from("Õunad\n🚀\n", "utf16le"),
      ]).toString("hex"),
    );
  await page.keyboard.press("F10");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  console.log(
    "PASS native Shift+F4 / F2 creates a file only on save, with UTF-16 LE and LF",
  );

  await left.getByText("original.txt", { exact: true }).click();
  await page.keyboard.press("F4");
  await expect(text).toHaveValue("Original\n");
  await text.fill("Save As contents\n");
  await page.keyboard.press("Control+Shift+s");
  await saveAs
    .getByRole("textbox", { name: "File path", exact: true })
    .fill("copy.txt");
  await saveAs
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(saveAs).toHaveCount(0);
  assert.equal(await fs.readFile(originalFile, "utf8"), "\ufeffOriginal\r\n");
  assert.equal(
    await fs.readFile(path.join(root, "copy.txt"), "utf8"),
    "\ufeffSave As contents\r\n",
  );
  console.log(
    "PASS native Save As accepts a relative name, preserves the original, BOM and CRLF",
  );

  await text.fill("replacement edits");
  await page.keyboard.press("Shift+F2");
  await saveAs
    .getByRole("textbox", { name: "File path", exact: true })
    .fill(existing);
  await saveAs
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  const overwrite = page.getByRole("dialog", {
    name: "Replace the existing file?",
    exact: true,
  });
  await expect(overwrite).toBeVisible();
  await fs.writeFile(existing, "changed by another application");
  await overwrite.getByRole("button", { name: "Replace", exact: true }).click();
  await expect(saveAs.getByRole("alert")).toContainText("changed outside");
  assert.equal(
    await fs.readFile(existing, "utf8"),
    "changed by another application",
  );
  await expect(text).toHaveValue("replacement edits");
  const recovered = path.join(root, "recovered.txt");
  await saveAs
    .getByRole("textbox", { name: "File path", exact: true })
    .fill(recovered);
  await saveAs
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(saveAs).toHaveCount(0);
  console.log(
    "PASS native overwrite confirmation detects external edits and keeps unsaved text recoverable",
  );

  await text.fill("Saved during window close\n");
  await rpc("plugin:window|close", { label: "main" });
  await expect(prompt).toBeVisible();
  await prompt
    .getByRole("button", { name: "Cancel", exact: true })
    .last()
    .click();
  await expect(prompt).toHaveCount(0);
  await expect(text).toHaveValue("Saved during window close\n");
  assert.equal(await fs.readFile(recovered, "utf8"), "\ufeffreplacement edits");
  console.log(
    "PASS native window close requests save/discard/cancel and Cancel preserves the editor and file",
  );
  await fs.mkdir("artifacts", { recursive: true });
  await page.screenshot({ path: "artifacts/native-editor.png" });
  // No settings mutation follows: only saving this test document and closing.
  await rpc("save_settings", { value: original });
  restored = true;
  await rpc("plugin:window|close", { label: "main" });
  await expect(prompt).toBeVisible();
  const closed = page.waitForEvent("close", { timeout: 15000 });
  await prompt
    .getByRole("button", { name: "Save changes", exact: true })
    .click()
    .catch((error) => {
      if (!page.isClosed()) throw error;
    });
  await closed;
  assert.equal(
    await fs.readFile(recovered, "utf8"),
    "\ufeffSaved during window close\r\n",
  );
  console.log(
    "PASS native Save & Close persists edits before destroying the test window",
  );
} finally {
  if (!page.isClosed()) {
    // Discard only this script's own temporary buffer so restoration cannot get
    // stuck behind beforeunload or an inner Save As dialog.
    for (
      let attempt = 0;
      attempt < 5 && (await page.getByRole("dialog").count());
      attempt++
    ) {
      const discard = page.getByRole("button", {
        name: "Discard changes",
        exact: true,
      });
      if (await discard.isVisible()) await discard.click();
      else await page.keyboard.press("Escape");
    }
    await rpc("save_settings", { value: original });
    await page.reload();
    restored = true;
  }
  assert.ok(restored, "Original settings must be restored");
  await browser.close().catch(() => {});
  await fs.rm(root, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 200,
  });
}
