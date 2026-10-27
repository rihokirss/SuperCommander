import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".file-row").first()).toBeVisible();
});

test("Alt+Enter shows the focused file and restores keyboard focus", async ({
  page,
}) => {
  const pane = page.locator('[data-pane="0"]');
  await pane.getByText("README.md", { exact: true }).click();
  await pane.getByRole("grid").focus();
  await page.keyboard.press("Alt+Enter");
  const dialog = page.getByRole("dialog", { name: "Properties", exact: true });
  await expect(dialog.locator(".property-kind strong")).toHaveText("README.md");
  await expect(dialog.locator(".property-facts")).toContainText("B");
  // The web preview does not pretend to change native filesystem attributes.
  await expect(
    dialog.getByRole("button", { name: "Apply changes", exact: true }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(pane.getByRole("grid")).toBeFocused();
});

test("properties context action follows the clicked pane and Insert marks", async ({
  page,
}) => {
  const right = page.locator('[data-pane="1"]');
  await right
    .getByText("Meeting notes.md", { exact: true })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: /Properties/ }).click();
  let dialog = page.getByRole("dialog", { name: "Properties", exact: true });
  await expect(dialog.locator(".property-kind strong")).toHaveText(
    "Meeting notes.md",
  );
  await page.keyboard.press("Escape");
  await right.getByRole("grid").focus();
  await page.keyboard.press("Control+Shift+a");
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Insert");
  await page.keyboard.press("Insert");
  await page.keyboard.press("Alt+Enter");
  dialog = page.getByRole("dialog", { name: "Properties", exact: true });
  await expect(dialog.locator(".property-kind small")).toHaveText("2 items");
  await dialog.locator(".property-selection summary").click();
  await expect(dialog.locator(".property-selection code")).toHaveCount(2);
  await expect(dialog.locator(".property-selection")).not.toContainText("\\..");
});

for (const theme of ["dark", "light"]) {
  test(`properties fit a small window in ${theme} theme`, async ({ page }) => {
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
    await page
      .locator('[data-pane="0"]')
      .getByText("Aurora", { exact: true })
      .click();
    await page.keyboard.press("Alt+Enter");
    const dialog = page.getByRole("dialog", {
      name: "Properties",
      exact: true,
    });
    await expect(
      dialog.getByRole("button", {
        name: "Calculate folder size",
        exact: true,
      }),
    ).toBeVisible();
    const rect = await dialog.boundingBox();
    expect(rect!.x).toBeGreaterThanOrEqual(0);
    expect(rect!.y).toBeGreaterThanOrEqual(0);
    expect(rect!.x + rect!.width).toBeLessThanOrEqual(960);
    expect(rect!.y + rect!.height).toBeLessThanOrEqual(640);
    await page.screenshot({
      path: `artifacts/properties-${theme}.png`,
      animations: "disabled",
    });
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });
}
