// Flow 313 (W4 portability), T6 — verify.ts: checksum-mismatch, missing-entry,
// and unlisted-file detection.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { exportBundle } from "./export";
import { openBundle } from "./archive";
import { parseManifest } from "./manifest";
import { verifyBundle, verifyBundlePath } from "./verify";

let root: string;
let projectRoot: string;
let metaRoot: string;
let outDir: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "keryx-bundle-verify-"));
  projectRoot = path.join(root, "project");
  metaRoot = path.join(projectRoot, ".metaproject", "agents");
  mkdirSync(metaRoot, { recursive: true });
  writeFileSync(
    path.join(metaRoot, "foo.md"),
    "---\nname: foo\ndescription: d\nrole: r\ntools: [read_file]\nmodel_tier: light\npolicy_profile: read-only\noutput_contract: subagent-result\n---\nbody\n",
  );
  outDir = path.join(root, "out");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function buildBundle(): Promise<void> {
  const outcome = await exportBundle({ projectRoot, scope: "project", out: outDir, keryxVersion: "0.2.999", homeDir: path.join(root, "home"), env: {} });
  if (!outcome.ok) throw new Error("fixture export failed");
}

describe("verifyBundle", () => {
  test("a byte-flipped content file reports checksum-mismatch and bundle not ok", async () => {
    await buildBundle();
    const filePath = path.join(outDir, "agents", "foo.md");
    const original = readFileSync(filePath);
    const flipped = Buffer.from(original);
    flipped[flipped.length - 1] = (flipped[flipped.length - 1] as number) ^ 0xff;
    writeFileSync(filePath, flipped);

    const opened = await openBundle(outDir);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const parsed = parseManifest(opened.value.manifestBytes);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const result = verifyBundle(opened.value, parsed.manifest);
    expect(result.ok).toBe(false);
    expect(result.entries.find((e) => e.path === "agents/foo.md")?.status).toBe("checksum-mismatch");
  });

  test("a deleted content file reports missing-entry", async () => {
    await buildBundle();
    rmSync(path.join(outDir, "agents", "foo.md"));

    const result = await verifyBundlePath(outDir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.ok).toBe(false);
    expect(result.result.entries.find((e) => e.path === "agents/foo.md")?.status).toBe("missing-entry");
  });

  test("an extra unlisted file makes the bundle not ok", async () => {
    await buildBundle();
    writeFileSync(path.join(outDir, "agents", "extra.md"), "unexpected");

    const result = await verifyBundlePath(outDir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.ok).toBe(false);
    expect(result.result.unlisted).toContain("agents/extra.md");
  });
});
