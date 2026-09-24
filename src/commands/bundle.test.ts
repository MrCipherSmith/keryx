// Flow 313 (W4 portability), T10 — `keryx bundle export|import|inspect|verify|uninstall`.
// In-process command tests: export -> verify -> inspect -> import (dry-run
// writes nothing; a real import writes and prints) -> uninstall, refusal exit
// codes, and the `--force` path. Every test runs against temp directories
// with `KERYX_HOME` pointed at a temp home so nothing touches the real
// `~/.keryx/`.

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { bundleCommand } from "./bundle";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

let originalKeryxHome: string | undefined;
// `process.exitCode`'s own type is `number | string | undefined` (Node's
// typings) — matched exactly here rather than narrowed to `number |
// undefined`, so the assignment back to `process.exitCode` in `afterEach`
// below needs no cast.
let originalExitCode: typeof process.exitCode;

beforeEach(() => {
  originalKeryxHome = process.env.KERYX_HOME;
  // These tests exercise `bundleCommand`'s own `process.exitCode = ...`
  // side effect directly (several assert a nonzero code, e.g. the usage-
  // error tests below). Without saving/restoring it here, a test that sets
  // a nonzero code leaves it set for every test (and file) that runs
  // AFTER it in the same process — bun's own `bun test` exit code then
  // reflects that leftover value instead of this file's actual pass/fail,
  // which can make an unrelated CI shard exit nonzero depending on file
  // order.
  originalExitCode = process.exitCode;
});

