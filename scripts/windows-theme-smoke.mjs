// Own a real Windows terminal; selection must be visible with and without focus.
import { startNativeTest } from "./native-test-instance.mjs";
import { expect } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
const instance = await startNativeTest("theme", process.argv[2]);
const { page, root } = instance;
try {
  for (const [index, name] of [
    [0, "Projects"],
    [1, "Documents"],
  ]) {
    const dir = path.join(root, name);
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, "README.md"), "Theme sample\n");
    await fs.mkdir(path.join(dir, "Archive"));
    await fs.writeFile(path.join(dir, "layout.md"), "Layout sample\n");
    const pane = page.locator(`[data-pane="${index}"]`);
    await pane.locator(".breadcrumbs").click();
    await pane.locator(".path-form input").fill(dir);
    await pane.locator(".path-form input").press("Enter");
    await expect(pane.getByText("README.md", { exact: true })).toBeVisible();
  }
  const left = page.locator('[data-pane="0"]');
  await left.getByText("Archive", { exact: true }).dblclick();
  await expect(left.locator(".file-row.focused")).toHaveClass(/parent-entry/);
  await left.getByRole("grid").focus();
  await page.keyboard.press("Enter");
  await expect(left.getByText("layout.md", { exact: true })).toBeVisible();
  await left.getByText("README.md", { exact: true }).click();
  const rows = await left.locator(".file-row").count();
  await page.keyboard.press("Alt+s");
  const quick = left.locator(".quick-find input");
  await quick.fill(".md");
  await expect(left.locator(".file-row.focused")).toContainText("layout.md");
  await expect(left.locator(".file-row")).toHaveCount(rows);
  await expect(left.locator(".file-row.selected")).toContainText("README.md");
  await page.keyboard.press("Enter");
  await expect(left.locator(".file-row.focused")).toContainText("README.md");
  await page.keyboard.press("Alt+s");
  await expect(left.locator(".file-row.focused")).toContainText("layout.md");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+Shift+f");
  await left.locator(".folder-filter input").fill("l");
  await page.screenshot({ path: "artifacts/sky-filter-native.png" });
  await page.keyboard.press("Escape");
  await left.locator(".breadcrumbs").click();
  await left.locator(".path-form input").fill(path.parse(root).root);
  await left.locator(".path-form input").press("Enter");
  await expect(left.locator(".parent-entry")).toHaveCount(0);
  await expect(left.locator(".file-row").first()).toHaveClass(/focused/);
  await left.locator(".breadcrumbs").click();
  await left.locator(".path-form input").fill(path.join(root, "Projects"));
  await left.locator(".path-form input").press("Enter");
  console.log(
    "PASS native next-match search without filtering or lost marks, visible filter text and folder/root cursor",
  );
  async function choose(label, value) {
    await page.getByRole("combobox", { name: label, exact: true }).click();
    await page.getByRole("option", { name: value, exact: true }).click();
  }
  await page
    .locator(".toolbar-right")
    .getByRole("button", { name: "Settings", exact: true })
    .click();
  for (const [mode, label, names] of [
    [
      "Dark",
      "Dark palette",
      ["Classic blue", "Sky blue", "Denim", "Midnight blue"],
    ],
    ["Light", "Light palette", ["Sky blue", "Ice blue", "Azure"]],
  ]) {
    await choose("Theme", mode);
    const colors = new Set();
    for (const name of names) {
      await choose(label, name);
      colors.add(
        await page
          .locator(".app-shell")
          .evaluate((e) => getComputedStyle(e).backgroundImage),
      );
    }
    expect(colors.size).toBe(mode === "Dark" ? 4 : 3);
    await page.screenshot({
      path: `artifacts/sky-palettes-${mode.toLowerCase()}.png`,
    });
  }
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const b = await window.__TAURI_INTERNALS__.invoke("bootstrap", {
          includeNetwork: false,
        });
        return b.settings.darkPalette + " " + b.settings.lightPalette;
      }),
    )
    .toBe("midnight azure");
  await page.reload();
  await expect(page.locator(".app-shell")).toHaveAttribute(
    "data-palette",
    "azure",
  );
  console.log(
    "PASS all seven native palettes, separate dark/light choices, persistence and reload",
  );
  await page.keyboard.press("Control+Backquote");
  const terminal = page.locator(".terminal-panel");
  await expect(terminal.locator(".xterm-rows")).toContainText("PS ", {
    timeout: 15000,
  });
  await terminal.locator(".xterm-helper-textarea").focus();
  const marker = "SKY_SELECTION_SAMPLE_12345";
  await page.keyboard.type(`Write-Output '${marker}'`);
  await page.keyboard.press("Enter");
  await expect(terminal.locator(".xterm-rows")).toContainText(marker);
  for (const theme of ["Dark", "Light"]) {
    await page
      .locator(".toolbar-right")
      .getByRole("button", { name: "Settings", exact: true })
      .click();
    await page.getByRole("combobox", { name: "Theme", exact: true }).click();
    await page.getByRole("option", { name: theme, exact: true }).click();
    await choose(
      theme === "Dark" ? "Dark palette" : "Light palette",
      "Sky blue",
    );
    await page.keyboard.press("Escape");
    const row = terminal
      .locator(".xterm-rows > div")
      .filter({ hasText: marker })
      .last();
    const box = await row.boundingBox();
    if (!box) throw Error("Terminal output row not visible");
    await page.mouse.move(box.x + 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 220, box.y + box.height / 2, { steps: 10 });
    await page.mouse.up();
    const selection = terminal.locator(".xterm-selection > div").first();
    await expect(selection).toBeVisible();
    const focused = await selection.evaluate(
      (e) => getComputedStyle(e).backgroundColor,
    );
    const glyphs = await row.evaluate((e) =>
      [...e.querySelectorAll("span")]
        .map((n) => ({ text: n.textContent, color: getComputedStyle(n).color }))
        .filter((n) => n.text.trim()),
    );
    await page.screenshot({
      path: `artifacts/sky-terminal-${theme.toLowerCase()}-focused.png`,
    });
    await page.locator('[data-pane="0"]').getByRole("grid").focus();
    await expect(selection).toBeVisible();
    await expect
      .poll(() =>
        selection.evaluate((e) => getComputedStyle(e).backgroundColor),
      )
      .not.toBe(focused);
    const inactive = await selection.evaluate(
      (e) => getComputedStyle(e).backgroundColor,
    );
    console.log(
      "PASS terminal selection",
      JSON.stringify({ theme, focused, inactive, glyphs }),
    );
    await page.screenshot({
      path: `artifacts/sky-terminal-${theme.toLowerCase()}-inactive.png`,
    });
  }
} finally {
  await instance.close();
}
