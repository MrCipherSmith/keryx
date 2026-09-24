// Flow 308 (W8) review round 1 — CLI-level regressions for
// `keryx security audit-harness`, run through `handleAuditHarness` in-process
// (the pattern `security-gate-exit.test.ts` already uses for `securityCommand`).
//
// F5: `resolveRoot` mistaking an option VALUE for the root positional, and a
//     nonexistent/non-directory root not being refused.
// F27: `apply` ignoring an explicit [path] positional.
// F24: no CLI-level `--ci` exit-code test existed at all.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { handleAuditHarness } from "./security-audit-harness";

let root = "";

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = "";
  process.exitCode = 0;
});

async function makeRoot(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  await mkdir(path.join(dir, ".metaproject"), { recursive: true });
  return dir;
}

/** Run `handleAuditHarness` in-process and capture stdout/stderr + exit code. */
async function run(cwd: string, args: string[]): Promise<{ exit: number; out: string; err: string }> {
  const outLines: string[] = [];
  const errLines: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalExitCode = process.exitCode;
  try {
    console.log = (...parts: unknown[]) => outLines.push(parts.map(String).join(" "));
    console.error = (...parts: unknown[]) => errLines.push(parts.map(String).join(" "));
    process.exitCode = 0;
    await handleAuditHarness(cwd, args);
    return { exit: process.exitCode ?? 0, out: outLines.join("\n"), err: errLines.join("\n") };
  } finally {
    console.log = originalLog;
    console.error = originalError;
    process.exitCode = originalExitCode ?? 0;
  }
}

// --- F5 ----------------------------------------------------------------------

describe("F5: resolveRoot no longer swallows an option's value as the root positional", () => {
  test("`--baseline <file> --ci` does not treat the baseline file as the project root", async () => {
    root = await makeRoot("keryx-f5-baseline-value-");
    await writeFile(path.join(root, "CLAUDE.md"), "# ok\n", "utf8");

    const { exit, out } = await run(root, [".", "--baseline", "b.json", "--ci", "--json"]);
    const report = JSON.parse(out) as { root: string; coverage: { status: string } };
    // The audit ran against the project root, not against "b.json" — the
    // clearest observable signal is that `report.root` is the resolved `.`
    // path, and the run completed with a real coverage status rather than
    // failing to even resolve a directory.
    expect(report.root).toBe(path.resolve(root, "."));
    expect(["complete", "incomplete"]).toContain(report.coverage.status);
    expect(exit).toBe(0);
  });

  test("a nonexistent root is refused with exit 1, with or without --ci", async () => {
    root = await makeRoot("keryx-f5-missing-root-");

    const withoutCi = await run(root, ["./does-not-exist"]);
    expect(withoutCi.exit).toBe(1);
    expect(withoutCi.err).toMatch(/no such directory/i);

    const withCi = await run(root, ["./does-not-exist", "--ci"]);
    expect(withCi.exit).toBe(1);
  });

  test("a root that resolves to a FILE, not a directory, is refused with exit 1", async () => {
    root = await makeRoot("keryx-f5-file-root-");
    await writeFile(path.join(root, "not-a-dir.txt"), "hi\n", "utf8");

    const { exit, err } = await run(root, ["./not-a-dir.txt", "--ci"]);
    expect(exit).toBe(1);
    expect(err).toMatch(/no such directory/i);
  });
});

// --- F27 -----------------------------------------------------------------------

describe("F27: apply accepts an explicit [path] root, consistent with the audit run", () => {
  test("apply --proposal <id> [path] resolves against the given path, not only cwd", async () => {
    root = await makeRoot("keryx-f27-apply-root-");
    const project = path.join(root, "project");
    await mkdir(path.join(project, ".claude"), { recursive: true });
    await mkdir(path.join(project, ".metaproject"), { recursive: true });
    await writeFile(
      path.join(project, ".claude", "settings.json"),
      `${JSON.stringify({ permissions: { allow: ["Bash(*)"] } }, null, 2)}\n`,
      "utf8",
    );

    // Run FROM `root` (not `project`) with `--fix-proposals --json` scoped to
    // the explicit path, exactly like the audit-run subcommand already
    // supports — this is what a proposal id has to be discovered from.
    const { out } = await run(root, ["./project", "--fix-proposals", "--json"]);
    const report = JSON.parse(out) as {
      findings: Array<{ check: string; fixProposal?: { id: string } | null }>;
    };
    const proposalId = report.findings.find((f) => f.check === "over-permissive-allowlist")?.fixProposal?.id;
    expect(proposalId).toBeTruthy();

    // Applying from `root`, naming `./project` explicitly, must reach the
    // project's settings file — before F27 this ignored the positional and
    // resolved against `resolveProjectRoot(root)` instead.
    const { exit, out: applyOut } = await run(root, ["apply", "--proposal", proposalId!, "./project"]);
    expect(exit).toBe(0);
    expect(applyOut).toMatch(new RegExp(proposalId!));
  });
});

