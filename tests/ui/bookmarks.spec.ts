import { test, expect } from "@playwright/test";
test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".file-row").first()).toBeVisible();
});
test("bookmarks can be named, reordered, filtered and persisted", async ({
  page,
}) => {
  await page.locator('[data-pane="0"] .file-grid').focus();
  await page.keyboard.press("Control+d");
  await expect(
    page
      .locator('[data-pane="0"]')
      .getByRole("button", { name: "Remove bookmark", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Control+Shift+d");
  const dialog = page.getByRole("dialog", {
    name: "Manage bookmarks",
    exact: true,
  });
  await dialog
    .getByRole("button", { name: "Edit Projects", exact: true })
    .click();
  await dialog
    .getByRole("textbox", { name: "Bookmark name", exact: true })
    .fill("My projects");
  await dialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await dialog
    .getByRole("textbox", { name: "Bookmark name", exact: true })
    .fill("Documents");
  await dialog
    .getByRole("textbox", { name: "Folder path or SSH address", exact: true })
    .fill("C:\\Users\\Alex\\Documents");
  await dialog
    .getByRole("button", { name: "Add bookmark", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Move bookmark up Documents", exact: true })
    .click();
  await expect(dialog.locator(".bookmark-open").first()).toContainText(
    "Documents",
  );
  await dialog
    .getByRole("textbox", { name: "Filter bookmarks", exact: true })
    .fill("projects");
  await expect(dialog.locator(".bookmark-row")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem("supercommander-preview") || "{}")
            .bookmarks?.[0]?.name,
      ),
    )
    .toBe("Documents");
  await page.reload();
  const saved = page.locator(".bookmark-item").filter({ hasText: "Documents" });
  await saved.focus();
  await page.keyboard.press("Control+Enter");
  await expect(page.locator('[data-pane="1"]')).toHaveClass(/active/);
  await expect(page.locator('[data-pane="1"] .breadcrumbs')).toHaveAttribute(
    "title",
    "C:\\Users\\Alex\\Documents",
  );
  await expect(page.locator('[data-pane="1"] .file-grid')).toBeFocused();
});
test("sidebar context keys edit and remove bookmarks without deleting files", async ({
  page,
}) => {
  await page.locator('[data-pane="0"] .file-grid').focus();
  await page.keyboard.press("Control+d");
  const bookmark = page
    .locator(".bookmark-item")
    .filter({ hasText: "Projects" });
  await bookmark.focus();
  await page.keyboard.press("F2");
  const dialog = page.getByRole("dialog", {
    name: "Manage bookmarks",
    exact: true,
  });
  await expect(
    dialog.getByRole("textbox", { name: "Bookmark name", exact: true }),
  ).toHaveValue("Projects");
  await page.keyboard.press("Escape");
  await bookmark.focus();
  await page.keyboard.press("Shift+F10");
  await expect(
    page.getByRole("menu", { name: "Bookmark actions", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "Collapse workspace", exact: true })
    .click();
  await bookmark.hover();
  await expect(page.getByRole("tooltip")).toHaveCount(1);
  await expect(page.getByRole("tooltip")).toContainText("Projects");
  await bookmark.focus();
  await page.keyboard.press("Delete");
  await expect(bookmark).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.locator('[data-pane="0"]').getByText("Aurora", { exact: true }),
  ).toBeVisible();
});
test("SSH bookmark URLs open authentication in the requested pane and reject duplicate or secret URLs", async ({
  page,
}) => {
  await page.locator('[data-pane="0"] .file-grid').focus();
  await page.keyboard.press("Control+Shift+d");
  const dialog = page.getByRole("dialog", {
    name: "Manage bookmarks",
    exact: true,
  });
  const path = dialog.getByRole("textbox", {
    name: "Folder path or SSH address",
    exact: true,
  });
  await dialog
    .getByRole("textbox", { name: "Bookmark name", exact: true })
    .fill("Server logs");
  await path.fill("ssh://alice:secret@example.test/var/log");
  await dialog
    .getByRole("button", { name: "Add bookmark", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await path.fill("ssh://alice@example.test:2222/var/log");
  await dialog
    .getByRole("button", { name: "Add bookmark", exact: true })
    .click();
  await path.fill("sftp://alice@example.test:2222/var/log/");
  await dialog
    .getByRole("button", { name: "Add bookmark", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText("already bookmarked");
  await page.keyboard.press("Escape");
  await page
    .locator(".bookmark-item")
    .filter({ hasText: "Server logs" })
    .focus();
  await page.keyboard.press("Control+Enter");
  const connect = page.getByRole("dialog");
  await expect(connect.getByLabel("Host", { exact: true })).toHaveValue(
    "example.test",
  );
  await expect(connect.getByLabel("Port", { exact: true })).toHaveValue("2222");
  await expect(connect.getByLabel("Username", { exact: true })).toHaveValue(
    "alice",
  );
});
