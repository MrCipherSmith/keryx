/**
 * T28 independent Stage-1 probe: recursive contained security scan (AFC-17 / AC6).
 * Read-only against production code; every fixture lives under a mkdtemp root
 * that is removed at the end. Synthetic secrets only.
 */
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { securityCommand } from "../../../../src/commands/security";

type ScanFile = { path: string; status: string; reason?: string };
type ScanReport = {
  gate: string;
  scope?: { path: string; recursive: boolean; exclusions: string[]; limits: Record<string, number> };
  coverage?: { status: string; required: boolean; reasons: string[] };
  files?: ScanFile[];
  findings: Array<Record<string, unknown>>;
  summary: { total: number };
};

// Synthetic, non-live credential shapes.
const SYNTH_AWS = "AKIAIOSFODNN7EXAMPLE";
const SYNTH_LINE = `aws_access_key_id=${SYNTH_AWS}\naws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n`;

async function makeRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  return root;
}

async function scan(root: string, args: string[]): Promise<{ report: ScanReport | null; stdout: string; stderr: string; exitCode: number }> {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  const prevExit = process.exitCode;
  try {
    console.log = (...p: unknown[]) => out.push(p.map(String).join(" "));
    console.error = (...p: unknown[]) => err.push(p.map(String).join(" "));
    process.exitCode = 0;
    await securityCommand(args, root);
    const code = Number(process.exitCode ?? 0);
    const stdout = out.join("\n");
    let report: ScanReport | null = null;
    try { report = JSON.parse(stdout) as ScanReport; } catch { report = null; }
    return { report, stdout, stderr: err.join("\n"), exitCode: code };
  } finally {
    console.log = log;
    console.error = error;
    process.exitCode = prevExit ?? 0;
  }
}

function emit(name: string, value: unknown): void {
  process.stdout.write(`\n=== ${name} ===\n${JSON.stringify(value, null, 2)}\n`);
}

