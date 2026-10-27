import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".file-row").first()).toBeVisible();
});
test("search reveals and marks a result even when the pane filter hid it", async ({
  page,
}) => {
  const left = page.locator('[data-pane="0"]');
  const filter = left.getByRole("textbox", {
    name: "Filter this folder…",
    exact: true,
  });
  await filter.fill("logo");
  await page.keyboard.press("Control+f");
  const dialog = page.getByRole("dialog", { name: "Search", exact: true });
  const query = dialog.getByRole("textbox", {
    name: "Filename contains",
    exact: true,
  });
  await expect(query).toBeFocused();
  await query.fill("README");
  await query.press("Enter");
  await expect(dialog.getByRole("option")).toHaveCount(1);
  await query.press("ArrowDown");
  await expect(dialog.getByRole("listbox")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(filter).toHaveValue("");
  await expect(left.locator(".file-row.focused.selected")).toContainText(
    "README.md",
  );
  await expect(left.getByRole("grid")).toBeFocused();
});
test("filename masks, regex errors and Ctrl+Enter work in the other pane", async ({
  page,
}) => {
  await page.keyboard.press("Control+f");
  const dialog = page.getByRole("dialog", { name: "Search", exact: true });
  await dialog
    .getByRole("combobox", { name: "Filename matching", exact: true })
    .click();
  await page
    .getByRole("option", { name: "Wildcard masks", exact: true })
    .click();
  const query = dialog.getByRole("textbox", {
    name: "Filename pattern",
    exact: true,
  });
  await query.fill("*.md");
  await query.press("Enter");
  await expect(dialog.getByRole("option")).toHaveCount(2);
  await dialog
    .getByRole("combobox", { name: "Filename matching", exact: true })
    .click();
  await page
    .getByRole("option", { name: "Regular expression", exact: true })
    .click();
  await query.fill("[");
  await query.press("Enter");
  await expect(dialog.getByRole("alert")).toContainText(/regular expression/i);
  await query.fill("^README\\.md$");
  await query.press("Enter");
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(dialog.getByRole("option")).toHaveCount(1);
  await dialog.getByRole("listbox").focus();
  await page.keyboard.press("Control+Enter");
  const right = page.locator('[data-pane="1"]');
  await expect(right).toHaveClass(/active/);
  await expect(right.locator(".file-row.focused.selected")).toContainText(
    "README.md",
  );
  await expect(right.getByRole("grid")).toBeFocused();
});
test("F4 and F1 return to the retained search results", async ({ page }) => {
  await page.locator('[data-pane="0"] .file-grid').focus();
  await page.keyboard.press("Control+f");
  const dialog = page.getByRole("dialog", { name: "Search", exact: true });
  await dialog
    .getByRole("textbox", { name: "Filename contains", exact: true })
    .fill("README");
  await dialog.getByRole("button", { name: "Search", exact: true }).click();
  await expect(dialog.getByRole("option")).toHaveCount(1);
  await dialog.getByRole("listbox").focus();
  await page.keyboard.press("F4");
  await expect(page.locator(".file-workbench")).toBeVisible();
  await page.keyboard.press("F10");
  await expect(dialog.getByRole("option")).toHaveCount(1);
  await expect(dialog.getByRole("listbox")).toBeFocused();
  await page.keyboard.press("F1");
  const help = page.getByRole("dialog", {
    name: "Keyboard shortcuts",
    exact: true,
  });
  await expect(help).toContainText("Ctrl+Enter");
  await page.keyboard.press("Escape");
  await expect(help).toHaveCount(0);
  await expect(dialog.getByRole("listbox")).toBeFocused();
});
for (const theme of ["dark", "light"]) {
  test(`advanced search fits a small ${theme} window`, async ({ page }) => {
    await page.evaluate((theme) => {
      const settings = JSON.parse(
        localStorage.getItem("supercommander-preview") || "{}",
      );
      localStorage.setItem(
        "supercommander-preview",
        JSON.stringify({ ...settings, theme }),
      );
    }, theme);
    await page.setViewportSize({ width: 960, height: 640 });
    await page.reload();
    await expect(page.locator(".file-row").first()).toBeVisible();
    await page.locator('[data-pane="0"] .file-grid').focus();
    await page.keyboard.press("Control+f");
    const dialog = page.getByRole("dialog", { name: "Search", exact: true });
    await dialog.getByRole("button", { name: "Details", exact: true }).click();
    await dialog
      .getByRole("checkbox", { name: "Include subfolders", exact: true })
      .uncheck();
    await dialog.getByRole("button", { name: "Search", exact: true }).click();
    await expect(dialog.getByRole("option").first()).toBeVisible();
    await dialog.getByRole("listbox").focus();
    await page.keyboard.press("End");
    await expect(dialog.getByRole("option", { selected: true })).toBeVisible();
    await page.keyboard.press("Home");
    await expect(dialog.getByRole("option").first()).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(
      dialog.getByRole("button", { name: /Go to file/ }),
    ).toBeInViewport();
    await page.screenshot({
      path: `artifacts/search-${theme}.png`,
      animations: "disabled",
    });
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });
}
