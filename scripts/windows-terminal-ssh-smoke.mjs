// Optional: provide a disposable SSH fixture JSON as the second argument.
import { expect } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { startNativeTest } from "./native-test-instance.mjs";

if (!process.argv[3]) throw new Error("Pass the path to a disposable SSH fixture JSON");
const fixture = JSON.parse(await fs.readFile(process.argv[3], "utf8"));
const instance = await startNativeTest("terminal-ssh", process.argv[2]);
const { page, root } = instance;
const visible = () => page.locator(".terminal-panel:visible");
const rpc = (command, args = {}) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
async function run(command) {
  await visible().locator(".xterm-helper-textarea").focus();
  await page.keyboard.type(command);
  await page.keyboard.press("Enter");
}
async function expectCwd(folder, token) {
  await run(`if [ "$PWD" = ${quote(folder)} ]; then printf '%s%s\\n' '${token}' '_OK'; else printf '%s%s\\n' '${token}' '_BAD'; fi`);
  await expect(visible().locator(".xterm-rows")).toContainText(`${token}_OK`, { timeout: 30000 });
}
try {
  const config = path.join(root, "ssh_config");
  await fs.writeFile(config, "");
  const settings = (await rpc("bootstrap", { includeNetwork: false })).settings;
  await rpc("save_settings", { value: { ...settings, language: "en", sshConfigPath: config } });
  await page.reload();
  const left = page.locator('[data-pane="0"]');
  await left.locator(".breadcrumbs").click();
  await left.locator(".path-form input").fill(`sftp://${fixture.username}@${fixture.host}:${fixture.port}${fixture.path}`);
  await left.locator(".path-form input").press("Enter");
  const connect = page.getByRole("dialog");
  await connect.getByLabel("SSH private key path (optional)", { exact: true }).fill(fixture.keyPath);
  await connect.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(connect.locator(".host-trust code")).toHaveText(fixture.fingerprint, { timeout: 20000 });
  await connect.getByRole("button", { name: "Trust and connect", exact: true }).click();
  await expect(connect).toHaveCount(0, { timeout: 20000 });
  await expect(left.getByText("First remote", { exact: true })).toBeVisible({ timeout: 30000 });
  await left.getByRole("grid").focus();
  await page.keyboard.press("Control+Backquote");
  await expect(visible().locator(".terminal-sync-status")).toHaveCount(0, { timeout: 30000 });
  await expectCwd(fixture.path, "SC_REMOTE_ROOT");
  const remoteTab = await visible().getAttribute("data-terminal-id");
  await page.locator('[data-pane="1"] .file-grid').focus();
  await expect(visible()).toHaveAttribute("data-terminal-source", "local", { timeout: 30000 });
  await left.getByRole("grid").focus();
  await expect(visible()).toHaveAttribute("data-terminal-id", remoteTab, { timeout: 30000 });
  await left.getByText("First remote", { exact: true }).dblclick();
  await expect(visible().locator(".terminal-sync-status")).toHaveCount(0, { timeout: 30000 });
  await expectCwd(`${fixture.path}/First remote`, "SC_REMOTE_FIRST");
  await run("sc_test=FIRST_REMOTE");
  await visible().getByRole("button", { name: "New terminal tab" }).click();
  await expect(page.locator(".terminal-panel")).toHaveCount(3);
  await expect(visible().locator(".terminal-sync-status")).toHaveCount(0, { timeout: 30000 });
  await expectCwd(`${fixture.path}/First remote`, "SC_REMOTE_SECOND");
  await visible().locator(`button[data-terminal-tab-id="${remoteTab}"]`).click();
  await run('printf "SC_REMOTE_VAR:%s\\n" "$sc_test"');
  await expect(visible().locator(".xterm-rows")).toContainText("SC_REMOTE_VAR:FIRST_REMOTE");
  await run("sleep 4; printf 'SC_REMOTE_BUSY_DONE\\n'");
  await left.getByRole("grid").focus();
  await page.keyboard.press("Backspace");
  await expect(left.getByText("O'Brien remote", { exact: true })).toBeVisible();
  await left.getByText("O'Brien remote", { exact: true }).dblclick();
  await expect(visible().locator(".terminal-sync-status")).toContainText("Waiting");
  await expect(visible().locator(".xterm-rows")).toContainText("SC_REMOTE_BUSY_DONE", { timeout: 30000 });
  await expect(visible().locator(".terminal-sync-status")).toHaveCount(0, { timeout: 30000 });
  await expectCwd(`${fixture.path}/O'Brien remote`, "SC_REMOTE_QUOTED");
  await visible().locator(".xterm-helper-textarea").focus();
  await page.keyboard.type("sc_pending=KEPT_REMOTE");
  await left.getByRole("grid").focus();
  await page.keyboard.press("Backspace");
  await expect(left.getByText("First remote", { exact: true })).toBeVisible();
  await left.getByText("First remote", { exact: true }).dblclick();
  await expect(visible().locator(".terminal-sync-status")).toContainText("Waiting");
  await visible().locator(".xterm-helper-textarea").focus();
  await page.keyboard.press("Enter");
  await expect(visible().locator(".terminal-sync-status")).toHaveCount(0, { timeout: 30000 });
  await run('printf "SC_PENDING:%s\\n" "$sc_pending"');
  await expect(visible().locator(".xterm-rows")).toContainText("SC_PENDING:KEPT_REMOTE");
  await expectCwd(`${fixture.path}/First remote`, "SC_REMOTE_AFTER_PENDING");
  console.log("PASS SSH shell tabs, initial path, following, busy and typed-input deferral, and quoted paths");
} catch (error) {
  console.error("SSH terminal status:", await visible().locator(".terminal-sync-status").allTextContents().catch(() => []));
  console.error("SSH terminal output:", await visible().locator(".xterm-rows").innerText({ timeout: 500 }).catch(() => "unavailable"));
  throw error;
} finally {
  await instance.close();
}
