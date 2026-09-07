/**
 * T35 independent probe B: attack the per-file coverage rows (defect 6) and the
 * non-recursive scan outcome (defect 7), plus the end-to-end claim that the
 * `pass -> incomplete` fold inside `runScanPath` survived the gate rewrite.
 *
 * Fixtures are built to break the specific repair: rows now key on the
 * ENCOUNTERED entry (`displayPath`) while `visited` still keys on dev:ino, so
 * every fixture here is one where those two disagree.
 *
 * Read-only on production code. All fixtures under mkdtemp, removed in finally.
 */
import { chmod, link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { scanContainedPath } from "../../../../src/security/path-scan";
import { runScanPath, runGate } from "../../../../src/security/service";

const SECRET = "aws_access_key_id=AKIAIOSFODNN7EXAMPLE\n"; // synthetic
let failures = 0;
const out: Record<string, unknown> = {};

function check(label: string, ok: boolean, detail: unknown): void {
  if (!ok) failures += 1;
  out[label] = { ok, detail };
}

async function ws(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "t35-scan-"));
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  await writeFile(
    path.join(root, ".metaproject", "metaproject.json"),
    JSON.stringify({ modules: { security: { enabled: true } } }),
    "utf8",
  );
  return root;
}

/** Every path must appear at most once across the rows. */
function duplicates(files: Array<{ path: string; status: string }>): string[] {
  const seen = new Map<string, string[]>();
  for (const f of files) seen.set(f.path, [...(seen.get(f.path) ?? []), f.status]);
  return [...seen.entries()].filter(([, s]) => s.length > 1).map(([p, s]) => `${p}:${s.join("+")}`);
}

