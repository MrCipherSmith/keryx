#!/usr/bin/env bun
/**
 * Short global install / update entrypoint (Bun).
 *
 *   bun https://raw.githubusercontent.com/MrCipherSmith/keryx/main/install.ts
 *
 * Same effect as:
 *   curl -fsSL …/scripts/install.sh | bash -s -- --global
 *
 * Env (optional):
 *   KERYX_REF              Git ref for the raw installer (default: main)
 *   KERYX_INSTALL_SH_URL   Full URL override for scripts/install.sh
 *   KERYX_REPO_URL         Forwarded to scripts/install.sh
 */

const REF = process.env.KERYX_REF ?? "main";
const INSTALL_SH_URL =
  process.env.KERYX_INSTALL_SH_URL ??
  `https://raw.githubusercontent.com/MrCipherSmith/keryx/${REF}/scripts/install.sh`;

const res = await fetch(INSTALL_SH_URL);
if (!res.ok) {
  console.error(`Failed to fetch installer (${res.status}): ${INSTALL_SH_URL}`);
  process.exit(1);
}

const script = await res.text();
const extraArgs = process.argv.slice(2);
const proc = Bun.spawn(["bash", "-s", "--", "--global", ...extraArgs], {
  stdin: new Blob([script]),
  stdout: "inherit",
  stderr: "inherit",
  env: process.env,
});

process.exit(await proc.exited);
