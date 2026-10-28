import { test, expect } from "@playwright/test";
test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".file-row").first()).toBeVisible();
});

test("path, filter, refresh, tabs and recently closed tabs work without leaving the keyboard", async ({
  page,
}) => {
  const left = page.locator('[data-pane="0"]');
  await left.getByRole("grid").focus();
  await page.keyboard.press("Control+l");
  const path = left.locator(".path-form input");
  await expect(path).toBeFocused();
  expect(
    await path.evaluate((el: HTMLInputElement) =>
      el.value.slice(el.selectionStart!, el.selectionEnd!),
    ),
  ).toBe("C:\\Users\\Alex\\Projects");
  await page.keyboard.press("Escape");
  await expect(left.getByRole("grid")).toBeFocused();
  await page.keyboard.press("Control+t");
  await left.getByText("Aurora", { exact: true }).dblclick();
  await page.keyboard.press("Control+PageUp");
  await expect(
    left.getByRole("grid").getByText("Aurora", { exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Control+Tab");
  await expect(left.getByText("package.json", { exact: true })).toBeVisible();
  await page.keyboard.press("Control+w");
  await expect(left.locator(".pane-tab")).toHaveCount(1);
  await page.keyboard.press("Control+Shift+t");
  await expect(left.locator(".pane-tab")).toHaveCount(2);
  await expect(left.getByText("package.json", { exact: true })).toBeVisible();
  await page.keyboard.press("Alt+ArrowUp");
  await expect(
    left.getByRole("grid").getByText("Aurora", { exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Control+Shift+f");
  const filter = left.getByRole("textbox", { name: "Filter this folder…" });
  await expect(filter).toBeFocused();
  await filter.fill("README");
  await page.keyboard.press("Escape");
  await expect(filter).toHaveValue("");
  await page.evaluate(() => {
    (window as unknown as { testNoReload: boolean }).testNoReload = true;
  });
  await page.keyboard.press("Control+r");
  expect(
    await page.evaluate(
      () => (window as unknown as { testNoReload: boolean }).testNoReload,
    ),
  ).toBe(true);
  await left.getByRole("grid").getByText("README.md", { exact: true }).click();
  await page.keyboard.press("Control+Shift+f");
  await filter.fill("readme");
  await page.keyboard.press("ArrowDown");
  await expect(left.getByRole("grid")).toBeFocused();
  await page.keyboard.press("Control+r");
  await expect(left.locator(".path-toolbar svg.spin")).toHaveCount(0);
  await expect(filter).toHaveValue("readme");
  await expect(left.locator(".file-row.selected")).toContainText("README.md");
  await expect(left.locator(".file-row.focused")).toContainText("README.md");
});

test("selection masks, inverse selection and clearing exclude the parent row", async ({
  page,
}) => {
  const left = page.locator('[data-pane="0"]');
  await left.getByRole("grid").focus();
  await page.keyboard.press("NumpadAdd");
  await page
    .getByRole("textbox", { name: "Filename pattern", exact: true })
    .fill("*.json");
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(left.locator(".file-row.selected")).toHaveCount(1);
  await expect(left.locator(".file-row.selected")).toContainText(
    "design-tokens.json",
  );
  await page.keyboard.press("Control+i");
  await expect(left.locator(".file-row.selected")).toHaveCount(9);
  await expect(left.locator(".parent-entry")).not.toHaveClass(/selected/);
  await page.keyboard.press("Control+Shift+a");
  await expect(left.locator(".file-row.selected")).toHaveCount(0);
  await page.keyboard.press("Control+a");
  await expect(left.locator(".file-row.selected")).toHaveCount(10);
  await page.keyboard.press("NumpadSubtract");
  await page
    .getByRole("textbox", { name: "Filename pattern", exact: true })
    .fill("*.md");
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(left.locator(".file-row.selected")).toHaveCount(8);
  await page.keyboard.press("Escape");
  await expect(left.locator(".file-row.selected")).toHaveCount(0);
});

test("F9 menu supports real focus, arrows, type-ahead, Enter and focus restoration", async ({
  page,
}) => {
  const grid = page.locator('[data-pane="0"]').getByRole("grid");
  await grid.focus();
  await page.keyboard.press("F9");
  const menu = page.getByRole("menu", { name: "Actions", exact: true });
  const items = menu.getByRole("menuitem");
  await expect(items.first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(items.nth(1)).toBeFocused();
  await page.keyboard.press("End");
  await expect(items.last()).toBeFocused();
  await page.keyboard.press("Home");
  await expect(items.first()).toBeFocused();
  await page.keyboard.type("Search");
  await expect(menu.getByRole("menuitem", { name: /Search/ })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(grid).toBeFocused();
  await page.keyboard.press("F9");
  await page.keyboard.type("Search");
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("dialog", { name: "Search", exact: true }),
  ).toBeVisible();
});

test("F9 exposes comparison and recovery with their shortcuts", async ({
  page,
}) => {
  for (const [name, shortcut] of [
    ["Compare folders", "Shift+F2"],
    ["Recovery & previous versions", "Ctrl+Shift+R"],
  ]) {
    await page.keyboard.press("F9");
    const item = page.getByRole("menuitem").filter({ hasText: name });
    await expect(item).toContainText(shortcut);
    await item.click();
    await expect(page.getByRole("dialog", { name, exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
  }
});

test("right-click and Shift+F10 actions use the pane and files under the cursor", async ({
  page,
}) => {
  const left = page.locator('[data-pane="0"]'),
    right = page.locator('[data-pane="1"]');
  await left.getByRole("grid").focus();
  await right
    .getByText("Meeting notes.md", { exact: true })
    .click({ button: "right" });
  await expect(right).toHaveClass(/active/);
  await expect(
    page.getByRole("menu", { name: "File actions", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("F5");
  const dialog = page.getByRole("dialog", { name: "Copy", exact: true });
  await expect(
    dialog.getByRole("textbox", { name: "Destination", exact: true }),
  ).toHaveValue("C:\\Users\\Alex\\Projects");
  await expect(dialog).toContainText("Meeting notes.md");
  await page.keyboard.press("Escape");
  await right.getByRole("grid").focus();
  await page.keyboard.press("Shift+F10");
  const menu = page.getByRole("menu", { name: "File actions", exact: true });
  await menu.getByRole("menuitem", { name: /Rename/ }).click();
  await expect(
    page
      .getByRole("dialog", { name: "Rename", exact: true })
      .getByRole("textbox", { name: "New name", exact: true }),
  ).toHaveValue("Meeting notes.md");
});

test("F1 opens searchable shortcuts and modal reload keys keep the dialog alive", async ({
  page,
}) => {
  await page
    .locator('[data-pane="0"]')
    .getByRole("textbox", { name: "Filter this folder…" })
    .focus();
  await page.keyboard.press("F1");
  const dialog = page.getByRole("dialog", {
    name: "Keyboard shortcuts",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole("textbox", { name: "Search shortcuts", exact: true })
    .fill("Ctrl+L");
  await expect(dialog).toContainText("Go to path");
  await expect(dialog.locator(".shortcut-grid > div")).toHaveCount(1);
  await page.keyboard.press("F5");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Control+r");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
});

for (const theme of ["Dark", "Light"])
  test(`menus and shortcut reference fit a small window in ${theme.toLowerCase()} theme`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 960, height: 640 });
    if (theme === "Light") {
      await page
        .locator(".toolbar-right")
        .getByRole("button", { name: "Settings", exact: true })
        .click();
      await page.getByRole("combobox", { name: "Theme", exact: true }).click();
      await page.getByRole("option", { name: "Light", exact: true }).click();
      await page.keyboard.press("Escape");
    }
    const right = page.locator('[data-pane="1"]');
    await right
      .getByRole("grid")
      .click({ button: "right", position: { x: 300, y: 300 } });
    const menu = page.getByRole("menu", { name: "File actions", exact: true });
    await expect(menu).toHaveAttribute("data-theme", theme.toLowerCase());
    const bounds = (await menu.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(960);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(640);
    await page.mouse.move(5, 5);
    await page.screenshot({
      path: `artifacts/keyboard-menu-${theme.toLowerCase()}.png`,
      animations: "disabled",
    });
    await page.keyboard.press("Escape");
    await page.keyboard.press("F1");
    const dialog = page.getByRole("dialog", {
      name: "Keyboard shortcuts",
      exact: true,
    });
    await expect(dialog).toHaveCSS("opacity", "1");
    expect(
      await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    await page.screenshot({
      path: `artifacts/shortcuts-${theme.toLowerCase()}.png`,
      animations: "disabled",
    });
  });

test("Alt+S searches the active pane and Escape restores the list", async ({
  page,
}) => {
  const right = page.locator('[data-pane="1"]');
  await right.getByRole("grid").focus();
  await page.keyboard.press("Alt+s");
  const search = right.locator(".folder-filter input");
  await expect(search).toBeFocused();
  await search.fill("Meeting");
  await expect(
    right.getByText("Meeting notes.md", { exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(right.locator(".file-row.focused")).toContainText(
    "Meeting notes.md",
  );
  await page.keyboard.press("Alt+s");
  await page.keyboard.press("Escape");
  await expect(search).toHaveValue("");
  await expect(right.getByRole("grid")).toBeFocused();
});
