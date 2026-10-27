import { test, expect } from "@playwright/test";
test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".file-row").first()).toBeVisible();
  await page.locator('[data-pane="0"] .file-grid').focus();
  await page.keyboard.press("Shift+F4");
});
test("new editor protects changes and nested Save As keeps Escape local", async ({
  page,
}) => {
  const editor = page.getByRole("textbox", {
    name: "File contents",
    exact: true,
  });
  await expect(editor).toBeEditable();
  await editor.fill("Unsaved Õunad\n");
  await page.keyboard.press("F10");
  const prompt = page.getByRole("dialog", {
    name: "Save changes before closing?",
    exact: true,
  });
  await expect(prompt).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(prompt).toHaveCount(0);
  await expect(editor).toHaveValue("Unsaved Õunad\n");
  await page.keyboard.press("Control+Shift+s");
  const saveAs = page.getByRole("dialog", { name: "Save As", exact: true });
  await expect(
    saveAs.getByRole("textbox", { name: "File path", exact: true }),
  ).toBeFocused();
  await expect(
    saveAs.getByRole("combobox", { name: "Encoding", exact: true }),
  ).toBeVisible();
  await saveAs.getByRole("combobox", { name: "Encoding", exact: true }).click();
  await page.getByRole("option", { name: "UTF-16 BE", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(saveAs).toHaveCount(0);
  await expect(
    page
      .locator(".file-workbench")
      .getByRole("combobox", { name: "Encoding", exact: true }),
  ).toHaveText("UTF-8");
  await expect(editor).toHaveValue("Unsaved Õunad\n");
  await page.keyboard.press("F10");
  await prompt
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(saveAs).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(prompt).toHaveCount(0);
  await editor.focus();
  await page.keyboard.press("F10");
  await prompt
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
test("multiline indentation is reversible and editor shortcuts have contextual help", async ({
  page,
}) => {
  const editor = page.getByRole("textbox", {
    name: "File contents",
    exact: true,
  });
  await editor.fill("one\ntwo\n");
  await editor.selectText();
  await page.keyboard.press("Tab");
  await expect(editor).toHaveValue("\tone\n\ttwo\n");
  await page.keyboard.press("Shift+Tab");
  await expect(editor).toHaveValue("one\ntwo\n");
  await page.keyboard.press("Control+z");
  await expect(editor).toHaveValue("\tone\n\ttwo\n");
  await page.keyboard.press("F1");
  const help = page.getByRole("dialog", {
    name: "Viewer and editor",
    exact: true,
  });
  await expect(help).toContainText("Ctrl+Shift+S");
  expect(
    await help.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  await page.keyboard.press("Escape");
  await expect(help).toHaveCount(0);
  await expect(editor).toBeVisible();
});