afterEach(async () => {
  if (originalKeryxHome === undefined) delete process.env.KERYX_HOME;
  else process.env.KERYX_HOME = originalKeryxHome;
  process.exitCode = originalExitCode;
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

let captured: string[] = [];
let capturedErr: string[] = [];
let originalLog: typeof console.log;
let originalErr: typeof console.error;

function install(): void {
  captured = [];
  capturedErr = [];
  originalLog = console.log;
  originalErr = console.error;
  console.log = (...parts: unknown[]) => captured.push(parts.map(String).join(" "));
  console.error = (...parts: unknown[]) => capturedErr.push(parts.map(String).join(" "));
  process.exitCode = 0;
}

function restore(): void {
  console.log = originalLog;
  console.error = originalErr;
}

async function makeSourceProject(): Promise<string> {
  const root = await makeTempDir("keryx-bundle-src-");
  await mkdir(path.join(root, ".metaproject", "skills", "acme-widget"), { recursive: true });
  await writeFile(
    path.join(root, ".metaproject", "skills", "acme-widget", "SKILL.md"),
    "---\nname: acme-widget\ndescription: Build acme widgets\n---\nBody text.\n",
    "utf8",
  );
  return root;
}

async function makeSourceProjectWithRule(): Promise<string> {
  const root = await makeTempDir("keryx-bundle-src-rule-");
  await mkdir(path.join(root, ".metaproject", "rules", "core"), { recursive: true });
  await writeFile(
    path.join(root, ".metaproject", "rules", "core", "acme-rule.mdc"),
    '---\ndescription: "Always widget acme-style."\n---\n\n# acme-rule\n\nBody.\n',
    "utf8",
  );
  return root;
}

function lastJson(): unknown {
  return JSON.parse(captured.join("\n"));
}

describe("keryx bundle export -> verify -> inspect -> import -> uninstall", () => {
  test("full lifecycle across two project roots, with a temp KERYX_HOME", async () => {
    const home = await makeTempDir("keryx-bundle-home-");
    process.env.KERYX_HOME = home;

    const sourceRoot = await makeSourceProject();
    const bundleDir = path.join(await makeTempDir("keryx-bundle-out-"), "bundle-out");

    install();
    try {
      await bundleCommand(["export", "--scope", "project", "--id", "test-bundle", bundleDir, "--json"], sourceRoot);
      expect(process.exitCode).toBe(0);
      expect(capturedErr).toEqual([]);
      const exportResult = lastJson() as { ok: boolean; bundleId: string; entries: number };
      expect(exportResult.ok).toBe(true);
      expect(exportResult.bundleId).toBe("test-bundle");
      expect(exportResult.entries).toBe(1);
      expect(existsSync(path.join(bundleDir, "bundle.json"))).toBe(true);
    } finally {
      restore();
    }

    // verify
    install();
    try {
      await bundleCommand(["verify", bundleDir, "--json"], sourceRoot);
      expect(process.exitCode).toBe(0);
      const verifyResult = lastJson() as { ok: boolean; bundleId: string };
      expect(verifyResult.ok).toBe(true);
      expect(verifyResult.bundleId).toBe("test-bundle");
    } finally {
      restore();
    }

    const targetRoot = await makeTempDir("keryx-bundle-target-");

    // inspect against a fresh target: entry should be "new"
    install();
    try {
      await bundleCommand(["inspect", bundleDir, "--json"], targetRoot);
      expect(process.exitCode).toBe(0);
      const inspectResult = lastJson() as { ok: boolean; entries: Array<{ bucket: string }> };
      expect(inspectResult.ok).toBe(true);
      expect(inspectResult.entries[0]?.bucket).toBe("new");
    } finally {
      restore();
    }

    // dry-run import: writes nothing
    install();
    try {
      await bundleCommand(["import", bundleDir, "--dry-run", "--json"], targetRoot);
      expect(process.exitCode).toBe(0);
      expect(existsSync(path.join(targetRoot, ".metaproject", "skills", "acme-widget", "SKILL.md"))).toBe(false);
    } finally {
      restore();
    }

    // real import: writes and prints
    install();
    try {
      await bundleCommand(["import", bundleDir, "--json"], targetRoot);
      expect(process.exitCode).toBe(0);
      const importResult = lastJson() as { ok: boolean; bundleId: string; written: string[] };
      expect(importResult.ok).toBe(true);
      expect(importResult.written).toEqual(["project:skills/acme-widget/SKILL.md"]);
      const written = await readFile(path.join(targetRoot, ".metaproject", "skills", "acme-widget", "SKILL.md"), "utf8");
      expect(written).toContain("acme-widget");
    } finally {
      restore();
    }

    // uninstall
    install();
    try {
      await bundleCommand(["uninstall", "test-bundle", "--target-scope", "project", "--json"], targetRoot);
      expect(process.exitCode).toBe(0);
      const uninstallResult = lastJson() as { ok: boolean; removed: string[] };
      expect(uninstallResult.ok).toBe(true);
      expect(uninstallResult.removed).toEqual(["skills/acme-widget/SKILL.md"]);
      expect(existsSync(path.join(targetRoot, ".metaproject", "skills", "acme-widget", "SKILL.md"))).toBe(false);
    } finally {
      restore();
    }
  });

  test("re-importing after a hand-edit conflicts, and --force overwrites it", async () => {
    const home = await makeTempDir("keryx-bundle-home-");
    process.env.KERYX_HOME = home;

    const sourceRoot = await makeSourceProject();
    const bundleDir = path.join(await makeTempDir("keryx-bundle-out-"), "bundle-out");

    install();
    try {
      await bundleCommand(["export", "--scope", "project", "--id", "force-bundle", bundleDir, "--json"], sourceRoot);
    } finally {
      restore();
    }

    const targetRoot = await makeTempDir("keryx-bundle-target-");

    install();
    try {
      await bundleCommand(["import", bundleDir, "--json"], targetRoot);
      expect(process.exitCode).toBe(0);
    } finally {
      restore();
    }

    // Hand-edit the written file outside Keryx's own write.
    const writtenPath = path.join(targetRoot, ".metaproject", "skills", "acme-widget", "SKILL.md");
    await writeFile(writtenPath, "hand-edited content\n", "utf8");

    // Re-importing the same bundle now conflicts and refuses.
    install();
    try {
      await bundleCommand(["import", bundleDir, "--json"], targetRoot);
      expect(process.exitCode).toBe(1);
      const refused = lastJson() as { ok: boolean; refusals: Array<{ reason: string }> };
      expect(refused.ok).toBe(false);
      expect(refused.refusals.some((r) => r.reason === "unresolved-conflict")).toBe(true);
      // Nothing was written over the hand edit.
      expect(await readFile(writtenPath, "utf8")).toBe("hand-edited content\n");
    } finally {
      restore();
    }

    // --force names the conflicting entry and overwrites it.
    install();
    try {
      await bundleCommand(["import", bundleDir, "--force", "skills/acme-widget/SKILL.md", "--json"], targetRoot);
      expect(process.exitCode).toBe(0);
      const forced = lastJson() as { ok: boolean; written: string[] };
      expect(forced.ok).toBe(true);
      expect(forced.written).toEqual(["project:skills/acme-widget/SKILL.md"]);
      expect(await readFile(writtenPath, "utf8")).toContain("acme-widget");
    } finally {
      restore();
    }
  });
});

describe("keryx bundle — refusal and usage exit codes", () => {
  test("export with an unknown --scope is a usage error, exit 2", async () => {
    const home = await makeTempDir("keryx-bundle-home-");
    process.env.KERYX_HOME = home;
    const root = await makeTempDir("keryx-bundle-usage-");

    install();
    try {
      await bundleCommand(["export", "--scope", "nonsense", path.join(root, "out")], root);
      expect(process.exitCode).toBe(2);
      expect(capturedErr.join("\n")).toContain("--scope must be one of");
    } finally {
      restore();
    }
  });

  test("export with no --scope at all is a usage error, exit 2", async () => {
    const home = await makeTempDir("keryx-bundle-home-");
    process.env.KERYX_HOME = home;
    const root = await makeTempDir("keryx-bundle-usage-");

    install();
    try {
      await bundleCommand(["export", path.join(root, "out")], root);
      expect(process.exitCode).toBe(2);
    } finally {
      restore();
    }
  });

  // R2-F21 (missing regression test for R1-F24): running `bundle export`
  // from a SUBDIRECTORY of an already-initialized project must resolve to
  // the project's REAL root — the one that already has `.metaproject/` and
  // the content to export — not create a second, nested `.metaproject/`
  // under the subdirectory (which would also export nothing, since there
  // is no content there). Fails on the pre-R1-F24 code, which used `cwd`
  // directly as the project root.
  test("R1-F24: export run from a project subdirectory resolves to the project's real root, not a nested one", async () => {
    const home = await makeTempDir("keryx-bundle-home-");
    process.env.KERYX_HOME = home;
    const sourceRoot = await makeSourceProject();
    const deepCwd = path.join(sourceRoot, "src", "deep");
    await mkdir(deepCwd, { recursive: true });
    const bundleDir = path.join(await makeTempDir("keryx-bundle-out-"), "bundle-out");

    install();
    try {
      await bundleCommand(["export", "--scope", "project", "--id", "test-bundle-deep", bundleDir, "--json"], deepCwd);
      expect(process.exitCode).toBe(0);
      const exportResult = lastJson() as { ok: boolean; entries: number };
      expect(exportResult.ok).toBe(true);
      // The skill under sourceRoot/.metaproject was found — proof the real
      // root was used, not an empty nested one under deepCwd.
      expect(exportResult.entries).toBe(1);
    } finally {
      restore();
    }
    expect(existsSync(path.join(deepCwd, ".metaproject"))).toBe(false);
  });

  test("verify on a bundle with a tampered checksum fails closed, exit 1", async () => {
    const home = await makeTempDir("keryx-bundle-home-");
    process.env.KERYX_HOME = home;

    const sourceRoot = await makeSourceProject();
    const bundleDir = path.join(await makeTempDir("keryx-bundle-out-"), "bundle-out");

    install();
    try {
      await bundleCommand(["export", "--scope", "project", "--id", "tamper-bundle", bundleDir, "--json"], sourceRoot);
    } finally {
      restore();
    }

    // Tamper with an exported file's bytes, same length, without updating
    // bundle.json's checksum — this trips checksum-mismatch specifically
    // rather than the (also-refusing) size-mismatch path.
    const original = await readFile(path.join(bundleDir, "skills", "acme-widget", "SKILL.md"), "utf8");
    await writeFile(path.join(bundleDir, "skills", "acme-widget", "SKILL.md"), "X".repeat(original.length), "utf8");

    install();
    try {
      await bundleCommand(["verify", bundleDir, "--json"], sourceRoot);
      expect(process.exitCode).toBe(1);
      const result = lastJson() as { ok: boolean; entries: Array<{ status: string }> };
      expect(result.ok).toBe(false);
      expect(result.entries.some((e) => e.status === "checksum-mismatch")).toBe(true);
    } finally {
      restore();
    }
  });

  test("uninstall requires --target-scope, exit 2", async () => {
    const home = await makeTempDir("keryx-bundle-home-");
    process.env.KERYX_HOME = home;
    const root = await makeTempDir("keryx-bundle-usage-");

    install();
    try {
      await bundleCommand(["uninstall", "some-bundle"], root);
      expect(process.exitCode).toBe(2);
    } finally {
      restore();
    }
  });
});

describe("keryx bundle import --render-for", () => {
  test("importing a rule with --render-for cursor writes the managed keryx:rules block into .cursor/rules/keryx-rules.mdc", async () => {
    const home = await makeTempDir("keryx-bundle-home-");
    process.env.KERYX_HOME = home;

    const sourceRoot = await makeSourceProjectWithRule();
    const bundleDir = path.join(await makeTempDir("keryx-bundle-out-"), "bundle-out");

    install();
    try {
      await bundleCommand(["export", "--scope", "project", "--id", "rule-bundle", bundleDir, "--json"], sourceRoot);
      expect(process.exitCode).toBe(0);
    } finally {
      restore();
    }

    const targetRoot = await makeTempDir("keryx-bundle-target-");

    install();
    try {
      await bundleCommand(["import", bundleDir, "--render-for", "cursor", "--json"], targetRoot);
      expect(process.exitCode).toBe(0);
      const result = lastJson() as { ok: boolean; written: string[]; rendered?: Array<{ harness: string; status: string; file?: string }> };
      expect(result.ok).toBe(true);
      expect(result.written).toContain("project:rules/core/acme-rule.mdc");
      expect(result.rendered?.some((r) => r.harness === "cursor" && r.file === ".cursor/rules/keryx-rules.mdc")).toBe(true);
    } finally {
      restore();
    }

    const rendered = await readFile(path.join(targetRoot, ".cursor", "rules", "keryx-rules.mdc"), "utf8");
    expect(rendered).toContain("<!-- keryx:rules -->");
    expect(rendered).toContain("<!-- /keryx:rules -->");
    expect(rendered).toContain("acme-rule.mdc");
  });

  test("importing a rule with no --render-for and no rules-export surface installed creates no harness file", async () => {
    const home = await makeTempDir("keryx-bundle-home-");
    process.env.KERYX_HOME = home;

    const sourceRoot = await makeSourceProjectWithRule();
    const bundleDir = path.join(await makeTempDir("keryx-bundle-out-"), "bundle-out");

    install();
    try {
      await bundleCommand(["export", "--scope", "project", "--id", "rule-bundle-noharness", bundleDir, "--json"], sourceRoot);
    } finally {
      restore();
    }

    const targetRoot = await makeTempDir("keryx-bundle-target-");

    install();
    try {
      await bundleCommand(["import", bundleDir, "--json"], targetRoot);
      expect(process.exitCode).toBe(0);
      const result = lastJson() as { ok: boolean; written: string[]; rendered?: unknown };
      expect(result.ok).toBe(true);
      expect(result.written).toContain("project:rules/core/acme-rule.mdc");
      expect(result.rendered).toBeUndefined();
    } finally {
      restore();
    }

    expect(existsSync(path.join(targetRoot, "CLAUDE.md"))).toBe(false);
    expect(existsSync(path.join(targetRoot, ".cursor", "rules", "keryx-rules.mdc"))).toBe(false);
  });

  // handleImport validates every --render-for id up front — before
  // opening/planning the bundle — against the W5 harness registry, so an
  // unknown id refuses closed (exit 2, zero writes) instead of importing
  // successfully and only being reported "unsupported" afterward.
  test("an unknown --render-for harness id is refused (exit 2) before anything is written", async () => {
    const home = await makeTempDir("keryx-bundle-home-");
    process.env.KERYX_HOME = home;

    const sourceRoot = await makeSourceProjectWithRule();
    const bundleDir = path.join(await makeTempDir("keryx-bundle-out-"), "bundle-out");

    install();
    try {
      await bundleCommand(["export", "--scope", "project", "--id", "rule-bundle-unknown", bundleDir, "--json"], sourceRoot);
    } finally {
      restore();
    }

    const targetRoot = await makeTempDir("keryx-bundle-target-");

    install();
    try {
      await bundleCommand(["import", bundleDir, "--render-for", "not-a-real-harness", "--json"], targetRoot);
      expect(process.exitCode).toBe(2);
    } finally {
      restore();
    }

    // Nothing was written: neither the imported rule file nor any harness file.
    expect(existsSync(path.join(targetRoot, ".metaproject", "rules", "core", "acme-rule.mdc"))).toBe(false);
  });

  // A known harness id whose adapter registers no `rules-export` surface
  // (e.g. "opencode") is refused the same way as an unknown id — never
  // silently imported and reported "unsupported" only after the fact.
  test("a known --render-for harness id with no rules-export surface is refused (exit 2) before anything is written", async () => {
    const home = await makeTempDir("keryx-bundle-home-");
    process.env.KERYX_HOME = home;

    const sourceRoot = await makeSourceProjectWithRule();
    const bundleDir = path.join(await makeTempDir("keryx-bundle-out-"), "bundle-out");

    install();
    try {
      await bundleCommand(["export", "--scope", "project", "--id", "rule-bundle-no-surface", bundleDir, "--json"], sourceRoot);
    } finally {
      restore();
    }

    const targetRoot = await makeTempDir("keryx-bundle-target-");

    install();
    try {
      await bundleCommand(["import", bundleDir, "--render-for", "opencode", "--json"], targetRoot);
      expect(process.exitCode).toBe(2);
    } finally {
      restore();
    }

    // Nothing was written: neither the imported rule file nor any harness file.
    expect(existsSync(path.join(targetRoot, ".metaproject", "rules", "core", "acme-rule.mdc"))).toBe(false);
  });
});
