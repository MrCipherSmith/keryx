// T55 — supplementary probe. T39-exit.ts's own S3 row calls
// `reportExitCode(report.gate, report.mode)` directly — it never invokes the
// real CLI entry point (`handleReport`/`securityCommand`). That call, by
// construction, always demonstrates "if you pass the artifact's own mode you
// get the wrong answer" — which remains true of the pure function after this
// fix, because the fix relocated WHICH value `handleReport` passes in
// (`await modeOf(cwd)` instead of `report.mode`), not `reportExitCode`
// itself. This script drives the actual `securityCommand(["report", ...])`
// entry point end to end, the way a real invocation of `keryx security
// report` would, to show the real fix rather than the pure-function
// reproduction.
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { securityCommand } from "../../../../src/commands/security";

const out = (row: Record<string, unknown>) => console.log(JSON.stringify(row));

const root = await mkdtemp(path.join(tmpdir(), "t55-report-real-cli-"));
try {
  const artifacts = path.join(root, ".metaproject", "data", "security", "artifacts");
  await mkdir(artifacts, { recursive: true });
  // Workspace configured strict...
  await writeFile(
    path.join(root, ".metaproject", "security.config.json"),
    JSON.stringify({ mode: "ci" }),
    "utf8",
  );
  // ...but the stored artifact remembers a more permissive mode.
  await writeFile(
    path.join(artifacts, "latest.json"),
    JSON.stringify({
      schemaVersion: 1,
      createdAt: "2026-01-01T00:00:00Z",
      mode: "advisory",
      gate: "fail",
      rawRetention: "off",
      summary: { total: 1, bySeverity: {}, byAction: {}, byCategory: { secret: 1 } },
      findings: [],
    }),
    "utf8",
  );

  const originalExitCode = process.exitCode;
  process.exitCode = 0;
  await securityCommand(["report", "--json"], root);
  const exitCode = process.exitCode ?? 0;
  process.exitCode = originalExitCode ?? 0;

  out({
    label: "T55 real CLI: keryx security report, workspace ci + stored mode advisory + gate fail",
    exitCode,
    expected: 1,
    matches: exitCode === 1,
  });
} finally {
  await rm(root, { recursive: true, force: true });
}
