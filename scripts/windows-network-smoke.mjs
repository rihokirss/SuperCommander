import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
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
const boot = await rpc("bootstrap");
const original = boot.settings;
const directory = await fs.mkdtemp(
  "\\\\wsl.localhost\\Ubuntu\\tmp\\supercommander-network-",
);
try {
  assert.equal(boot.networkError, null);
  console.log(`PASS Explorer locations loaded: ${boot.network.length}`);
  await fs.mkdir(path.join(directory, "Network test folder"));
  await rpc("save_settings", {
    value: {
      ...original,
      language: "en",
      workspaceCollapsed: false,
      collapsedGroups: [],
    },
  });
  await page.reload();
  await expect(page.locator(".app-shell")).toBeVisible();
  await page
    .getByRole("button", { name: "Network locations", exact: true })
    .click();
  let dialog = page.getByRole("dialog");
  await dialog
    .getByRole("textbox", { name: "Location name", exact: true })
    .fill("Network UI test");
  await dialog
    .getByRole("textbox", { name: "Network path", exact: true })
    .fill(directory);
  await dialog
    .getByRole("button", { name: "Add location", exact: true })
    .click();
  await dialog
    .locator(".network-open")
    .filter({ hasText: "Network UI test" })
    .click();
  const left = page.locator('[data-pane="0"]');
  await expect(
    left.getByText("Network test folder", { exact: true }),
  ).toBeVisible({ timeout: 15000 });
  await expect
    .poll(async () =>
      (await rpc("bootstrap")).settings.networkLocations?.some(
        (p) => p.path === directory,
      ),
    )
    .toBe(true);
  await page.reload();
  const saved = page
    .locator(".sidebar-item")
    .filter({ hasText: "Network UI test" });
  await expect(saved).toBeVisible();
  await page
    .getByRole("button", { name: "Collapse workspace", exact: true })
    .click();
  await saved.hover();
  await expect(page.getByRole("tooltip")).toHaveCount(1);
  await expect(saved).not.toHaveAttribute("title");
  await page
    .getByRole("button", { name: "Expand workspace", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Network locations", exact: true })
    .click();
  dialog = page.getByRole("dialog");
  await dialog
    .getByRole("button", { name: "Edit Network UI test", exact: true })
    .click();
  await dialog
    .getByRole("textbox", { name: "Location name", exact: true })
    .fill("Renamed network test");
  await dialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await dialog
    .getByRole("button", {
      name: "Remove location Renamed network test",
      exact: true,
    })
    .click();
  await expect(
    dialog
      .locator(".network-location")
      .filter({ hasText: "Renamed network test" }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  console.log(
    "PASS native add, open UNC folder, persist, rename, remove and a single collapsed-sidebar tooltip",
  );
  await left.locator(".breadcrumbs").click();
  await left.locator(".path-form input").fill("\\\\wsl.localhost");
  await left.locator(".path-form input").press("Enter");
  await expect(left.getByText("Ubuntu", { exact: true })).toBeVisible({
    timeout: 30000,
  });
  await left.getByText("Ubuntu", { exact: true }).dblclick();
  await expect(left.getByText("home", { exact: true })).toBeVisible({
    timeout: 15000,
  });
  await left.getByRole("grid").focus();
  await page.keyboard.press("Home");
  await page.keyboard.press("Enter");
  await expect(left.locator(".breadcrumbs")).toHaveAttribute(
    "title",
    "\\\\wsl.localhost",
  );
  await expect(left.getByText("Ubuntu", { exact: true })).toBeVisible();
  console.log(
    "PASS Windows shell server-root enumeration, opening a share and returning to the server",
  );
} finally {
  await page.keyboard.press("Escape").catch(() => {});
  await rpc("save_settings", { value: original });
  await page.reload();
  await expect(page.locator(".app-shell")).toBeVisible();
  await browser.close();
  await fs.rm(directory, { recursive: true, force: true });
}
