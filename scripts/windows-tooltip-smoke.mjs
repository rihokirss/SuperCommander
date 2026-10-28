import { expect } from "@playwright/test";
import { startNativeTest } from "./native-test-instance.mjs";

const test = await startNativeTest("tooltips", process.argv[2]);
try {
  const { page } = test;
  await page
    .getByRole("button", { name: "Collapse workspace", exact: true })
    .click();
  const item = page.locator(".sidebar-item").first();
  const icon = item.locator("svg").first();
  const label = (await item.textContent()).trim();
  const tooltip = page.getByRole("tooltip");
  async function hover() {
    await page.mouse.move(500, 400);
    await icon.hover();
  }
  await hover();
  await expect(tooltip).toHaveCount(1);
  await expect(tooltip).toHaveText(label);
  await item.focus();
  await expect(tooltip).toHaveCount(1);

  // Native hints must take precedence even after the themed hint is visible.
  for (const owner of [icon, item, page.locator(".sidebar")]) {
    await owner.evaluate((el) => el.setAttribute("title", "Native hint"));
    await expect(tooltip).toHaveCount(0);
    await owner.evaluate((el) => el.removeAttribute("title"));
    await hover();
    await expect(tooltip).toHaveCount(1);
  }
  await icon.evaluate((el) => {
    const title = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "title",
    );
    title.textContent = "Native SVG hint";
    el.prepend(title);
  });
  await expect(tooltip).toHaveCount(0);
  await hover();
  await item.focus();
  await page.waitForTimeout(500);
  await expect(tooltip).toHaveCount(0);
  await icon.locator("title").evaluate((el) => el.remove());
  await hover();
  await expect(tooltip).toHaveCount(1);
  await expect(tooltip).toHaveText(label);
  await page
    .getByRole("button", { name: "Expand workspace", exact: true })
    .click();
  await expect(tooltip).toHaveCount(0);
  console.log(
    "Windows WebView2: collapsed workspace has one tooltip; native HTML/SVG hints take precedence for hover and keyboard focus.",
  );
} finally {
  await test.close();
}
