import { test, expect } from "@playwright/test";

test("archive shortcuts are discoverable and use the active pane", async ({
  page,
}) => {
  await page.goto("/");
  const left = page.locator('[data-pane="0"]');
  await left.getByText("README.md", { exact: true }).click();
  await page.keyboard.press("Alt+F5");
  let dialog = page.getByRole("dialog", { name: "Create ZIP", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("README.md");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Alt+F6");
  dialog = page.getByRole("dialog", { name: "Extract ZIP", exact: true });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("textbox", { name: "Destination", exact: true }),
  ).toHaveValue("C:\\Users\\Alex\\Documents");
  await page.keyboard.press("Escape");
  await page.keyboard.press("F9");
  await expect(
    page.getByRole("menuitem", { name: /Create ZIP/ }),
  ).toContainText("Alt+F5");
  await expect(
    page.getByRole("menuitem", { name: /Extract ZIP/ }),
  ).toContainText("Alt+F6");
  await page.keyboard.press("Escape");
  await page.keyboard.press("F1");
  const help = page.getByRole("dialog", {
    name: "Keyboard shortcuts",
    exact: true,
  });
  await help
    .getByRole("textbox", { name: "Search shortcuts", exact: true })
    .fill("Alt+F5");
  await expect(help).toContainText("Create ZIP");
});

test("archive shortcuts yield to path editing and become available after Escape", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(".file-row").first()).toBeVisible();
  const left = page.locator('[data-pane="0"]');
  await left.getByText("README.md", { exact: true }).click();
  await page.keyboard.press("Control+l");
  const input = left.locator(".path-form input");
  await input.fill("keep this unfinished path");
  await page.keyboard.press("Alt+F5");
  await page.keyboard.press("Alt+F6");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(input).toHaveValue("keep this unfinished path");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Alt+F5");
  await expect(
    page.getByRole("dialog", { name: "Create ZIP", exact: true }),
  ).toBeVisible();
});
