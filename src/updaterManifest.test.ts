import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { version } from "../package.json";

it("publishes the portable suffix in the updater manifest with its matching signature", () => {
  const folder = mkdtempSync(join(tmpdir(), "sc-manifest-"));
  try {
    writeFileSync(join(folder, `SuperCommander_${version}_x64-setup.exe.sig`), "installer-signature\n");
    writeFileSync(join(folder, `SuperCommander_${version}_x64_portable.exe.sig`), "portable-signature\n");
    execFileSync(process.execPath, ["scripts/updater-manifest.mjs", folder]);
    const portable = JSON.parse(readFileSync(join(folder, "portable.json"), "utf8"));
    expect(portable.version).toBe(version);
    expect(portable.platforms["windows-x86_64"]).toEqual({
      signature: "portable-signature",
      url: `https://github.com/rihokirss/SuperCommander/releases/download/v${version}/SuperCommander_${version}_x64_portable.exe`,
    });
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
