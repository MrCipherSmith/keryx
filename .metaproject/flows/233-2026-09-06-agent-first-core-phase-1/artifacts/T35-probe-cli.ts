/**
 * T35 independent probe E: the ONE CLI surface that turns a stored security
 * artifact into a CI verdict -- `keryx security report`, whose exit code is
 * `1` for `ci` mode when the gate is `fail` or `incomplete`
 * (`src/commands/security.ts:559`). `runGate` is not exposed as a CLI command,
 * so this exit code is what a strict CI job actually observes.
 *
 * Read-only on production code. Fixtures under mkdtemp, removed in finally.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runGate } from "../../../../src/security/service";

const CLI = path.resolve(import.meta.dir, "../../../../src/cli.ts");
const rows: Array<Record<string, unknown>> = [];

const full = (gate: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    schemaVersion: 1,
    createdAt: "2026-09-06T00:00:00.000Z",
    mode: "ci",
    gate,
    rawRetention: "off",
    summary: { total: 0, bySeverity: {}, byAction: {}, byCategory: {} },
    findings: [],
    ...extra,
  });

const CASES: Array<{ name: string; latest?: string; strictCiShouldFail: boolean }> = [
  { name: "E1 stored pass", latest: full("pass"), strictCiShouldFail: false },
  { name: "E2 stored fail", latest: full("fail"), strictCiShouldFail: true },
  { name: "E3 stored incomplete", latest: full("incomplete"), strictCiShouldFail: true },
  { name: "E4 stored needs-approval", latest: full("needs-approval"), strictCiShouldFail: true },
  { name: "E5 no report at all", strictCiShouldFail: true },
  { name: "E6 unparseable report", latest: '{"gate":"pa', strictCiShouldFail: true },
  {
    name: "E7 stored pass over incomplete coverage",
    latest: full("pass", { coverage: { status: "incomplete", required: true, reasons: ["x"] } }),
    strictCiShouldFail: true,
  },
];

for (const testCase of CASES) {
  const root = await mkdtemp(path.join(tmpdir(), "t35-cli-"));
  try {
    await mkdir(path.join(root, ".metaproject"), { recursive: true });
    await writeFile(
      path.join(root, ".metaproject", "metaproject.json"),
      JSON.stringify({ modules: { security: { enabled: true } } }),
      "utf8",
    );
    await writeFile(
      path.join(root, ".metaproject", "security.config.json"),
      JSON.stringify({ schemaVersion: 1, mode: "ci" }),
      "utf8",
    );
    if (testCase.latest !== undefined) {
      const dir = path.join(root, ".metaproject", "data", "security", "artifacts");
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "latest.json"), testCase.latest, "utf8");
    }
    const proc = Bun.spawn(["bun", CLI, "security", "report", "--json"], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, NO_COLOR: "1" },
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    let printedGate = "<unparsed>";
    try {
      printedGate = String(JSON.parse(stdout.slice(stdout.indexOf("{"))).gate);
    } catch {
      printedGate = "<unparsed>";
    }
    const gate = await runGate({ cwd: root });
    rows.push({
      case: testCase.name,
      cliExitCode: exitCode,
      cliPrintedGate: printedGate,
      runGateStatus: gate.status,
      strictCiShouldFail: testCase.strictCiShouldFail,
      cliAgreesWithRunGate: printedGate === gate.status,
      verdict:
        (exitCode !== 0) === testCase.strictCiShouldFail
          ? "OK"
          : `MISMATCH: strict CI ${exitCode === 0 ? "PASSES" : "fails"} on a ${printedGate} artifact`,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const failures = rows.filter((r) => r.verdict !== "OK").length;
process.stdout.write(`${JSON.stringify({ probe: "T35-E security report CLI exit code", rows, failures }, null, 2)}\n`);
process.stdout.write(failures === 0 ? "\nT35-E: ALL CASES OK\n" : `\nT35-E: ${failures} CASE(S) MISMATCHED\n`);
process.exit(0);
