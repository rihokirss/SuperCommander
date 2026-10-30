// Real PowerShell sessions in an isolated app and temporary directory.
import { expect } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { startNativeTest } from "./native-test-instance.mjs";

const instance = await startNativeTest("terminal-tabs", process.argv[2]);
const { page, root } = instance;
const first = path.join(root, "First folder");
const second = path.join(root, "O'Brien folder");
const quote = (value) => value.replaceAll("'", "''");
const visible = () => page.locator(".terminal-panel:visible");
async function run(command) {
  await visible().locator(".xterm-helper-textarea").focus();
  await page.keyboard.type(command);
  await page.keyboard.press("Enter");
}
async function expectCwd(folder, token) {
  await run(`Write-Output ('${token}:' + ((Get-Item -LiteralPath (Get-Location).Path).FullName -eq (Get-Item -LiteralPath '${quote(folder)}').FullName))`);
  await expect(visible().locator(".xterm-rows")).toContainText(`${token}:True`, { timeout: 30000 });
}
try {
  await fs.mkdir(first);
  await fs.mkdir(second);
  const settings = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("bootstrap", { includeNetwork: false }).then((value) => value.settings));
  await page.evaluate((value) => window.__TAURI_INTERNALS__.invoke("save_settings", { value }), {
    ...settings,
    language: "en",
    panes: settings.panes.map((pane) => ({
      ...pane,
      activeTab: pane.tabs[0].id,
      tabs: [{ ...pane.tabs[0], location: { source: "local", path: root }, history: [{ source: "local", path: root }], historyIndex: 0 }],
    })),
  });
  await page.reload();
  const left = page.locator('[data-pane="0"]');
  await expect(left.getByText("First folder", { exact: true })).toBeVisible();
  await left.getByRole("grid").focus();
  await page.keyboard.press("Control+j");
  await expect(visible().locator(".xterm-rows")).toContainText("PS ", { timeout: 30000 });
  await expect(visible().locator(".terminal-sync-status")).toHaveCount(0, { timeout: 30000 });
  await expectCwd(root, "SC_INITIAL");
  const initialTab = await visible().getAttribute("data-terminal-id");
  await visible().locator(".xterm-helper-textarea").focus();
  await page.keyboard.type("Write-Output ('SC_SHORTCUT_' + 'EXECUTED')");
  await page.keyboard.press("Control+j");
  await expect(visible()).toHaveCount(0);
  await page.keyboard.press("Control+j");
  await expect(visible()).toHaveAttribute("data-terminal-id", initialTab);
  await expect(visible().locator(".xterm-rows")).not.toContainText("SC_SHORTCUT_EXECUTED");
  await visible().locator(".xterm-helper-textarea").focus();
  await page.keyboard.press("Enter");
  await expect(visible().locator(".xterm-rows")).toContainText("SC_SHORTCUT_EXECUTED");


  // A shell with an unfamiliar initial redraw may safely fall back to showing
  // that command. Check that the subsequent navigation adds no visible echo.
  const echoCount = async () => ((await visible().locator(".xterm-rows").textContent())?.match(/Set-Location -LiteralPath/g) || []).length;
  const previousEchoes = await echoCount();
  await left.getByText("First folder", { exact: true }).dblclick();
  await expect(visible().locator(".terminal-sync-status")).toHaveCount(0, { timeout: 30000 });
  await expect.poll(echoCount).toBe(previousEchoes);
  await expectCwd(first, "SC_FOLLOW");
  await run("$sc_tab = 'FIRST_TAB'");
  await page.keyboard.press("Control+Shift+j");
  await expect(page.locator(".terminal-panel")).toHaveCount(2);
  await expect(visible().locator(".xterm-rows")).toContainText("PS ", { timeout: 30000 });
  await expect(visible().locator(".terminal-sync-status")).toHaveCount(0, { timeout: 30000 });
  await expectCwd(first, "SC_SECOND");
  await run("$sc_tab = 'SECOND_TAB'");
  await visible().getByRole("tab").first().click();
  await run("Write-Output ('SC_VALUE:' + $sc_tab)");
  await expect(visible().locator(".xterm-rows")).toContainText("SC_VALUE:FIRST_TAB");

  await run("Start-Sleep -Seconds 4; Write-Output 'SC_BUSY_DONE'");
  await left.getByRole("grid").focus();
  await page.keyboard.press("Backspace");
  await expect(left.getByText("O'Brien folder", { exact: true })).toBeVisible();
  await left.getByText("O'Brien folder", { exact: true }).dblclick();
  await expect(visible().locator(".terminal-sync-status")).toContainText("Waiting");
  await expect(visible().locator(".xterm-rows")).toContainText("SC_BUSY_DONE", { timeout: 30000 });
  await expect(visible().locator(".terminal-sync-status")).toHaveCount(0, { timeout: 30000 });
  await expectCwd(second, "SC_QUOTED");
  await visible().locator(".xterm-helper-textarea").focus();
  await page.keyboard.type("$sc_pending = 'PRESERVED'");
  await left.getByRole("grid").focus();
  await page.keyboard.press("Backspace");
  await expect(left.getByText("First folder", { exact: true })).toBeVisible();
  await left.getByText("First folder", { exact: true }).dblclick();
  await expect(visible().locator(".terminal-sync-status")).toContainText("Waiting");
  await visible().locator(".xterm-helper-textarea").focus();
  await page.keyboard.press("Enter");
  await expect(visible().locator(".terminal-sync-status")).toHaveCount(0, { timeout: 30000 });
  await run("Write-Output ('SC_PENDING:' + $sc_pending)");
  await expect(visible().locator(".xterm-rows")).toContainText("SC_PENDING:PRESERVED");
  await expectCwd(first, "SC_AFTER_PENDING");
  await run("Write-Output ('SC_' + 'HISTORY_SENTINEL')");
  await expect(visible().locator(".xterm-rows")).toContainText("SC_HISTORY_SENTINEL");
  await left.getByRole("grid").focus();
  await page.keyboard.press("Backspace");
  await expect(left.getByText("O'Brien folder", { exact: true })).toBeVisible();
  await left.getByText("O'Brien folder", { exact: true }).dblclick();
  await expect(visible().locator(".terminal-sync-status")).toHaveCount(0, { timeout: 30000 });
  await visible().locator(".xterm-helper-textarea").focus();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await expect.poll(async () => ((await visible().locator(".xterm-rows").textContent())?.match(/SC_HISTORY_SENTINEL/g) || []).length).toBe(2);
  await run("cd ..");
  await expect(left.getByText("First folder", { exact: true })).toBeVisible();
  await expectCwd(root, "SC_REVERSE");
  await run(`Write-Output ('SC_HISTORY_CLEAN:' + (([Microsoft.PowerShell.PSConsoleReadLine]::GetHistoryItems() | Where-Object { $_.CommandLine -match '^SC[0-9a-f]{32}:' -or $_.CommandLine -match '^Set-Location -LiteralPath.*633;SC:' }).Count -eq 0))`);
  await expect(visible().locator(".xterm-rows")).toContainText("SC_HISTORY_CLEAN:True");
  console.log("PASS reverse shell navigation and clean Up-arrow history");
  console.log("PASS independent terminal tabs, directory following, busy and typed-input deferral, and quoted paths");
} catch (error) {
  console.error("Terminal status:", await visible().locator(".terminal-sync-status").allTextContents().catch(() => []));
  console.error("Terminal output:", await visible().locator(".xterm-rows").innerText().catch(() => "unavailable"));
  throw error;
} finally {
  await instance.close();
}
