import { startNativeTest, holdNativeCommand } from "./native-test-instance.mjs";
import { expect } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
const app = await startNativeTest("folder-size", process.argv[2]);
const { page, root } = app;
try {
  const folder = path.join(root, "Folders");
  for (const name of ["Alpha", "Beta", "Empty"])
    await fs.mkdir(path.join(folder, name), { recursive: true });
  await fs.writeFile(path.join(folder, "Alpha", "small.txt"), "123");
  await fs.mkdir(path.join(folder, "Beta", "nested"));
  await fs.writeFile(path.join(folder, "Beta", "data.bin"), Buffer.alloc(2048));
  await fs.writeFile(
    path.join(folder, "Beta", "nested", "more.bin"),
    Buffer.alloc(1024),
  );
  const outside = path.join(root, "Outside");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "unrelated.bin"), Buffer.alloc(9000));
  await fs.symlink(outside, path.join(folder, "Junction"), "junction");
  const pane = page.locator('[data-pane="0"]');
  await pane.locator(".breadcrumbs").click();
  await pane.locator(".path-form input").fill(folder);
  await pane.locator(".path-form input").press("Enter");
  const row = (name) =>
    pane
      .locator(".file-row")
      .filter({ has: page.getByText(name, { exact: true }) });
  const value = (name) => row(name).locator(".file-size");
  await expect(row("Alpha")).toBeVisible();
  await page.keyboard.press("F9");
  await page.getByRole("menuitem", { name: /Calculate folder sizes/ }).click();
  await expect(value("Alpha")).toHaveText("3 B");
  await expect(value("Beta")).toHaveText("3 KB");
  await expect(value("Empty")).toHaveText("0 B");
  // Windows may list the junction as a zero-byte link rather than a directory.
  await expect(value("Junction")).toHaveText(/^(—|0 B)$/);
  await pane.getByRole("columnheader", { name: "Size", exact: true }).click();
  await pane.getByRole("columnheader", { name: "Size", exact: true }).click();
  await expect(
    pane.locator(".file-row:not(.parent-entry)").first().locator(".file-name"),
  ).toHaveText("Beta");
  console.log(
    "PASS F9 folder sizes, recursive byte totals, empty folders, skipped junctions and size sorting",
  );
  await fs.writeFile(
    path.join(folder, "Alpha", "small.txt"),
    Buffer.alloc(100),
  );
  await pane.getByRole("grid").focus();
  await page.keyboard.press("Control+r");
  await expect(value("Alpha")).toHaveText("—");
  await row("Alpha").click();
  await page.keyboard.press("Alt+Shift+Enter");
  await expect(value("Alpha")).toHaveText("100 B");
  await expect(value("Beta")).toHaveText("—");
  await page.screenshot({ path: "artifacts/native-folder-sizes.png" });
  await pane.getByRole("grid").focus();
  await page.keyboard.press("Control+Shift+a");
  const gate = await holdNativeCommand(page, "calculate_folder_sizes");
  await page.evaluate(() => {
    const real = window.fetch;
    window.__sizeCancelled = false;
    window.__sizeDone = false;
    window.fetch = async function (input, init) {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const result = await real.call(window, input, init);
      if (url.endsWith("/cancel_search")) window.__sizeCancelled = true;
      if (url.endsWith("/calculate_folder_sizes")) window.__sizeDone = true;
      return result;
    };
  });
  await page.keyboard.press("Alt+Shift+Enter");
  await gate.entered();
  await pane.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.__sizeCancelled))
    .toBe(true);
  await gate.release();
  await expect.poll(() => page.evaluate(() => window.__sizeDone)).toBe(true);
  await expect(value("Alpha")).toHaveText("—");
  await expect(pane.locator(".size-scan")).toHaveCount(0);
  console.log(
    "PASS selected-folder shortcut, refresh invalidation and acknowledged cancellation before worker registration",
  );
} finally {
  await app.close();
}