// --- B1: symlink encountered BEFORE its target (reverse of the T34 fixture) ---
{
  const root = await ws();
  try {
    await mkdir(path.join(root, "corpus", "z-real"), { recursive: true });
    const real = path.join(root, "corpus", "z-real", "creds.env");
    await writeFile(real, SECRET, "utf8");
    // "a-link" sorts before "z-real", so the SYMLINK is the first encounter.
    await symlink(real, path.join(root, "corpus", "a-link.env"));
    const t = await scanContainedPath({ ownerRoot: root, targetPath: path.join(root, "corpus") });
    const paths = t.files.map((f) => `${f.path}=${f.status}`);
    check("B1 symlink-first: no duplicate path rows", duplicates(t.files).length === 0, duplicates(t.files));
    check("B1 symlink-first: the symlink has its own row", t.files.some((f) => f.path === "corpus/a-link.env"), paths);
    check("B1 symlink-first: the real file has its own row", t.files.some((f) => f.path === "corpus/z-real/creds.env"), paths);
    check("B1 symlink-first: exactly one row is `scanned`", t.files.filter((f) => f.status === "scanned").length === 1, paths);
    check("B1 symlink-first: contents row matches a `scanned` files row",
      t.contents.every((c) => t.files.some((f) => f.path === c.path && f.status === "scanned")),
      { contents: t.contents.map((c) => c.path), paths });
    out["B1 files"] = t.files;
    out["B1 coverage"] = t.coverage;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// --- B2: hard link (two real names, one inode) -------------------------------
{
  const root = await ws();
  try {
    await mkdir(path.join(root, "corpus"), { recursive: true });
    const a = path.join(root, "corpus", "a.env");
    await writeFile(a, SECRET, "utf8");
    await link(a, path.join(root, "corpus", "b.env"));
    const t = await scanContainedPath({ ownerRoot: root, targetPath: path.join(root, "corpus") });
    check("B2 hardlink: no duplicate path rows", duplicates(t.files).length === 0, duplicates(t.files));
    check("B2 hardlink: both names have a row", t.files.length === 2, t.files);
    check("B2 hardlink: scanned exactly once", t.files.filter((f) => f.status === "scanned").length === 1, t.files);
    out["B2 files"] = t.files;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// --- B3: mutual directory symlink cycle -------------------------------------
{
  const root = await ws();
  try {
    await mkdir(path.join(root, "corpus", "x"), { recursive: true });
    await mkdir(path.join(root, "corpus", "y"), { recursive: true });
    await writeFile(path.join(root, "corpus", "x", "k.env"), SECRET, "utf8");
    await symlink(path.join(root, "corpus", "y"), path.join(root, "corpus", "x", "to-y"));
    await symlink(path.join(root, "corpus", "x"), path.join(root, "corpus", "y", "to-x"));
    // A self-loop too: a link to the scan target itself.
    await symlink(path.join(root, "corpus"), path.join(root, "corpus", "self"));
    const started = Date.now();
    const t = await scanContainedPath({ ownerRoot: root, targetPath: path.join(root, "corpus") });
    const ms = Date.now() - started;
    check("B3 cycle: terminates quickly", ms < 5_000, `${ms}ms`);
    check("B3 cycle: no duplicate path rows", duplicates(t.files).length === 0, duplicates(t.files));
    check("B3 cycle: the secret file is scanned exactly once",
      t.files.filter((f) => f.status === "scanned" && f.path.endsWith("k.env")).length === 1, t.files);
    check("B3 cycle: the self-link is reported, not silently dropped",
      t.files.some((f) => f.path === "corpus/self"), t.files);
    out["B3 files"] = t.files;
    out["B3 coverage"] = t.coverage;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// --- B4: symlinked directory whose children resolve through the canonical name
{
  const root = await ws();
  try {
    await mkdir(path.join(root, "corpus", "zdir"), { recursive: true });
    await writeFile(path.join(root, "corpus", "zdir", "f.env"), SECRET, "utf8");
    await symlink(path.join(root, "corpus", "zdir"), path.join(root, "corpus", "alink"));
    const t = await scanContainedPath({ ownerRoot: root, targetPath: path.join(root, "corpus") });
    check("B4 symlinked dir: no duplicate path rows", duplicates(t.files).length === 0, duplicates(t.files));
    out["B4 files"] = t.files;
    out["B4 note"] = "children of a symlinked directory are reported under the CANONICAL parent";
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// --- B5: symlink pointing OUTSIDE the owner root -----------------------------
{
  const root = await ws();
  const outside = await mkdtemp(path.join(tmpdir(), "t35-outside-"));
  try {
    await writeFile(path.join(outside, "victim-secret.env"), SECRET, "utf8");
    await mkdir(path.join(root, "corpus"), { recursive: true });
    await symlink(path.join(outside, "victim-secret.env"), path.join(root, "corpus", "escape.env"));
    const t = await scanContainedPath({ ownerRoot: root, targetPath: path.join(root, "corpus") });
    const json = JSON.stringify(t);
    check("B5 escape: refused and coverage marked incomplete", t.coverage.status === "incomplete", t.coverage);
    check("B5 escape: the outside path is NOT exposed", !json.includes(outside), t.files);
    check("B5 escape: no content was read", t.contents.length === 0, t.contents.map((c) => c.path));
    out["B5 files"] = t.files;
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
}

// --- B6: non-recursive scans, end to end through runScanPath + runGate -------
for (const shape of ["dir-with-secret", "dir-empty", "single-file"] as const) {
  const root = await ws();
  try {
    await mkdir(path.join(root, "corpus", "deep"), { recursive: true });
    if (shape !== "dir-empty") {
      await writeFile(path.join(root, "corpus", "creds.env"), SECRET, "utf8");
    }
    await writeFile(path.join(root, "corpus", "deep", "deep.env"), SECRET, "utf8");
    const target = shape === "single-file"
      ? path.join(root, "corpus", "creds.env")
      : path.join(root, "corpus");
    if (shape === "dir-empty") {
      await rm(path.join(root, "corpus", "deep"), { recursive: true, force: true });
    }
    const scan = await runScanPath(root, {
      ownerRoot: root,
      targetPath: target,
      source: "trusted-project",
      path: "corpus",
      recursive: false,
    });
    const gate = await runGate({ cwd: root });
    const cleanPass = scan.decision.gate === "pass" && scan.report.coverage?.status !== "complete";
    // A directory scanned without recursion must never be a clean pass.
    const ok = shape === "single-file"
      ? scan.decision.gate !== "pass" // it holds a secret
      : scan.decision.gate !== "pass" && gate.status !== "pass";
    check(`B6 non-recursive ${shape}: never a clean pass`, ok, {
      scanGate: scan.decision.gate,
      coverage: scan.report.coverage,
      files: scan.report.files,
      runGateAfter: gate.status,
      cleanPass,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// --- B7: the runScanPath fold under a genuinely clean, complete scan ---------
{
  const root = await ws();
  try {
    await mkdir(path.join(root, "corpus"), { recursive: true });
    await writeFile(path.join(root, "corpus", "plain.txt"), "nothing to see\n", "utf8");
    const scan = await runScanPath(root, {
      ownerRoot: root, targetPath: path.join(root, "corpus"), source: "trusted-project", path: "corpus",
    });
    const gate = await runGate({ cwd: root });
    check("B7 clean recursive scan still passes end to end",
      scan.decision.gate === "pass" && scan.report.coverage?.status === "complete" && gate.status === "pass",
      { gate: scan.decision.gate, coverage: scan.report.coverage, runGate: gate.status });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// --- B8: a violation and incomplete coverage visible simultaneously (AC6) ----
{
  const root = await ws();
  try {
    await mkdir(path.join(root, "corpus"), { recursive: true });
    await writeFile(path.join(root, "corpus", "a-creds.env"), SECRET, "utf8");
    const locked = path.join(root, "corpus", "z-locked.env");
    await writeFile(locked, "x\n", "utf8");
    await chmod(locked, 0o000);
    const scan = await runScanPath(root, {
      ownerRoot: root, targetPath: path.join(root, "corpus"), source: "trusted-project", path: "corpus",
    });
    await chmod(locked, 0o600).catch(() => undefined);
    check("B8 violation + incomplete coverage are both visible",
      scan.decision.findings.length > 0 && scan.report.coverage?.status === "incomplete" && scan.decision.gate !== "pass",
      { gate: scan.decision.gate, findings: scan.decision.findings.length, coverage: scan.report.coverage,
        files: scan.report.files });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

process.stdout.write(`${JSON.stringify({ probe: "T35-B scan coverage", out, failures }, null, 2)}\n`);
process.stdout.write(failures === 0 ? "\nT35-B: ALL CHECKS OK\n" : `\nT35-B: ${failures} CHECK(S) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
