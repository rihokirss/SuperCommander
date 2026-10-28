// The loopback fixture and this app instance own all files and connections they create.
import { expect } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startNativeTest, holdNativeCommand } from "./native-test-instance.mjs";
const fixture = JSON.parse(
  await fs.readFile(
    fileURLToPath(new URL("../artifacts/sftp-fixture.json", import.meta.url)),
    "utf8",
  ),
);
const instance = await startNativeTest("ssh-autoconnect", process.argv[2]);
const { page, root } = instance;
const rpc = (name, args = {}) =>
  page.evaluate(
    ({ name, args }) => window.__TAURI_INTERNALS__.invoke(name, args),
    { name, args },
  );
try {
  const config = path.join(root, "ssh_config");
  const key = fixture.keyPath.replaceAll("\\", "/");
  await fs.writeFile(
    config,
    `Host sc-auto\n    HostName ${fixture.host}\n    User ${fixture.username}\n    Port ${fixture.port}\n    IdentityFile "${key}"\nHost sc-bad-key\n    HostName ${fixture.host}\n    User ${fixture.username}\n    Port ${fixture.port}\n    IdentityFile "${key}-missing"\n`,
  );
  const settings = (await rpc("bootstrap", { includeNetwork: false })).settings;
  await rpc("save_settings", {
    value: {
      ...settings,
      language: "en",
      sshConfigPath: config,
      trustedHosts: {
        [`${fixture.host}:${fixture.port}`]: fixture.fingerprint,
      },
    },
  });
  await page.reload();
  const saved = page
    .locator(".sidebar")
    .getByRole("button", { name: "sc-auto", exact: true });
  await expect(saved).toBeVisible({ timeout: 15000 });
  const gate = await holdNativeCommand(page, "connect_sftp");
  await saved.click();
  await gate.entered();
  await expect(saved).toHaveAttribute("aria-busy", "true");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await gate.release();
  await expect(page.locator('[data-pane="0"] .breadcrumbs')).toHaveAttribute(
    "title",
    /sftp:\/\//,
    { timeout: 20000 },
  );
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(saved).toHaveAttribute("aria-busy", "false");
  console.log(
    "PASS saved SSH alias connects directly with configured key and verified fingerprint",
  );
  await page.keyboard.press("F9");
  await page.getByRole("menuitem", { name: /Disconnect/ }).click();
  await expect(
    page.locator('[data-pane="0"] .breadcrumbs'),
  ).not.toHaveAttribute("title", /sftp:\/\//);
  const bad = page
    .locator(".sidebar")
    .getByRole("button", { name: "sc-bad-key", exact: true });
  await bad.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("alert")).toBeVisible({ timeout: 20000 });
  await expect(
    dialog.getByLabel("Connection name", { exact: true }),
  ).toHaveValue("sc-bad-key");
  await expect(
    dialog.getByLabel("SSH private key path (optional)", { exact: true }),
  ).toHaveValue(/missing/);
  await page.keyboard.press("Escape");
  console.log("PASS connection failure opens prefilled form with error");
  const delayed = await holdNativeCommand(page, "connect_sftp");
  await saved.click();
  await delayed.entered();
  const left = page.locator('[data-pane="0"]');
  await left.locator(".breadcrumbs").click();
  await left.locator(".path-form input").fill("C:\\");
  await left.locator(".path-form input").press("Enter");
  await expect(left.locator(".breadcrumbs")).toHaveAttribute("title", "C:\\");
  await delayed.release();
  await expect(saved).toHaveAttribute("aria-busy", "false", { timeout: 20000 });
  await expect(left.locator(".breadcrumbs")).toHaveAttribute("title", "C:\\");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await saved.click();
  await expect(left.locator(".breadcrumbs")).toHaveAttribute(
    "title",
    /sftp:\/\//,
  );
  console.log(
    "PASS delayed connection does not replace a location changed by the user",
  );
  await page.keyboard.press("F9");
  await page.getByRole("menuitem", { name: /Disconnect/ }).click();
  await expect(left.locator(".breadcrumbs")).not.toHaveAttribute(
    "title",
    /sftp:\/\//,
  );
  const current = (await rpc("bootstrap", { includeNetwork: false })).settings;
  await rpc("save_settings", { value: { ...current, trustedHosts: {} } });
  await page.reload();
  await expect(saved).toBeVisible();
  await saved.click();
  await expect(dialog.locator(".host-trust code")).toHaveText(
    fixture.fingerprint,
    { timeout: 20000 },
  );
  await expect(
    dialog.getByRole("button", { name: "Trust and connect" }),
  ).toBeVisible();
  console.log("PASS unknown server key still requires explicit trust");
} finally {
  await instance.close();
}
