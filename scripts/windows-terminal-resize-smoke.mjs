// Use an isolated Windows app and a real PowerShell PTY.
import { expect } from "@playwright/test";
import { startNativeTest } from "./native-test-instance.mjs";
const instance = await startNativeTest("terminal-resize", process.argv[2]);
const { page } = instance;
try {
  await page.keyboard.press("Control+Backquote");
  const terminal = page.locator(".terminal-panel");
  const rows = terminal.locator(".xterm-rows > div");
  const handle = page.getByRole("separator", { name: "Resize terminal" });
  async function expectTerminalFits() {
    await expect
      .poll(() =>
        terminal.evaluate((panel) => {
          const mount = panel
            .querySelector(".terminal-mount")
            .getBoundingClientRect();
          const screen = panel
            .querySelector(".xterm-screen")
            .getBoundingClientRect();
          const lastRow = panel
            .querySelector(".xterm-rows > div:last-child")
            .getBoundingClientRect();
          return Math.max(
            screen.bottom - mount.bottom,
            lastRow.bottom - mount.bottom,
            screen.right - mount.right,
          );
        }),
      )
      .toBeLessThanOrEqual(0);
  }
  await expect(terminal.locator(".xterm-rows")).toContainText("PS ", {
    timeout: 15000,
  });
  await expectTerminalFits();
  await handle.focus();
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press("ArrowDown");
    await expectTerminalFits();
  }
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press("ArrowUp");
    await expectTerminalFits();
  }
  const initialRows = await rows.count();
  const initialHeight = (await terminal.boundingBox()).height;
  const box = await handle.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y - 100, { steps: 10 });
  await page.mouse.up();
  await expect
    .poll(async () => (await terminal.boundingBox()).height)
    .toBeGreaterThan(initialHeight + 80);
  await expect.poll(() => rows.count()).toBeGreaterThan(initialRows);
  await expectTerminalFits();
  const height = (await terminal.boundingBox()).height;
  await terminal.locator(".xterm-helper-textarea").focus();
  await page.keyboard.type("Write-Output 'TERMINAL_RESIZE_STILL_ALIVE'");
  await page.keyboard.press("Enter");
  await expect(terminal.locator(".xterm-rows")).toContainText(
    "TERMINAL_RESIZE_STILL_ALIVE",
  );
  await terminal
    .getByRole("button", { name: "Full terminal / file panels" })
    .click();
  await expect(handle).toHaveCount(0);
  await expectTerminalFits();
  await terminal.getByRole("button", { name: "Restore file panels" }).click();
  await expect
    .poll(async () => (await terminal.boundingBox()).height)
    .toBe(height);
  await expectTerminalFits();
  await expect(terminal.locator(".xterm-rows")).toContainText(
    "TERMINAL_RESIZE_STILL_ALIVE",
  );
  await handle.focus();
  await page.keyboard.press("ArrowDown");
  await expect
    .poll(async () => (await terminal.boundingBox()).height)
    .toBeLessThan(height);
  await expectTerminalFits();
  const persisted = (await terminal.boundingBox()).height;
  await expect
    .poll(() =>
      page.evaluate(
        async () =>
          (
            await window.__TAURI_INTERNALS__.invoke("bootstrap", {
              includeNetwork: false,
            })
          ).settings.terminalHeight,
      ),
    )
    .toBe(persisted);
  console.log(
    "PASS terminal drag, PTY row resize, live shell, fullscreen restoration, keyboard resize and native persistence",
  );
} finally {
  await instance.close();
}