/** P1: deep nesting, symlink-to-file duplicate, mutual directory symlink cycle. */
async function probeRecursion(): Promise<void> {
  const root = await makeRoot("t28-recursion-");
  try {
    const deep = path.join(root, "corpus", "a", "b", "c");
    await mkdir(deep, { recursive: true });
    await writeFile(path.join(deep, "creds.env"), SYNTH_LINE, "utf8");
    await writeFile(path.join(root, "corpus", "plain.txt"), "nothing interesting here\n", "utf8");
    // canonical duplicate: symlink to an in-scope regular file
    await symlink(path.join(deep, "creds.env"), path.join(root, "corpus", "dup-creds.env"));
    // mutual directory symlink cycle: x/toY -> y, y/toX -> x
    await mkdir(path.join(root, "corpus", "x"), { recursive: true });
    await mkdir(path.join(root, "corpus", "y"), { recursive: true });
    await symlink(path.join(root, "corpus", "y"), path.join(root, "corpus", "x", "toY"));
    await symlink(path.join(root, "corpus", "x"), path.join(root, "corpus", "y", "toX"));
    // self-referential symlink directly under the target
    await symlink(path.join(root, "corpus"), path.join(root, "corpus", "self"));

    const started = Date.now();
    const res = await scan(root, ["scan", "corpus", "--json"]);
    const elapsedMs = Date.now() - started;
    emit("P1 recursion/cycle", {
      elapsedMs,
      exitCode: res.exitCode,
      stderrHasEISDIR: /EISDIR/i.test(res.stderr) || /EISDIR/i.test(res.stdout),
      gate: res.report?.gate,
      coverage: res.report?.coverage,
      scope: res.report?.scope,
      files: res.report?.files,
      findingCount: res.report?.findings.length,
      findingPolicies: res.report?.findings.map((f) => `${String(f.category)}/${String(f.policyId)}`),
      credsEnvEntries: res.report?.files?.filter((f) => f.path.endsWith("creds.env")),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** P2: external symlink (file + directory) and an unreadable file. */
async function probeExternalAndUnreadable(): Promise<void> {
  const root = await makeRoot("t28-external-");
  const outside = await mkdtemp(path.join(tmpdir(), "t28-outside-"));
  const unreadable = path.join(root, "corpus", "locked.txt");
  try {
    await mkdir(path.join(root, "corpus"), { recursive: true });
    await mkdir(path.join(outside, "secretdir"), { recursive: true });
    await writeFile(path.join(outside, "T28-OUTSIDE-FILENAME.txt"), `outside_key=${SYNTH_AWS}\nOUTSIDE_CANARY_CONTENT\n`, "utf8");
    await writeFile(path.join(outside, "secretdir", "T28-OUTSIDE-NESTED.txt"), "OUTSIDE_CANARY_NESTED\n", "utf8");
    await symlink(path.join(outside, "T28-OUTSIDE-FILENAME.txt"), path.join(root, "corpus", "ext-file-link"));
    await symlink(path.join(outside, "secretdir"), path.join(root, "corpus", "ext-dir-link"));
    await writeFile(path.join(root, "corpus", "inscope.env"), SYNTH_LINE, "utf8");
    await writeFile(unreadable, "unreadable fixture\n", "utf8");
    await chmod(unreadable, 0o000);

    const res = await scan(root, ["scan", "corpus", "--json"]);
    const serialized = JSON.stringify(res.report);
    emit("P2 external+unreadable", {
      exitCode: res.exitCode,
      gate: res.report?.gate,
      coverage: res.report?.coverage,
      files: res.report?.files,
      findingCount: res.report?.findings.length,
      leaksOutsideFileName: serialized.includes("T28-OUTSIDE-FILENAME"),
      leaksOutsideNestedName: serialized.includes("T28-OUTSIDE-NESTED"),
      leaksOutsideDirName: serialized.includes("secretdir"),
      leaksTmpAbsolutePath: serialized.includes(outside),
      leaksOutsideContent: serialized.includes("OUTSIDE_CANARY"),
      alsoCheckMarkdown: null,
    });
    // The committable markdown artifact is the other caller-visible surface.
    const md = await Bun.file(path.join(root, ".metaproject", "data", "security", "artifacts", "latest.md")).text();
    emit("P2 markdown leak check", {
      leaksOutsideFileName: md.includes("T28-OUTSIDE-FILENAME"),
      leaksOutsideDirName: md.includes("secretdir"),
      leaksOutsideAbsPath: md.includes(outside),
      coverageSection: md.split("## Files")[0]?.slice(-400),
    });
  } finally {
    await chmod(unreadable, 0o600).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
}

/** P3: exhausted --max-files and --max-bytes; findings before the limit retained. */
async function probeLimits(): Promise<void> {
  for (const variant of ["max-files", "max-bytes"] as const) {
    const root = await makeRoot(`t28-limit-${variant}-`);
    try {
      await mkdir(path.join(root, "corpus"), { recursive: true });
      await writeFile(path.join(root, "corpus", "00-creds.env"), SYNTH_LINE, "utf8");
      await writeFile(path.join(root, "corpus", "01-more.env"), SYNTH_LINE, "utf8");
      await writeFile(path.join(root, "corpus", "02-more.env"), SYNTH_LINE, "utf8");
      const args = variant === "max-files"
        ? ["scan", "corpus", "--json", "--max-files", "1"]
        : ["scan", "corpus", "--json", "--max-bytes", "80"];
      const res = await scan(root, args);
      emit(`P3 limits (${variant})`, {
        exitCode: res.exitCode,
        gate: res.report?.gate,
        coverage: res.report?.coverage,
        scopeLimits: res.report?.scope?.limits,
        files: res.report?.files,
        findingCount: res.report?.findings.length,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}

/** P4: clean tree + incomplete coverage only (no finding) -> must not be pass. */
async function probeCleanIncomplete(): Promise<void> {
  const root = await makeRoot("t28-clean-incomplete-");
  const unreadable = path.join(root, "corpus", "locked.txt");
  try {
    await mkdir(path.join(root, "corpus"), { recursive: true });
    await writeFile(path.join(root, "corpus", "ok.txt"), "plain text, nothing to find\n", "utf8");
    await writeFile(unreadable, "unreadable fixture\n", "utf8");
    await chmod(unreadable, 0o000);
    const res = await scan(root, ["scan", "corpus", "--json"]);
    emit("P4 clean+incomplete", {
      exitCode: res.exitCode,
      gate: res.report?.gate,
      coverage: res.report?.coverage,
      files: res.report?.files,
      findingCount: res.report?.findings.length,
    });
  } finally {
    await chmod(unreadable, 0o600).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}

/** P5: --recursive / non-recursive behaviour and exclusions echo. */
async function probeFlags(): Promise<void> {
  const root = await makeRoot("t28-flags-");
  try {
    const nested = path.join(root, "corpus", "deep");
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(root, "corpus", "top.env"), SYNTH_LINE, "utf8");
    await writeFile(path.join(nested, "deep.env"), SYNTH_LINE, "utf8");
    const withFlag = await scan(root, ["scan", "corpus", "--json", "--recursive"]);
    const withoutFlag = await scan(root, ["scan", "corpus", "--json"]);
    const excluded = await scan(root, ["scan", "corpus", "--json", "--exclude", "corpus/deep", "--exclude", "../../etc"]);
    emit("P5 flags", {
      withFlagFiles: withFlag.report?.files,
      withFlagRecursive: withFlag.report?.scope?.recursive,
      withoutFlagFiles: withoutFlag.report?.files,
      withoutFlagRecursive: withoutFlag.report?.scope?.recursive,
      excludedScope: excluded.report?.scope,
      excludedFiles: excluded.report?.files,
      excludedCoverage: excluded.report?.coverage,
      excludedGate: excluded.report?.gate,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** P6: single-file target (regression guard for the EISDIR class). */
async function probeSingleFile(): Promise<void> {
  const root = await makeRoot("t28-single-");
  try {
    await mkdir(path.join(root, "corpus"), { recursive: true });
    await writeFile(path.join(root, "corpus", "one.env"), SYNTH_LINE, "utf8");
    const res = await scan(root, ["scan", "corpus/one.env", "--json"]);
    emit("P6 single file", {
      exitCode: res.exitCode,
      gate: res.report?.gate,
      coverage: res.report?.coverage,
      files: res.report?.files,
      findingCount: res.report?.findings.length,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await probeRecursion();
await probeExternalAndUnreadable();
await probeLimits();
await probeCleanIncomplete();
await probeFlags();
await probeSingleFile();
process.stdout.write("\nT28 scan probe complete\n");
