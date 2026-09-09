import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { securityCommand } from "./security";

const SECRET = "AKIAIOSFODNN7EXAMPLE";

type RecursiveReport = {
  gate: "pass" | "fail" | "incomplete";
  coverage: { status: "complete" | "incomplete"; required: boolean; reasons: string[] };
  files: Array<{ path: string; status: "scanned" | "skipped" | "failed"; reason?: string }>;
  findings: unknown[];
};

async function makeRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  return root;
}

async function scanJson(root: string, extraArgs: string[] = []): Promise<RecursiveReport> {
  const lines: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalExitCode = process.exitCode;
  try {
    console.log = (...parts: unknown[]) => lines.push(parts.map(String).join(" "));
    console.error = (...parts: unknown[]) => errors.push(parts.map(String).join(" "));
    process.exitCode = 0;
    await securityCommand(["scan", "corpus", "--json", ...extraArgs], root);
    expect(errors.join("\n")).not.toMatch(/EISDIR/i);
    return JSON.parse(lines.join("\n")) as RecursiveReport;
  } finally {
    console.log = originalLog;
    console.error = originalError;
    process.exitCode = originalExitCode ?? 0;
  }
}

test("directory scan recurses by default, follows internal links once, and terminates symlink cycles", async () => {
  const root = await makeRoot("keryx-security-recursive-");
  try {
    const nested = path.join(root, "corpus", "nested");
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(nested, "secret.txt"), `token=${SECRET}\n`, "utf8");
    await symlink("nested", path.join(root, "corpus", "alias"));
    await symlink("..", path.join(nested, "loop"));

    const report = await scanJson(root);
    const secretFiles = report.files.filter((file) => file.path.endsWith("secret.txt"));
    expect(report.coverage).toMatchObject({ status: "complete", required: true });
    expect(secretFiles).toHaveLength(1);
    expect(secretFiles[0]?.status).toBe("scanned");
    expect(report.findings.length).toBeGreaterThan(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 3_000);

test("external and unreadable entries make required coverage incomplete without exposing or losing in-scope findings", async () => {
  const root = await makeRoot("keryx-security-incomplete-");
  const outside = await mkdtemp(path.join(tmpdir(), "keryx-security-outside-"));
  const unreadable = path.join(root, "corpus", "unreadable.txt");
  try {
    await mkdir(path.join(root, "corpus"), { recursive: true });
    await writeFile(path.join(root, "corpus", "visible-secret.txt"), `token=${SECRET}\n`, "utf8");
    await writeFile(path.join(outside, "private-name.txt"), `outside=${SECRET}\n`, "utf8");
    await symlink(path.join(outside, "private-name.txt"), path.join(root, "corpus", "external-link"));
    await writeFile(unreadable, "unreadable fixture\n", "utf8");
    await chmod(unreadable, 0o000);

    const report = await scanJson(root);
    const serialized = JSON.stringify(report);
    expect(report.coverage.status).toBe("incomplete");
    expect(report.coverage.reasons.join("\n")).toMatch(/external|denied|unreadable|permission/i);
    expect(report.gate).toBe("fail");
    expect(report.findings.length).toBeGreaterThan(0);
    expect(serialized).not.toContain("private-name.txt");
    expect(serialized).not.toContain(`outside=${SECRET}`);
  } finally {
    await chmod(unreadable, 0o600).catch(() => undefined);
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]);
  }
});

