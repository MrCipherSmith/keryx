import { test, expect } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathExists } from "../lib/fs";
import { runTesting } from "./service";
import { redactRaw } from "../security/guard";

const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";
const RAW_LOG = path.join(".metaproject", "data", "testing", "logs", "latest.raw.log");

// A workspace whose `test` script echoes a secret, so the raw log carries a
// secret through the testing write seam. bun.lockb makes the runner resolve to
// `bun run test`, which is available in this environment.
async function scaffold(opts: { security?: boolean; mode?: string }): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "gd-testing-seam-"));
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ scripts: { test: `echo ${AWS_KEY}` } }),
    "utf8",
  );
  await writeFile(path.join(root, "bun.lockb"), "", "utf8");
  if (opts.security !== undefined) {
    await writeFile(
      path.join(root, ".metaproject", "metaproject.json"),
      JSON.stringify({ modules: { security: { enabled: opts.security } } }),
      "utf8",
    );
  }
  if (opts.mode) {
    await writeFile(
      path.join(root, ".metaproject", "security.config.json"),
      JSON.stringify({ mode: opts.mode }),
      "utf8",
    );
  }
  return root;
}

test("advisory testing run persists the raw log just like security-off", async () => {
  const off = await scaffold({ security: false });
  const advisory = await scaffold({ security: true, mode: "advisory" });
  try {
    const offResult = await runTesting({ cwd: off, changed: false, since: null, scope: null, kind: null, strict: false });
    const advResult = await runTesting({ cwd: advisory, changed: false, since: null, scope: null, kind: null, strict: false });

    // Both persist the raw log (behavior unchanged in advisory).
    expect(offResult.report.rawLogPath).not.toBeNull();
    expect(advResult.report.rawLogPath).not.toBeNull();
    expect(await pathExists(path.join(advisory, RAW_LOG))).toBe(true);
    // Advisory may add a leak-safe warning but never suppresses.
    expect(advResult.securityWarnings?.every((w) => !w.includes("not persisted"))).toBe(true);
    expect(JSON.stringify(advResult.securityWarnings ?? [])).not.toContain(AWS_KEY);
  } finally {
    await rm(off, { recursive: true, force: true });
    await rm(advisory, { recursive: true, force: true });
  }
});

test("enforced testing run suppresses raw-log persistence for a planted secret", async () => {
  const root = await scaffold({ security: true, mode: "enforced" });
  try {
    const result = await runTesting({ cwd: root, changed: false, since: null, scope: null, kind: null, strict: false });
    // The run itself is never broken; only raw-log persistence is suppressed.
    expect(result.report.rawLogPath).toBeNull();
    expect(await pathExists(path.join(root, RAW_LOG))).toBe(false);
    expect(result.securityWarnings?.some((w) => w.includes("not persisted"))).toBe(true);
    expect(JSON.stringify(result.securityWarnings ?? [])).not.toContain(AWS_KEY);
    // The normalized report is still written.
    expect(result.jsonPath.length).toBeGreaterThan(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Regression (leak review): the testing report is built from a redacted copy of
// the command output (`safeRaw = redactRaw(raw)`), so a secret in a failing test
// command's output can never reach the committable report via a failure message.
// This asserts the invariant deterministically (no subprocess): the exact content
// a failing runner would emit is redacted before it can feed firstMeaningfulLine.
test("redactRaw masks a secret in failing-test-style output (report source is leak-safe)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "gd-testing-leak-"));
  try {
    await mkdir(path.join(root, ".metaproject"), { recursive: true });
    await writeFile(
      path.join(root, ".metaproject", "metaproject.json"),
      JSON.stringify({ modules: { security: { enabled: true } } }),
      "utf8",
    );
    await writeFile(
      path.join(root, ".metaproject", "security.config.json"),
      JSON.stringify({ mode: "enforced" }),
      "utf8",
    );

    const rawFailureOutput = `$ echo ${AWS_KEY}-leak; exit 1\n${AWS_KEY}-leak\nerror: script "test" exited with code 1`;
    const { content: safeRaw, findings } = await redactRaw({ cwd: root, content: rawFailureOutput });

    // The redacted copy that feeds the report carries no raw secret.
    expect(findings.length).toBeGreaterThan(0);
    expect(safeRaw).not.toContain(AWS_KEY);
    expect(safeRaw).toContain("[REDACTED:secret]");
    // The first meaningful line (used for the report failure message) is masked.
    const firstLine = safeRaw.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
    expect(firstLine).not.toContain(AWS_KEY);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
