import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

// Run only after signing the NSIS installer for this exact version and tag.
const bundleDir = process.argv[2] || "target/release/bundle/nsis";
const { version } = JSON.parse(await readFile("package.json", "utf8"));
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Expected a stable release version");
for (const [manifestName, name] of [
  ["latest.json", `SuperCommander_${version}_x64-setup.exe`],
  ["portable.json", `SuperCommander_${version}_x64.exe`],
]) {
  const signature = (await readFile(join(bundleDir, `${name}.sig`), "utf8")).trim();
  if (!signature) throw new Error(`Missing updater signature for ${name}`);
  const manifest = {
    version,
    platforms: {
      "windows-x86_64": {
        signature,
        url: `https://github.com/rihokirss/SuperCommander/releases/download/v${version}/${basename(name)}`,
      },
    },
  };
  await writeFile(join(bundleDir, manifestName), `${JSON.stringify(manifest, null, 2)}\n`);
}
