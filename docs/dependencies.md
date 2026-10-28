# Dependency review

Checked against the npm and crates.io registries on 2026-10-28 for release 0.3.0. Lockfiles are committed for reproducible installs.

## Updated direct dependencies

| Dependency | Previous locked version | Updated version |
| --- | --- | --- |
| Vite | 6.4.5 | 8.3.5 |
| React Vite plugin | 4.7.0 | 6.1.2 |
| TypeScript | 5.9.3 | 7.0.2 |
| xterm | 5.5.0 | 6.0.0 |
| xterm fit addon | 0.10.0 | 0.11.0 |
| Lucide React | 0.468.0 | 1.62.0 |
| ZIP | 2.6.1 | 9.1.3 |
| russh | 0.63.3 | 0.65.0 |
| keyring | 3.6.3 | 4.2.0 |
| base64 | 0.22.1 | 0.23.1 |
| dirs | 6.0.0 | 7.0.0 |
| window-vibrancy (direct dependency) | 0.6.0 | 0.8.1 |

Other direct dependencies were already at the current stable versions. Cargo also updated compatible transitive dependencies, including notify-types. `@types/node` remains on the latest 24.x release to match Node 24 used for development and CI; npm's latest tag points to the 26.x types.

The ZIP integration uses the new fallible filename API and extra-field writer. A native Windows regression verifies that the upgraded keyring reads the legacy `username.SuperCommander` UTF-16 credential format, updates the same target and removes only its own UUID-named test entry.

## Security audit

`npm audit` reports **0 known vulnerabilities** after the updates.

`cargo audit` reports **one unresolved vulnerability**, [RUSTSEC-2023-0071](https://rustsec.org/advisories/RUSTSEC-2023-0071.html), in `rsa 0.10.0-rc.18`, brought in by current `russh` / `ssh-key` RSA support. The upstream advisory lists no patched version. Updating russh does not remove this advisory. RSA support remains available for compatibility; this release does not claim a clean Rust vulnerability audit. Prefer Ed25519 SSH keys where available.

Cargo's cross-platform lockfile audit also reports unmaintained `proc-macro-error`, `zbus_names`, `zvariant` and `zvariant_derive`, and the `glib` unsoundness advisory RUSTSEC-2024-0429. These are outside the Windows dependency graph; the Linux/macOS desktop and Linux Secret Service dependencies select them. They cannot all be removed by upgrading this application's direct dependencies to their current stable versions.

Run the checks again when preparing the next release:

```sh
npm outdated
npm audit
cargo update --dry-run
cargo audit
cargo tree --workspace --target x86_64-pc-windows-msvc
```
