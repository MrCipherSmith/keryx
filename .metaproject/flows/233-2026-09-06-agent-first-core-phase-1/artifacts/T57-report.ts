// T57 probe B (row 2) — the `security report` exit-code residue, measured at the
// REAL command entry point (`securityCommand(["report", ...])`), never at
// `reportExitCode` alone. T39-exit.ts's S3 row calls the pure function and can
// therefore never observe the fix; this probe is the control for that blind
// spot, and prints the pure-function answer beside the real one so the two are
// visibly different questions.
//
// Read-only against production code; every fixture is `mkdtemp` and removed.
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { securityCommand, reportExitCode } from "../../../../src/commands/security";
import { runReport } from "../../../../src/security/service";

const out = (row: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(row)}\n`);

async function cliExit(root: string, args: string[]): Promise<number> {
  const log = console.log;
  const err = console.error;
  const write = process.stdout.write.bind(process.stdout);
  const prev = process.exitCode;
  console.log = () => {};
  console.error = () => {};
  (process.stdout as unknown as { write: (c: unknown) => boolean }).write = () => true;
  process.exitCode = 0;
  try {
    await securityCommand(args, root);
    return (process.exitCode as number | undefined) ?? 0;
  } finally {
    process.exitCode = prev;
    console.log = log;
    console.error = err;
    (process.stdout as unknown as { write: typeof write }).write = write;
  }
}

function artifact(mode: unknown, gate: unknown, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    schemaVersion: 1,
    createdAt: "2026-01-01T00:00:00Z",
    generatedAt: "2026-01-01T00:00:00Z",
    mode,
    gate,
    rawRetention: "off",
    summary: { total: 1, bySeverity: {}, byAction: {}, byCategory: { secret: 1 } },
    findings: [],
    ...extra,
  });
}

async function ws(config: string | null, latest: string | null): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "t57-report-"));
  const artifacts = path.join(root, ".metaproject", "data", "security", "artifacts");
  await mkdir(artifacts, { recursive: true });
  if (config !== null) {
    await writeFile(path.join(root, ".metaproject", "security.config.json"), config, "utf8");
  }
  if (latest !== null) {
    await writeFile(path.join(artifacts, "latest.json"), latest, "utf8");
  }
  return root;
}

// ---- R1: the full workspace-mode x stored-gate matrix at the real entry point.
const WORKSPACE: [string, string | null][] = [
  ["ci", '{"mode":"ci"}'],
  ["enforced", '{"mode":"enforced"}'],
  ["advisory", '{"mode":"advisory"}'],
  ["gateway", '{"mode":"gateway"}'],
  ["ABSENT-config(defaults advisory)", null],
  ["UNREADABLE-config(forced enforced)", "null"],
  ["UNRECOGNIZED-mode(forced enforced)", '{"mode":"ENFORCED"}'],
];
const STORED_GATES = ["pass", "fail", "needs-approval", "incomplete", "banana"];

for (const [wLabel, config] of WORKSPACE) {
  const row: Record<string, unknown> = { label: `R1 real CLI \`security report\`, workspace ${wLabel}` };
  for (const gate of STORED_GATES) {
    // The stored artifact always claims the MOST permissive mode it can, so if
    // the artifact could still choose its own strictness this row would be 0.
    const root = await ws(config, artifact("advisory", gate));
    try {
      row[`stored gate=${gate}`] = await cliExit(root, ["report", "--json"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
  out(row);
}

// ---- R2: the artifact cannot select strictness, in BOTH directions.
for (const [label, config, storedMode, gate, expected] of [
  ["R2a workspace ci + stored mode advisory + gate fail", '{"mode":"ci"}', "advisory", "fail", 1],
  ["R2b workspace enforced + stored mode advisory + gate fail", '{"mode":"enforced"}', "advisory", "fail", 1],
  ["R2c workspace advisory + stored mode ci + gate fail (inverse control)", '{"mode":"advisory"}', "ci", "fail", 0],
  ["R2d workspace gateway + stored mode ci + gate fail (inverse control)", '{"mode":"gateway"}', "ci", "fail", 0],
  ["R2e workspace ci + stored mode 42 + gate fail", '{"mode":"ci"}', 42, "fail", 1],
  ["R2f workspace ci + stored mode absent + gate fail", '{"mode":"ci"}', undefined, "fail", 1],
  ["R2g workspace ci + stored mode ci + gate pass", '{"mode":"ci"}', "ci", "pass", 0],
  ["R2h workspace enforced + stored mode enforced + gate pass", '{"mode":"enforced"}', "enforced", "pass", 0],
] as const) {
  const root = await ws(config, artifact(storedMode, gate));
  try {
    const real = await cliExit(root, ["report", "--json"]);
    const report = await runReport({ cwd: root });
    out({
      label,
      realCliExit: real,
      expected,
      matches: real === expected,
      // The pure-function answer the earlier probe measured. Printed to show it
      // answers a different question and cannot observe this fix.
      pureFunctionWithArtifactMode: reportExitCode(report.gate, String(report.mode)),
      reportGateAfterAggregation: report.gate,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// ---- R3: an artifact that contradicts itself, and a missing artifact.
for (const [label, config, latest, expected] of [
  [
    "R3a workspace ci + stored gate pass over INCOMPLETE coverage",
    '{"mode":"ci"}',
    artifact("ci", "pass", { coverage: { status: "incomplete", reasons: ["x"] } }),
    1,
  ],
  [
    "R3b workspace enforced + stored gate pass over INCOMPLETE coverage",
    '{"mode":"enforced"}',
    artifact("enforced", "pass", { coverage: { status: "incomplete", reasons: ["x"] } }),
    1,
  ],
  ["R3c workspace ci + NO stored artifact at all", '{"mode":"ci"}', null, 1],
  ["R3d workspace enforced + NO stored artifact at all", '{"mode":"enforced"}', null, 1],
  ["R3e workspace ci + unparseable stored artifact", '{"mode":"ci"}', "{not json", 1],
  ["R3f workspace ci + stored artifact is a bare array", '{"mode":"ci"}', "[]", 1],
  ["R3g workspace advisory + NO stored artifact (report-only control)", '{"mode":"advisory"}', null, 0],
] as const) {
  const root = await ws(config, latest);
  try {
    const real = await cliExit(root, ["report", "--json"]);
    out({ label, realCliExit: real, expected, matches: real === expected });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