// --- N6: `apply` must not create a nonexistent root -----------------------

describe("N6: apply --proposal <id> <path> refuses a nonexistent path instead of creating it", () => {
  test("a nonexistent path is refused with exit 1 and nothing is created", async () => {
    root = await makeRoot("keryx-n6-apply-missing-root-");
    const missing = path.join(root, "does", "not", "exist");

    const { exit, err } = await run(root, ["apply", "--proposal", "p-0000000000000000", missing]);
    expect(exit).toBe(1);
    expect(err).toMatch(/no such directory/i);

    const stillMissing = await import("node:fs/promises").then((fs) =>
      fs
        .stat(missing)
        .then(() => true)
        .catch(() => false),
    );
    expect(stillMissing).toBe(false);
  });

  test("a path that resolves to a FILE, not a directory, is refused with exit 1", async () => {
    root = await makeRoot("keryx-n6-apply-file-root-");
    const filePath = path.join(root, "not-a-dir.txt");
    await writeFile(filePath, "hi\n", "utf8");

    const { exit, err } = await run(root, ["apply", "--proposal", "p-0000000000000000", filePath]);
    expect(exit).toBe(1);
    expect(err).toMatch(/no such directory/i);
  });
});

// --- N7: baseline add --reseal --json -----------------------------------------

describe("N7: baseline add --reseal reports carried-over/discarded ids and a backup path", () => {
  test("--json lists carriedOver/discarded/backupPath on a reseal", async () => {
    root = await makeRoot("keryx-n7-baseline-reseal-json-");
    const baselinePath = path.join(root, ".metaproject", "security-audit-baseline.json");
    await writeFile(
      baselinePath,
      `${JSON.stringify({ schemaVersion: 1, entries: [{ findingId: "evil", justification: "planted" }], checksum: "wrong" }, null, 2)}\n`,
      "utf8",
    );

    const { exit, out } = await run(root, [
      "baseline",
      "add",
      "--finding",
      "legit",
      "--justification",
      "ok",
      "--reseal",
      "--json",
    ]);
    expect(exit).toBe(0);
    const result = JSON.parse(out) as {
      resealed: boolean;
      carriedOver: string[];
      discarded: string[];
      backupPath?: string;
    };
    expect(result.resealed).toBe(true);
    expect(result.carriedOver).toEqual(["evil"]);
    expect(result.discarded).toEqual([]);
    expect(result.backupPath).toBeTruthy();
  });
});

// --- F24: CLI-level --ci exit codes -------------------------------------------

describe("F24: CLI-level --ci exit codes", () => {
  test("--ci exits 1 on an unsuppressed high finding", async () => {
    root = await makeRoot("keryx-f24-ci-high-");
    await writeFile(
      path.join(root, ".mcp.json"),
      `${JSON.stringify({ mcpServers: { search: { command: "npx", args: ["-y", "@scope/pkg"] } } }, null, 2)}\n`,
      "utf8",
    );

    const { exit, out } = await run(root, [".", "--ci", "--json"]);
    const report = JSON.parse(out) as { summary: { countsBySeverity: { high: number } } };
    expect(report.summary.countsBySeverity.high).toBeGreaterThan(0);
    expect(exit).toBe(1);
  });

  test("--ci exits 0 when only medium/low findings exist", async () => {
    root = await makeRoot("keryx-f24-ci-medium-");
    await mkdir(path.join(root, ".claude"), { recursive: true });
    await writeFile(
      path.join(root, ".claude", "settings.json"),
      `${JSON.stringify({ permissions: { allow: ["Bash(git:*)"] } }, null, 2)}\n`,
      "utf8",
    );

    const { exit, out } = await run(root, [".", "--ci", "--json"]);
    const report = JSON.parse(out) as { summary: { countsBySeverity: { critical: number; high: number } } };
    expect(report.summary.countsBySeverity.critical).toBe(0);
    expect(report.summary.countsBySeverity.high).toBe(0);
    expect(exit).toBe(0);
  });

  test("--ci exits 1 on a tampered baseline even with zero findings", async () => {
    root = await makeRoot("keryx-f24-ci-tampered-baseline-");
    await writeFile(path.join(root, "CLAUDE.md"), "# ok\n", "utf8");
    const baselinePath = path.join(root, ".metaproject", "security-audit-baseline.json");
    // A checksum that does not match the (empty) entries array: mismatch.
    await writeFile(
      baselinePath,
      `${JSON.stringify({ schemaVersion: 1, entries: [], checksum: "not-the-real-checksum" }, null, 2)}\n`,
      "utf8",
    );

    const { exit, out } = await run(root, [".", "--ci", "--json"]);
    const report = JSON.parse(out) as { baseline: { tamperState: string } | null; findings: unknown[] };
    expect(report.baseline?.tamperState).toBe("mismatch");
    expect(exit).toBe(1);
  });
});
