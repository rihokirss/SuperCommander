// A temporary loopback-only OpenSSH fixture for the Windows UI smoke test.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const directory = await fs.mkdtemp(
  path.join(os.tmpdir(), "supercommander-sftp-"),
);
const hostKey = path.join(directory, "host"),
  clientKey = path.join(directory, "client");
for (const key of [hostKey, clientKey]) {
  const result = spawnSync("ssh-keygen", [
    "-q",
    "-t",
    "ed25519",
    "-N",
    "",
    "-f",
    key,
  ]);
  if (result.status !== 0) throw new Error(result.stderr.toString());
}
const listener = net.createServer();
await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
const username = os.userInfo().username;
const web = http.createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("SUPERCOMMANDER_TUNNEL_OK");
});
await new Promise((resolve) => web.listen(0, "127.0.0.1", resolve));
const targetPort = web.address().port;
const remotePath = path.join(directory, "files");
await fs.mkdir(remotePath);
await fs.writeFile(
  path.join(remotePath, "remote-only.txt"),
  "A file from the SSH server",
);
const config = path.join(directory, "sshd_config");
await fs.writeFile(
  config,
  `Port ${port}\nListenAddress 127.0.0.1\nHostKey ${hostKey}\nPidFile ${directory}/sshd.pid\nAuthorizedKeysFile ${clientKey}.pub\nStrictModes no\nUsePAM no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPubkeyAuthentication yes\nAllowUsers ${username}\nSubsystem sftp internal-sftp\nLogLevel ERROR\n`,
);
const server = spawn("/usr/sbin/sshd", ["-D", "-e", "-f", config], {
  stdio: ["ignore", "ignore", "inherit"],
});
const fingerprint = spawnSync("ssh-keygen", ["-lf", hostKey + ".pub"])
  .stdout.toString()
  .trim()
  .split(/\s+/)[1];
const windowsKey = spawnSync("wslpath", ["-w", clientKey])
  .stdout.toString()
  .trim();
const fixturePath = fileURLToPath(
  new URL("../artifacts/sftp-fixture.json", import.meta.url),
);
await fs.mkdir(path.dirname(fixturePath), { recursive: true });
await fs.writeFile(
  fixturePath,
  JSON.stringify({
    host: "127.0.0.1",
    port,
    username,
    keyPath: windowsKey,
    path: remotePath,
    fingerprint,
    targetPort,
    uri: `sftp://${username}@127.0.0.1:${port}${remotePath}`,
  }),
);
console.log(
  `Temporary SFTP fixture: ${username}@127.0.0.1:${port}. Press Ctrl+C to stop and remove test keys.`,
);
let stopping = false;
async function cleanup() {
  if (stopping) return;
  stopping = true;
  server.kill();
  web.close();
  await fs.rm(fixturePath, { force: true });
  await fs.rm(directory, { recursive: true, force: true });
  process.exit(0);
}
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
server.on("exit", (code) => {
  if (!stopping) {
    console.error(`sshd exited: ${code}`);
    void cleanup();
  }
});
process.stdin.resume();
