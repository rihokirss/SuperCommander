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

test("footer F1 and F9 buttons open help and actions above the bar", async ({
  page,
}) => {
  for (const width of [960, 1440]) {
    await page.setViewportSize({ width, height: 700 });
    const bar = page.locator(".shortcut-bar");
    const buttons = bar.locator("button");
    await expect(buttons).toHaveCount(9);
    const left = (await bar.boundingBox())!.x;
    const right = left + (await bar.boundingBox())!.width;
    const sidebar = (await page.locator(".sidebar").boundingBox())!;
    expect(left).toBeCloseTo(sidebar.x + sidebar.width, 0);
    let previousRight = left;
    for (const button of await buttons.all()) {
      const box = (await button.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(left);
      expect(box.x + box.width).toBeLessThanOrEqual(right + 1);
      expect(box.x - previousRight).toBeLessThanOrEqual(3);
      previousRight = box.x + box.width;
    }
    for (const label of await bar.locator("button > span").all())
      expect(
        await label.evaluate((el) => el.scrollWidth <= el.clientWidth),
      ).toBe(true);
    await bar.getByRole("button", { name: /Help/ }).click();
    await expect(
      page.getByRole("dialog", { name: "Keyboard shortcuts" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    const actions = bar.getByRole("button", { name: "Actions" });
    await actions.click();
    const menu = page.getByRole("menu", { name: "Actions" });
    await expect(
      menu.getByRole("menuitem", { name: /Calculate folder sizes/ }),
    ).toBeVisible();
    expect(
      (await menu.boundingBox())!.y + (await menu.boundingBox())!.height,
    ).toBeLessThanOrEqual((await actions.boundingBox())!.y);
    await page.keyboard.press("Escape");
    await expect(actions).toBeFocused();
  }
  await page.setViewportSize({ width: 960, height: 700 });
  await page
    .locator(".toolbar-right")
    .getByRole("button", { name: "Settings" })
    .click();
  await page.getByRole("combobox", { name: "Language" }).click();
  await page.getByRole("option", { name: "Eesti", exact: true }).click();
  await page.keyboard.press("Escape");
  for (const label of await page.locator(".shortcut-bar button > span").all())
    expect(await label.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
      true,
    );
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

test("Alt+S moves between matches without filtering or clearing marks", async ({
  page,
}) => {
  const pane = page.locator('[data-pane="0"]');
  await pane.getByText("README.md", { exact: true }).click();
  const count = await pane.locator(".file-row").count();
  await page.keyboard.press("Alt+s");
  const input = pane.locator(".quick-find input");
  await expect(input).toBeFocused();
  await input.fill(".md");
  await expect(pane.locator(".file-row.focused")).toContainText(
    "project-notes.md",
  );
  await expect(pane.locator(".file-row")).toHaveCount(count);
  await expect(pane.locator(".file-row.selected")).toContainText("README.md");
  await page.keyboard.press("Enter");
  await expect(pane.locator(".file-row.focused")).toContainText("README.md");
  await page.keyboard.press("Alt+s");
  await expect(pane.locator(".file-row.focused")).toContainText(
    "project-notes.md",
  );
  await input.fill("not-a-match");
  await expect(input).toHaveAttribute("aria-invalid", "true");
  await expect(pane.locator(".file-row")).toHaveCount(count);
  await page.keyboard.press("Escape");
  await expect(pane.locator(".quick-find")).toHaveCount(0);
  await expect(pane.getByRole("grid")).toBeFocused();
  await page.keyboard.press("Control+Shift+f");
  const filter = pane.locator(".folder-filter input");
  await filter.fill("README");
  await expect(pane.locator(".file-row:not(.parent-entry)")).toHaveCount(1);
});

test("entering a folder focuses its parent row and an empty root has no stale cursor", async ({
  page,
}) => {
  const pane = page.locator('[data-pane="0"]');
  await pane.getByText("Aurora", { exact: true }).dblclick();
  await expect(pane.locator(".file-row.focused")).toHaveClass(/parent-entry/);
  await expect(pane.locator(".file-row.selected")).toHaveCount(0);
  await pane.getByRole("grid").focus();
  await page.keyboard.press("Enter");
  await expect(pane.locator(".file-row.focused")).toContainText("Aurora");
  await expect(pane.locator(".file-row.selected")).toHaveCount(0);
  await page.keyboard.press("Enter");
  await page.keyboard.press("Backspace");
  await expect(pane.locator(".file-row.focused")).toContainText("Aurora");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Alt+ArrowUp");
  await expect(pane.locator(".file-row.focused")).toContainText("Aurora");
  await page.keyboard.press("Enter");
  await pane.getByRole("button", { name: "Up one level", exact: true }).click();
  await expect(pane.locator(".file-row.focused")).toContainText("Aurora");
  await page.keyboard.press("Control+l");
  await pane.locator(".path-form input").fill("C:\\");
  await pane.locator(".path-form input").press("Enter");
  await expect(pane.locator(".parent-entry")).toHaveCount(0);
  await expect(pane.locator(".file-row")).toHaveCount(0);
  await expect(pane.locator(".file-row.focused")).toHaveCount(0);
});

test("dark and light palettes preview independently and survive reload", async ({
  page,
}) => {
  async function choose(label: string, value: string) {
    await page.getByRole("combobox", { name: label, exact: true }).click();
    await page.getByRole("option", { name: value, exact: true }).click();
  }
  await page
    .locator(".toolbar-right")
    .getByRole("button", { name: "Settings", exact: true })
    .click();
  const dark = new Set<string>();
  const light = new Set<string>();
  for (const [mode, label, names, target] of [
    [
      "Dark",
      "Dark palette",
      [
        "Midnight blue",
        "Midnight · classic blue",
        "Graphite backdrop · blue panels",
        "Midnight red",
        "Midnight · classic red",
        "Graphite backdrop · red panels",
      ],
      dark,
    ],
    ["Light", "Light palette", ["Sky blue", "Ice blue", "Azure"], light],
  ] as const) {
    await choose("Theme", mode);
    for (const name of names) {
      await choose(label, name);
      target.add(
        await page
          .locator(".app-shell")
          .evaluate(
            (e) =>
              getComputedStyle(e).backgroundImage +
              "|" +
              getComputedStyle(e.querySelector(".file-pane")!).backgroundColor,
          ),
      );
    }
  }
  expect(dark.size).toBe(6);
  expect(light.size).toBe(3);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem("supercommander-preview") || "{}")
            .lightPalette,
      ),
    )
    .toBe("azure");
  await page.reload();
  await expect(page.locator(".app-shell")).toHaveAttribute(
    "data-palette",
    "azure",
  );
  await page
    .locator(".toolbar-right")
    .getByRole("button", { name: "Settings", exact: true })
    .click();
  await choose("Theme", "Dark");
  await expect(page.locator(".app-shell")).toHaveAttribute(
    "data-palette",
    "graphiteRed",
  );
});

test("titlebar theme toggle remembers each palette and persists", async ({
  page,
}) => {
  const shell = page.locator(".app-shell");
  await expect(shell).toHaveAttribute("data-theme", "dark");
  await expect(shell).toHaveAttribute("data-palette", "midnight");
  const light = page.getByRole("button", { name: "Switch to light theme" });
  await expect(light).toHaveAttribute("data-tooltip", "Switch to light theme");
  await light.click();
  await expect(shell).toHaveAttribute("data-theme", "light");
  await expect(shell).toHaveAttribute("data-palette", "sky");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem("supercommander-preview") || "{}")
            .theme,
      ),
    )
    .toBe("light");
  await page.reload();
  await expect(shell).toHaveAttribute("data-theme", "light");
  await page.getByRole("button", { name: "Switch to dark theme" }).click();
  await expect(shell).toHaveAttribute("data-theme", "dark");
  await expect(shell).toHaveAttribute("data-palette", "midnight");
});

