// Capture only the browser preview's fictional sample data for public documentation.
import { chromium, expect } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const directory = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "docs",
  "screenshots",
);
await fs.mkdir(directory, { recursive: true });
const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  });
  await page.goto("http://127.0.0.1:1420");
  await expect(page.locator(".app-shell")).toBeVisible();
  const right = page.locator('[data-pane="1"]');
  await right.locator(".breadcrumbs").click();
  await right.locator(".path-form input").fill("C:\\Users\\Alex\\Documents");
  await right.locator(".path-form input").press("Enter");
  const left = page.locator('[data-pane="0"]');
  await left.getByRole("grid").focus();
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Insert");
  await page.keyboard.press("ArrowDown");
  await page.mouse.move(600, 34);
  await page.screenshot({ path: path.join(directory, "dark.png") });
  await page
    .locator(".toolbar-right")
    .getByRole("button", { name: "Settings", exact: true })
    .click();
  await page.getByRole("combobox", { name: "Theme", exact: true }).click();
  await page.getByRole("option", { name: "Light", exact: true }).click();
  await page.keyboard.press("Escape");
  await left.getByRole("grid").focus();
  await page.mouse.move(600, 34);
  await page.screenshot({ path: path.join(directory, "light.png") });
  console.log(`Screenshots: ${directory}`);
} finally {
  await browser.close();
}