test("T34 F-004: per-file rows key on the encountered entry, not the canonical target", async () => {
  const root = await makeRoot("keryx-security-encountered-");
  try {
    const deep = path.join(root, "corpus", "a", "b", "c");
    await mkdir(deep, { recursive: true });
    await writeFile(path.join(deep, "creds.env"), `token=${SECRET}\n`, "utf8");
    // A symlink to an in-scope regular file: a second encounter of the same
    // canonical identity, under a different name.
    await symlink(path.join(deep, "creds.env"), path.join(root, "corpus", "dup-creds.env"));
    // A mutual directory symlink cycle: whichever side is visited second must
    // be reported under the entry that produced that second encounter, not
    // under the canonical directory it resolves to.
    await mkdir(path.join(root, "corpus", "x"), { recursive: true });
    await mkdir(path.join(root, "corpus", "y"), { recursive: true });
    await symlink(path.join(root, "corpus", "y"), path.join(root, "corpus", "x", "toY"));
    await symlink(path.join(root, "corpus", "x"), path.join(root, "corpus", "y", "toX"));

    const report = await scanJson(root);

    const credsRows = report.files.filter((file) => file.path === "corpus/a/b/c/creds.env");
    expect(credsRows).toHaveLength(1);
    expect(credsRows[0]?.status).toBe("scanned");

    const dupRows = report.files.filter((file) => file.path === "corpus/dup-creds.env");
    expect(dupRows).toHaveLength(1);
    expect(dupRows[0]?.status).toBe("skipped");
    expect(dupRows[0]?.reason).toBe("canonical identity already visited");

    // No two rows may report the same path with contradictory statuses.
    const byPath = new Map<string, Set<string>>();
    for (const file of report.files) {
      const statuses = byPath.get(file.path) ?? new Set<string>();
      statuses.add(file.status);
      byPath.set(file.path, statuses);
    }
    for (const [rowPath, statuses] of byPath) {
      expect(statuses.size, `path ${rowPath} has contradictory statuses: ${[...statuses].join(", ")}`).toBe(1);
    }

    // "x" sorts first among the top-level entries and is the one whose
    // contents are genuinely recursed into (its child "toY" resolves the "y"
    // identity for the first time). It must never itself carry a
    // "canonical identity already visited" row — only the entry that
    // produced an actual second encounter (here, the cycle's other symlink
    // and the direct top-level "y") may.
    const skippedDirectoryNames = report.files
      .filter((file) => file.status === "skipped" && file.reason === "canonical identity already visited")
      .map((file) => file.path);
    expect(skippedDirectoryNames).not.toContain("corpus/x");
    // Every skip row names a path that was actually visited to produce it —
    // not a stand-in canonical name distinct from any real entry.
    for (const skippedPath of skippedDirectoryNames) {
      expect(skippedPath.startsWith("corpus/")).toBe(true);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("T34 F-003: a non-recursive directory scan never reports a clean pass over unscanned content", async () => {
  const root = await makeRoot("keryx-security-nonrecursive-");
  try {
    await mkdir(path.join(root, "corpus"), { recursive: true });
    await writeFile(path.join(root, "corpus", "creds.env"), `token=${SECRET}\n`, "utf8");

    const report = await scanJson(root, ["--no-recursive"]);

    expect(report.coverage.status).toBe("incomplete");
    expect(report.coverage.reasons.join("\n")).toMatch(/recursive/i);
    expect(report.gate).not.toBe("pass");
    expect(report.files.filter((file) => file.status === "scanned")).toHaveLength(0);
    expect(report.files).toContainEqual(
      expect.objectContaining({ path: "corpus", status: "skipped", reason: "recursive traversal disabled" }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("T34 F-005: --recursive and --no-recursive change scope.recursive and actual scan behaviour", async () => {
  const root = await makeRoot("keryx-security-flag-");
  try {
    const nested = path.join(root, "corpus", "nested");
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(root, "corpus", "top.env"), `token=${SECRET}\n`, "utf8");
    await writeFile(path.join(nested, "deep.env"), `token=${SECRET}\n`, "utf8");

    const withFlag = await scanJson(root, ["--recursive"]);
    const withoutFlag = await scanJson(root);
    const explicitOff = await scanJson(root, ["--no-recursive"]);

    // The explicit flag and the omitted flag agree — neither is silently
    // forced on or off by parsing alone.
    expect(withFlag.coverage.status).toBe(withoutFlag.coverage.status);
    expect(withFlag.files.filter((f) => f.status === "scanned")).toHaveLength(
      withoutFlag.files.filter((f) => f.status === "scanned").length,
    );

    // `--no-recursive` changes what the API and the CLI actually do.
    expect(explicitOff.coverage.status).toBe("incomplete");
    expect(explicitOff.files.filter((f) => f.status === "scanned")).toHaveLength(0);
    expect(withoutFlag.files.filter((f) => f.status === "scanned").length).toBeGreaterThan(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("required file-count exhaustion is incomplete while findings scanned before the limit remain", async () => {
  const root = await makeRoot("keryx-security-limit-");
  try {
    await mkdir(path.join(root, "corpus"), { recursive: true });
    await writeFile(path.join(root, "corpus", "00-secret.txt"), `token=${SECRET}\n`, "utf8");
    await writeFile(path.join(root, "corpus", "01-safe.txt"), "safe\n", "utf8");

    const report = await scanJson(root, ["--max-files", "1", "--max-bytes", "4096"]);
    expect(report.coverage.status).toBe("incomplete");
    expect(report.coverage.reasons.join("\n")).toMatch(/limit|max-files/i);
    expect(report.gate).toBe("fail");
    expect(report.findings.length).toBeGreaterThan(0);
    expect(report.files.filter((file) => file.status === "scanned")).toHaveLength(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
