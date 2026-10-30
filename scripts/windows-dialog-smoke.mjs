import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { expect } from "@playwright/test";
import { startNativeTest } from "./native-test-instance.mjs";

const instance = await startNativeTest("dialog-keys", process.argv[2]);
const { page, root } = instance;
try {
  const file = path.join(root, "delete-only-this-fixture.txt");
  await fs.writeFile(file, "disposable confirmation test");
  const pane = page.locator('[data-pane="0"]');
  await pane.locator(".breadcrumbs").click();
  await pane.locator(".path-form input").fill(root);
  await pane.locator(".path-form input").press("Enter");
  await pane.getByText(path.basename(file), { exact: true }).click();
  await page.keyboard.press("F8");
  let dialog = page.getByRole("dialog", { name: "Move to the Recycle Bin?", exact: true });
  await expect(dialog.locator('button[type="submit"]')).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  await fs.access(file);
  await expect(pane.getByRole("grid")).toBeFocused();
  await page.keyboard.press("Shift+F8");
  dialog = page.getByRole("dialog", { name: "Delete permanently?", exact: true });
  await expect(dialog.locator('button[type="submit"]')).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(dialog.locator('button[type="submit"]')).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => {
    try { await fs.access(file); return true; } catch { return false; }
  }).toBe(false);
  await page.keyboard.press("F7");
  dialog = page.getByRole("dialog", { name: "New folder", exact: true });
  const input = dialog.getByRole("textbox");
  await expect(input).toBeFocused();
  await input.fill("Fixture folder");
  await page.keyboard.press("End");
  await page.keyboard.press("ArrowLeft");
  assert.equal(await input.evaluate((el) => el.selectionStart), 13);
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(dialog.locator('button[type="submit"]')).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  console.log("PASS Windows confirmation default, Enter, arrow cycling, Cancel, focus restoration and text editing keys");
} finally {
  await instance.close();
}
