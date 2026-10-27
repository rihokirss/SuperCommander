import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".file-row").first()).toBeVisible();
});

test("file copy and paste shortcuts use the active pane and preserve Insert marks", async ({
  page,
}) => {
  const left = page.locator('[data-pane="0"]');
  const right = page.locator('[data-pane="1"]');
  await left.getByText("README.md", { exact: true }).click();
  await page.keyboard.press("Control+Insert");
  await expect(page.locator(".toast")).toContainText(
    "Files copied to clipboard: 1",
  );
  await expect(left.locator(".file-row.selected")).toHaveCount(1);
  await expect(left.locator(".cut-entry")).toHaveCount(0);
  await page.keyboard.press("Tab");
  await expect(right.getByRole("grid")).toBeFocused();
  await page.keyboard.press("Shift+Insert");
  await expect(page.locator(".job-row")).toHaveCount(1);
  await expect(page.locator(".job-main")).toContainText("Copy");
  // Browser preview cannot access native files; its queued operation reports this explicitly.
  await expect(page.locator(".job-row.failed")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("cut rows are distinct, Escape cancels a cut and text fields keep their shortcuts", async ({
  page,
}) => {
  const left = page.locator('[data-pane="0"]');
  await left.getByText("README.md", { exact: true }).click();
  await page.keyboard.press("Control+x");
  await expect(left.locator(".cut-entry")).toContainText("README.md");
  await page.keyboard.press("Escape");
  await expect(left.locator(".cut-entry")).toHaveCount(0);
  await expect(left.getByText("README.md", { exact: true })).toBeVisible();
  await page.keyboard.press("Control+l");
  const path = left.locator(".path-form input");
  await path.fill("typed text");
  await path.selectText();
  await page.keyboard.press("Control+x");
  await expect(path).toHaveValue("");
  await expect(left.locator(".cut-entry")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+v");
  await expect(page.locator(".toast")).toContainText(
    "The clipboard does not contain files",
  );
  await expect(page.locator(".job-row")).toHaveCount(0);
});

test("context actions copy the clicked pane's file and expose clipboard shortcuts", async ({
  page,
}) => {
  const right = page.locator('[data-pane="1"]');
  await right
    .getByText("Meeting notes.md", { exact: true })
    .click({ button: "right" });
  const menu = page.getByRole("menu", { name: "File actions", exact: true });
  await expect(
    menu.getByRole("menuitem", { name: /Cut to clipboard/ }),
  ).toContainText("Ctrl+X");
  await menu.getByRole("menuitem", { name: /Cut to clipboard/ }).click();
  await expect(right.locator(".cut-entry")).toContainText("Meeting notes.md");
  await page.keyboard.press("Escape");
  await right.getByText("Meeting notes.md", { exact: true }).click();
  await page.keyboard.press("Control+c");
  await expect(right.locator(".cut-entry")).toHaveCount(0);
  await page.keyboard.press("Tab");
  await page.keyboard.press("Control+v");
  await expect(page.locator(".job-row")).toHaveCount(1);
  await expect(page.locator(".job-main")).toContainText("Copy");
});
