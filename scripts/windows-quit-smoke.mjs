// Launch only isolated test instances; never attach to the user's app.
import { startNativeTest } from "./native-test-instance.mjs";

for (const method of ["keyboard", "footer"]) {
  const instance = await startNativeTest(`quit-${method}`, process.argv[2]);
  const { page } = instance;
  try {
    const closed = page.waitForEvent("close", { timeout: 15000 });
    if (method === "keyboard") {
      await page.locator('[data-pane="0"] .file-grid').focus();
      await page.keyboard.press("F10");
    } else {
      await page.locator('.shortcut-bar button[data-shortcut="F10"]').click();
    }
    await closed;
    console.log(`PASS ${method} F10 closes the owned application`);
  } finally {
    await instance.close();
  }
}
