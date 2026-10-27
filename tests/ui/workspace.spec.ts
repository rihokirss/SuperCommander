import { test, expect, type Page } from "@playwright/test";
async function choose(page: Page, label: string, option: string) {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}
test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".file-row").first()).toBeVisible();
});
test("independent panels, navigation history, tabs and filtering", async ({
  page,
}) => {
  const left = page.locator('[data-pane="0"]'),
    right = page.locator('[data-pane="1"]');
  await expect(left.getByText("Aurora", { exact: true })).toBeVisible();
  await left.getByText("Aurora", { exact: true }).dblclick();
  await expect(left.getByText("package.json", { exact: true })).toBeVisible();
  await expect(
    right.getByText("Brand strategy.pdf", { exact: true }),
  ).toBeVisible();
  await left.getByRole("button", { name: "Back", exact: true }).click();
  await expect(left.getByText("Aurora", { exact: true })).toBeVisible();
  await left.getByRole("button", { name: "New tab", exact: true }).click();
  await expect(left.locator(".pane-tab")).toHaveCount(2);
  await left
    .getByRole("textbox", { name: "Filter this folder…" })
    .fill("readme");
  await expect(left.locator(".file-row:not(.parent-entry)")).toHaveCount(1);
  await expect(right.locator(".file-row:not(.parent-entry)")).toHaveCount(10);
});
test("selection, keyboard panel switch and copy destination", async ({
  page,
}) => {
  const left = page.locator('[data-pane="0"]');
  await left.getByText("README.md", { exact: true }).click();
  await left.getByRole("grid").focus();
  await page.keyboard.press("F5");
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Destination" })).toHaveValue(
    "C:\\Users\\Alex\\Documents",
  );
  await page.keyboard.press("Escape");
  await left.getByRole("grid").focus();
  await page.keyboard.press("Tab");
  await expect(page.locator('[data-pane="1"]')).toHaveClass(/active/);
  await page
    .locator(".titlebar-tools")
    .getByRole("button", { name: "Show hidden files" })
    .focus();
  await page.keyboard.press("Tab");
  await expect(page.locator('[data-pane="0"]')).toHaveClass(/active/);
});
test("light theme persists and can follow the system", async ({ page }) => {
  await page
    .locator(".toolbar-right")
    .getByRole("button", { name: "Settings", exact: true })
    .click();
  await choose(page, "Theme", "Light");
  await expect(page.locator(".app-shell")).toHaveAttribute(
    "data-theme",
    "light",
  );
  await page.waitForFunction(
    () =>
      JSON.parse(localStorage.getItem("supercommander-preview") || "{}")
        .theme === "light",
  );
  await page.reload();
  await expect(page.locator(".app-shell")).toHaveAttribute(
    "data-theme",
    "light",
  );
  await page
    .locator(".toolbar-right")
    .getByRole("button", { name: "Settings", exact: true })
    .click();
  await choose(page, "Theme", "Follow Windows");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator(".app-shell")).toHaveAttribute(
    "data-theme",
    "dark",
  );
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator(".app-shell")).toHaveAttribute(
    "data-theme",
    "light",
  );
});
test("Ctrl+O swaps full terminal and panels while preserving the session element", async ({
  page,
}) => {
  await page.locator('[data-pane="0"] .file-grid').focus();
  await page.keyboard.press("Control+o");
  await expect(page.locator(".pane-layout")).toBeHidden();
  await expect(page.locator(".terminal-fullscreen")).toBeVisible();
  await page.keyboard.press("Control+o");
  await expect(page.locator(".pane-layout")).toBeVisible();
  await expect(page.locator(".terminal-panel")).toHaveCount(1);
  await expect(page.locator(".terminal-panel")).toBeHidden();
  await page.keyboard.press("Control+o");
  await expect(page.locator(".terminal-fullscreen")).toBeVisible();
});
test("F8 and Shift+F8 use the corresponding deletion confirmations", async ({
  page,
}) => {
  const left = page.locator('[data-pane="0"]');
  await left.getByText("README.md", { exact: true }).click();
  await page.keyboard.press("F8");
  await expect(
    page.getByRole("dialog", { name: "Move to the Recycle Bin?" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await left.getByRole("grid").focus();
  await page.keyboard.press("Shift+F8");
  await expect(
    page.getByRole("dialog", { name: "Delete permanently?" }),
  ).toBeVisible();
});
test("SSH paths open authentication for the requested panel", async ({
  page,
}) => {
  const right = page.locator('[data-pane="1"]');
  const original = await right.locator(".breadcrumbs").getAttribute("title");
  await right.locator(".breadcrumbs").click();
  await right
    .locator(".path-form input")
    .fill("ssh://alice@example.com:2222/var/www");
  await right.locator(".path-form input").press("Enter");
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Host", { exact: true })).toHaveValue(
    "example.com",
  );
  await expect(dialog.getByLabel("Username", { exact: true })).toHaveValue(
    "alice",
  );
  await expect(dialog.getByLabel("Port", { exact: true })).toHaveValue("2222");
  await page.keyboard.press("Escape");
  await expect(right.locator(".breadcrumbs")).toHaveAttribute(
    "title",
    original!,
  );
  await expect(
    page.locator('[data-pane="0"]').getByText("Aurora", { exact: true }),
  ).toBeVisible();
});
test("language, glass setting and command palette", async ({ page }) => {
  await page
    .locator(".toolbar-right")
    .getByRole("button", { name: "Settings", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await choose(page, "Language", "Eesti");
  await expect(
    dialog.getByRole("heading", { name: "Seaded", exact: true }),
  ).toBeVisible();
  await dialog.getByRole("switch").uncheck();
  await expect(page.locator(".app-shell")).toHaveClass(/opaque/);
  await page.keyboard.press("Escape");
  await page.locator('[data-pane="0"] .file-grid').focus();
  await page.keyboard.press("Control+p");
  await expect(page.getByRole("dialog", { name: "Käsupalett" })).toBeVisible();
});
test("parent row, Page Up/Down and Home/End preserve marks", async ({
  page,
}) => {
  const left = page.locator('[data-pane="0"]');
  await left.getByText("Aurora", { exact: true }).dblclick();
  await expect(left.locator(".parent-entry")).toBeVisible();
  await left.getByRole("grid").focus();
  await page.keyboard.press("Home");
  await page.keyboard.press("Enter");
  await expect(left.getByText("Aurora", { exact: true })).toBeVisible();
  await left.getByRole("grid").focus();
  await page.keyboard.press("Home");
  await page.keyboard.press("Insert");
  await expect(left.locator(".file-row.selected")).toHaveCount(0);
  await page.keyboard.press("Insert");
  await expect(left.locator(".file-row.selected")).toHaveCount(1);
  await page.keyboard.press("PageDown");
  await expect(left.locator(".file-row.focused")).toContainText(
    "workspace.code-workspace",
  );
  await page.keyboard.press("PageUp");
  await expect(left.locator(".parent-entry")).toHaveClass(/focused/);
  await expect(left.locator(".file-row.selected")).toHaveCount(1);
  await page.keyboard.press("End");
  await expect(left.locator(".file-row.focused")).toContainText(
    "workspace.code-workspace",
  );
});
test("tooltips expose shortcuts and themed choices support the keyboard", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Swap panels", exact: true }).hover();
  await expect(page.getByRole("tooltip")).toContainText("Ctrl+U");
  await page
    .locator(".toolbar-right")
    .getByRole("button", { name: "Settings", exact: true })
    .click();
  const theme = page.getByRole("combobox", { name: "Theme", exact: true });
  await theme.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("listbox")).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.locator(".app-shell")).toHaveAttribute(
    "data-theme",
    "light",
  );
  await theme.click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(page.getByRole("dialog")).toBeVisible();
});
test("layout stays within the window at supported sizes", async ({ page }) => {
  for (const width of [960, 1280, 1920]) {
    await page.setViewportSize({ width, height: 800 });
    const bounds = await page.locator('[data-pane="1"]').boundingBox();
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    expect(bounds!.y).toBeLessThan(70);
    const search = await page.locator(".global-search").boundingBox();
    const tools = await page.locator(".titlebar-tools").boundingBox();
    expect(search!.x + search!.width).toBeLessThanOrEqual(tools!.x);
    await expect(page.locator(".shortcut-bar")).toBeVisible();
  }
});
test("Insert toggles a mark and advances the cursor like Midnight Commander", async ({
  page,
}) => {
  const left = page.locator('[data-pane="0"]');
  await left.getByRole("grid").focus();
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Insert");
  await expect(left.locator(".file-row.selected")).toHaveCount(1);
  await expect(left.locator(".file-row.selected")).toContainText("Aurora");
  await expect(left.locator(".file-row.focused")).toContainText(
    "Brand guidelines",
  );
  await page.keyboard.press("Insert");
  await expect(left.locator(".file-row.selected")).toHaveCount(2);
  await expect(left.locator(".file-row.focused")).toContainText("Client work");
  await page.keyboard.press("ArrowUp");
  await expect(left.locator(".file-row.selected")).toHaveCount(2);
  await page.keyboard.press("Insert");
  await expect(left.locator(".file-row.selected")).toHaveCount(1);
  await expect(left.locator(".file-row.focused")).toContainText("Client work");
  await page.keyboard.press("End");
  await page.keyboard.press("Insert");
  await expect(left.locator(".file-row.focused")).toContainText(
    "workspace.code-workspace",
  );
  await page.keyboard.press("Insert");
  await expect(left.locator(".file-row.focused")).toContainText(
    "workspace.code-workspace",
  );
  await expect(left.locator(".file-row.selected")).toHaveCount(1);
  await page.keyboard.press("F5");
  await expect(
    page.getByRole("dialog").locator(".selection-summary"),
  ).toContainText("Aurora");
  await expect(
    page.getByRole("dialog").locator(".selection-summary .file-icon"),
  ).toHaveCount(1);
});
