// Uses an explicitly supplied, disposable OpenSSH fixture; never the user's config.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "@playwright/test";
import { startNativeTest } from "./native-test-instance.mjs";

if (!process.argv[3]) throw Error("Pass a disposable SSH fixture JSON");
const fixture = JSON.parse(await fs.readFile(process.argv[3], "utf8"));
const instance = await startNativeTest("forwarding", process.argv[2]);
const { page, root } = instance;
const rpc = (command, args = {}) => page.evaluate(({ command, args }) =>
  window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
const external = net.createServer((socket) => socket.end("EXTERNAL_LISTENER"));
const reserve = net.createServer();
await new Promise((resolve) => external.listen(0, "127.0.0.1", resolve));
await new Promise((resolve) => reserve.listen(0, "127.0.0.1", resolve));
const externalPort = external.address().port;
const localPort = reserve.address().port;
await new Promise((resolve) => reserve.close(resolve));
async function banner(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.setTimeout(5000, () => socket.destroy(Error("Listener timed out")));
    socket.once("error", reject);
    socket.once("data", (data) => { socket.destroy(); resolve(data.toString()); });
  });
}
async function openForwards() {
  await page.locator(".titlebar-tools .menu-anchor>button").click();
  await page.getByRole("menuitem", { name: "Port forwarding", exact: true }).click();
  return page.getByRole("dialog");
}
async function connect(alias) {
  await page.locator(".sidebar").getByRole("button", { name: alias, exact: true }).click();
  await expect(page.locator('[data-pane="0"] .pane-context')).toContainText(fixture.username + "@", { timeout: 30000 });
  await expect.poll(async () => {
    try { return (await rpc("list_forwards", { source: profiles[alias].source })).length; }
    catch { return -1; }
  }, { timeout: 30000 }).toBe(0);
}
let profiles;
try {
  const config = path.join(root, "ssh_config");
  const original = [
    "# fixture comments must survive",
    ...["sc-first", "sc-second"].flatMap((alias) => [
      `Host ${alias}`, ` HostName ${fixture.host}`, ` User ${fixture.username}`,
      ` Port ${fixture.port}`, ` IdentityFile "${fixture.keyPath}"`,
      ...(alias === "sc-first" ? [` LocalForward 127.0.0.1:${localPort} 127.0.0.1:${fixture.port} # saved in old app`] : []),
      " ServerAliveInterval 15",
    ]), "",
  ].join("\r\n");
  await fs.writeFile(config, original);
  const catalog = await rpc("read_ssh_config", { path: config });
  profiles = Object.fromEntries(catalog.hosts.map((host) => [host.alias, { ...host.profile, source: `sftp:${host.profile.id}` }]));
  const bootstrap = await rpc("bootstrap", { includeNetwork: false });
  await rpc("save_settings", { value: {
    ...bootstrap.settings, language: "en", sshConfigPath: config,
    trustedHosts: { [`${fixture.host}:${fixture.port}`]: fixture.fingerprint },
  } });
  await page.reload();
  await page.locator('[data-pane="0"] .file-grid').focus();
  await connect("sc-first");
  assert.equal(await fs.readFile(config, "utf8"), original);
  console.log("PASS shared SSH config forwards are not opened automatically");
  let dialog = await openForwards();
  await dialog.getByRole("button", { name: "Move from SSH config", exact: true }).click();
  await expect(dialog.locator(".forward-migration")).toHaveCount(0);
  await expect(dialog.locator(".forward-row")).toHaveCount(1);
  await expect(dialog.getByRole("checkbox")).toBeChecked();
  const migrated = await fs.readFile(config, "utf8");
  assert.ok(!migrated.includes("LocalForward"));
  assert.ok(migrated.includes("# saved in old app\r\n"));
  assert.ok(migrated.includes("Host sc-second\r\n"));
  assert.ok((await fs.readdir(root)).some((name) => name.endsWith(".bak")));
  await dialog.getByRole("button", { name: "Start", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  assert.match(await banner(localPort), /^SSH-/);
  const first = (await rpc("list_forwards", { source: profiles["sc-first"].source }))[0];
  const reused = await rpc("start_forward", { source: profiles["sc-first"].source, localPort, remoteHost: "127.0.0.1", remotePort: fixture.port });
  assert.equal(reused.id, first.id);
  await dialog.getByRole("checkbox").click();
  await expect(dialog.getByRole("checkbox")).not.toBeChecked();
  await dialog.getByRole("checkbox").click();
  await expect(dialog.getByRole("checkbox")).toBeChecked();
  assert.equal(await fs.readFile(config, "utf8"), migrated);
  console.log("PASS moving a legacy forward backs up config; Remember only updates app settings");
  await page.keyboard.press("Escape");
  await connect("sc-second");
  dialog = await openForwards();
  await dialog.getByLabel("Local port (0 = automatic)", { exact: true }).fill(String(localPort));
  await dialog.getByLabel("Target port", { exact: true }).fill(String(fixture.port));
  await dialog.getByRole("button", { name: "Create tunnel", exact: true }).click();
  let conflict = page.getByRole("alertdialog", { name: "Local port is in use" });
  await expect(conflict).toContainText("sc-first");
  await conflict.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal((await rpc("list_forwards", { source: profiles["sc-first"].source }))[0].id, first.id);
  await dialog.getByRole("button", { name: "Create tunnel", exact: true }).click();
  await conflict.getByRole("button", { name: "Switch tunnel", exact: true }).click();
  await expect(conflict).toHaveCount(0);
  await expect(dialog.locator(".forward-row")).toHaveCount(1);
  assert.deepEqual(await rpc("list_forwards", { source: profiles["sc-first"].source }), []);
  const second = (await rpc("list_forwards", { source: profiles["sc-second"].source }))[0];
  assert.equal(second.localPort, localPort);
  assert.match(await banner(localPort), /^SSH-/);
  await assert.rejects(rpc("start_forward", {
    source: profiles["sc-first"].source, localPort, remoteHost: "127.0.0.1", remotePort: fixture.port,
    replace: { source: profiles["sc-first"].source, id: first.id },
  }));
  assert.equal((await rpc("list_forwards", { source: profiles["sc-second"].source }))[0].id, second.id);
  await dialog.getByRole("checkbox").click();
  await expect(dialog.getByRole("checkbox")).toBeChecked();
  assert.equal((await rpc("list_saved_forwards", { source: profiles["sc-first"].source }))[0].localPort, localPort);
  assert.equal((await rpc("list_saved_forwards", { source: profiles["sc-second"].source }))[0].localPort, localPort);
  console.log("PASS same saved port on separate connections; Cancel, explicit switch and stale-owner protection");
  await dialog.getByLabel("Local port (0 = automatic)", { exact: true }).fill(String(externalPort));
  await dialog.getByRole("button", { name: "Create tunnel", exact: true }).click();
  await expect(conflict).toContainText("Another program");
  await expect(conflict.getByRole("button", { name: "Switch tunnel", exact: true })).toHaveCount(0);
  await conflict.getByRole("button", { name: "Use a free port", exact: true }).click();
  await expect(conflict).toHaveCount(0);
  await expect(dialog.locator(".forward-row")).toHaveCount(2);
  assert.equal(await banner(externalPort), "EXTERNAL_LISTENER");
  const free = (await rpc("list_forwards", { source: profiles["sc-second"].source })).find((f) => f.localPort !== localPort);
  assert.notEqual(free.localPort, externalPort);
  assert.match(await banner(free.localPort), /^SSH-/);
  assert.equal(await fs.readFile(config, "utf8"), migrated);
  await fs.access(path.join(root, "Settings", "forwards.backup.json"));
  if (process.argv.includes("--update-screenshot")) {
    await dialog.screenshot({ path: fileURLToPath(new URL("../docs/screenshots/port-forwarding.png", import.meta.url)) });
  }
  await rpc("disconnect_sftp", { source: profiles["sc-second"].source });
  const reopened = await rpc("connect_sftp", { profile: profiles["sc-first"], secret: "", expected: fixture.fingerprint });
  assert.deepEqual(reopened.forwardErrors, []);
  assert.match(await banner(localPort), /^SSH-/);
  console.log("PASS external listener is preserved, a free port works, and app-saved forwards reopen on connection");
} finally {
  await instance.close();
  await new Promise((resolve) => external.close(resolve));
}
