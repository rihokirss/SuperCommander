import { test, expect } from "@playwright/test";
test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".file-row").first()).toBeVisible();
  await page.locator('[data-pane="0"] .file-grid').focus();
});
test("Shift+F2 opens comparison and copied directions can be reviewed entirely by keyboard", async ({
  page,
}) => {
  await page.keyboard.press("Shift+F2");
  const dialog = page.getByRole("dialog", {
    name: "Compare folders",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await expect(
    page.getByRole("dialog", { name: "Rename", exact: true }),
  ).toHaveCount(0);
  await dialog.getByRole("button", { name: "Compare F5", exact: true }).click();
  await expect(dialog.getByRole("option").first()).toBeVisible();
  await dialog.getByRole("listbox").focus();
  await page.keyboard.press("End");
  await page.keyboard.press("Home");
  await expect(dialog.locator(".comparison-row.focused")).toBeVisible();
  await page.keyboard.press("Insert");
  await expect(dialog.locator(".comparison-row.focused")).toBeVisible();
  await dialog
    .getByRole("button", { name: "Clear selection", exact: true })
    .click();
  await dialog
    .getByRole("checkbox", { name: "Select visible differences", exact: true })
    .check();
  await dialog.getByRole("listbox").focus();
  await page.keyboard.press("Control+Enter");
  const review = page.getByRole("dialog", {
    name: "Review copies",
    exact: true,
  });
  await expect(review).toBeVisible();
  await expect(review).toContainText("Previous versions of replaced files");
  await review.locator(".comparison-review-list").focus();
  await page.keyboard.press("End");
  await expect(
    review
      .locator(".comparison-review-row")
      .filter({ hasText: "workspace.code-workspace" }),
  ).toBeInViewport();
  // The browser demo cannot queue native copies through a shortcut either.
  await page.keyboard.press("Control+Enter");
  await expect(review).toBeVisible();
  await expect(page.locator(".job-row")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(review).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await dialog.getByRole("listbox").focus();
  await page.keyboard.press("F1");
  await expect(
    page.getByRole("dialog", { name: "Keyboard shortcuts", exact: true }),
  ).toContainText("Comparison shortcuts");
});
for (const theme of ["dark", "light"]) {
  test(`comparison and review fit a small ${theme} window`, async ({
    page,
  }) => {
    await page.evaluate((theme) => {
      const s = JSON.parse(
        localStorage.getItem("supercommander-preview") || "{}",
      );
      localStorage.setItem(
        "supercommander-preview",
        JSON.stringify({ ...s, theme }),
      );
    }, theme);
    await page.setViewportSize({ width: 960, height: 640 });
    await page.reload();
    await expect(page.locator(".file-row").first()).toBeVisible();
    await page.locator('[data-pane="0"] .file-grid').focus();
    await page.keyboard.press("Shift+F2");
    const dialog = page.getByRole("dialog", {
      name: "Compare folders",
      exact: true,
    });
    await dialog.getByRole("button", { name: "Details", exact: true }).click();
    await dialog
      .getByRole("button", { name: "Compare F5", exact: true })
      .click();
    await expect(dialog.getByRole("option").first()).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: /Review copies/ }),
    ).toBeInViewport();
    expect(
      await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    await page.screenshot({
      path: `artifacts/comparison-${theme}.png`,
      animations: "disabled",
    });
    await dialog.getByRole("listbox").focus();
    await page.keyboard.press("Control+Enter");
    const review = page.getByRole("dialog", {
      name: "Review copies",
      exact: true,
    });
    await expect(review).toBeVisible();
    expect(
      await review.evaluate((el) => el.scrollHeight <= el.clientHeight),
    ).toBe(true);
  });
}

test("F3 opens a retained comparison viewer without handling its opening key twice", async ({
  page,
}) => {
  await page.keyboard.press("Shift+F2");
  const dialog = page.getByRole("dialog", {
    name: "Compare folders",
    exact: true,
  });
  await dialog.getByRole("button", { name: "Compare F5", exact: true }).click();
  const filter = dialog.getByRole("textbox", {
    name: "Filter paths…",
    exact: true,
  });
  await filter.fill("README.md");
  await expect(dialog.getByRole("option").first()).toBeVisible();
  await dialog.getByRole("listbox").focus();
  await page.keyboard.press("F3");
  await expect(page.getByRole("dialog")).toHaveCount(2);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(filter).toHaveValue("README.md");
});
