import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".file-row").first()).toBeVisible();
  await page.locator('[data-pane="0"] .file-grid').focus();
  await page.keyboard.press("Control+Shift+r");
  await expect(
    page.getByRole("dialog", {
      name: "Recovery & previous versions",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator(".recovery-row")).toHaveCount(5);
});

test("recovery selects, filters and reviews without allowing browser writes", async ({
  page,
}) => {
  const dialog = page.getByRole("dialog", {
    name: "Recovery & previous versions",
    exact: true,
  });
  await expect(
    dialog.getByRole("textbox", { name: "Restore as", exact: true }),
  ).toHaveValue("Notes.txt");
  const list = dialog.getByRole("listbox", { name: "Saved copy", exact: true });
  await list.focus();
  await page.keyboard.press("ArrowDown");
  await expect(
    dialog.getByRole("textbox", { name: "Restore as", exact: true }),
  ).toHaveValue("Recovered");
  await page.keyboard.press("Home");
  await page.keyboard.press("Enter");
  const review = page.getByRole("dialog", {
    name: "Review restoration",
    exact: true,
  });
  await expect(review).toBeVisible();
  await expect(review.locator(".recovery-review-row")).toContainText(
    "Notes.txt",
  );
  await expect(
    review.getByRole("button", { name: "Restore", exact: true }),
  ).toBeDisabled();
  await review.locator(".recovery-review-list").focus();
  await page.keyboard.press("Control+Enter");
  await expect(review).toBeVisible();
  await expect(page.locator(".job-row")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await list.focus();
  await page.keyboard.press("Control+f");
  await expect(
    dialog.getByRole("textbox", { name: "Filter saved copies…", exact: true }),
  ).toBeFocused();
  await page.keyboard.type("Project");
  await expect(dialog.locator(".recovery-row")).toHaveCount(1);
  await expect(
    dialog.getByRole("textbox", { name: "Restore as", exact: true }),
  ).toHaveValue("Project");
  await page.keyboard.press("F1");
  await expect(
    page.getByRole("dialog", { name: "Keyboard shortcuts", exact: true }),
  ).toBeVisible();
});

test("in-use copies and missing payloads cannot be restored, and removal needs confirmation", async ({
  page,
}) => {
  const dialog = page.getByRole("dialog", {
    name: "Recovery & previous versions",
    exact: true,
  });
  const list = dialog.getByRole("listbox", { name: "Saved copy", exact: true });
  await list.focus();
  await page.keyboard.press("End");
  await expect(
    dialog.getByRole("button", { name: "Review restoration", exact: true }),
  ).toBeDisabled();
  await page.keyboard.press("Delete");
  const removal = page.getByRole("dialog", {
    name: "Remove saved copy",
    exact: true,
  });
  await expect(removal).toBeVisible();
  await expect(
    removal.getByRole("button", { name: "Delete", exact: true }),
  ).toBeDisabled();
  await page.keyboard.press("Control+Enter");
  await expect(page.locator(".job-row")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await list.focus();
  await page.keyboard.press("ArrowUp");
  await expect(
    dialog.getByRole("button", { name: "Review restoration", exact: true }),
  ).toBeDisabled();
  await expect(
    dialog.getByRole("button", { name: "Remove saved copy", exact: true }),
  ).toBeDisabled();
  await page.keyboard.press("Delete");
  await expect(removal).toHaveCount(0);
  await page.keyboard.press("Home");
  await page.keyboard.press("F3");
  await expect(page.getByRole("dialog")).toHaveCount(2);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(dialog.locator(".recovery-row")).toHaveCount(5);
});

test("recovery fits small windows in both themes and exposes complete review navigation", async ({
  page,
}) => {
  for (const theme of ["dark", "light"]) {
    await page.setViewportSize({ width: 960, height: 640 });
    await page.locator(".app-shell").evaluate((el, value) => {
      (el as HTMLElement).dataset.theme = value;
    }, theme);
    const dialog = page.getByRole("dialog", {
      name: "Recovery & previous versions",
      exact: true,
    });
    const button = dialog.getByRole("button", {
      name: "Review restoration",
      exact: true,
    });
    await expect(button).toBeVisible();
    const bounds = await dialog.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(640);
    expect(
      await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    await page.screenshot({ path: `artifacts/recovery-${theme}.png` });
    await button.click();
    const review = page.getByRole("dialog", {
      name: "Review restoration",
      exact: true,
    });
    await review.locator(".recovery-review-list").focus();
    await page.keyboard.press("End");
    await expect(review.locator(".recovery-review-row").last()).toBeVisible();
    await page.keyboard.press("Escape");
  }
});