test("legacy dark palette falls back to Midnight without losing other settings", async ({
  page,
}) => {
  await expect
    .poll(() =>
      page.evaluate(() => localStorage.getItem("supercommander-preview")),
    )
    .not.toBeNull();
  await page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem("supercommander-preview")!);
    saved.darkPalette = "blue";
    saved.lightPalette = "azure";
    saved.transparency = 33;
    localStorage.setItem("supercommander-preview", JSON.stringify(saved));
  });
  await page.reload();
  await expect(page.locator(".app-shell")).toHaveAttribute(
    "data-palette",
    "midnight",
  );
  await expect
    .poll(() =>
      page.evaluate(() => {
        const saved = JSON.parse(
          localStorage.getItem("supercommander-preview") || "{}",
        );
        return [saved.darkPalette, saved.lightPalette, saved.transparency];
      }),
    )
    .toEqual(["midnight", "azure", 33]);
});

test("F1 categories navigate with the keyboard and Settings contains only preferences", async ({
  page,
}) => {
  await page.keyboard.press("F1");
  const dialog = page.getByRole("dialog", {
    name: "Keyboard shortcuts",
    exact: true,
  });
  const tabs = dialog.getByRole("tablist", {
    name: "Shortcut categories",
    exact: true,
  });
  await tabs.getByRole("tab", { name: /Navigation/ }).click();
  await expect(dialog.getByRole("tabpanel")).toContainText("Quick find");
  await expect(dialog.getByRole("tabpanel")).not.toContainText(
    "Copy files to clipboard",
  );
  await page.keyboard.press("ArrowDown");
  await expect(tabs.getByRole("tab", { name: /Selection/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.keyboard.press("Escape");
  await page
    .locator(".toolbar-right")
    .getByRole("button", { name: "Settings", exact: true })
    .click();
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(settings.locator("kbd")).toHaveCount(0);
  await expect(
    settings.getByRole("combobox", { name: "Dark palette", exact: true }),
  ).toBeVisible();
});

test("F9 exposes folder size calculation and its shortcut", async ({
  page,
}) => {
  await page.keyboard.press("F9");
  await expect(
    page.getByRole("menuitem", { name: /Calculate folder sizes/ }),
  ).toContainText("Alt+Shift+Enter");
});
