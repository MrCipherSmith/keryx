// T76 probe — independent recheck of T75's F-002/F-004 repair.
//
// Written fresh (not copied from T70/T75's probes), mock-free by design:
// drives the REAL, unmodified `runAdapter` + `computeGate` + `writeOutputs`
// (all exported from src/health/run.ts / src/health/gate.ts) directly, then
// reads the persisted artifact back from disk and re-reads the gate through
// the REAL `createCodeHealthService().gate({cwd})` — the exact value
// src/flow/service.ts's completion gate folds into flow.json. No
// `mock.module` anywhere in this script (the cross-file registry hazard both
// T69 and T75 document does not apply here since nothing shared is mocked).
//
// Three questions this script answers, each with its own section:
//   A. Is the fourth producer (`validation?.error` at run.ts:356-388) now
//      closed, and does the closed vocabulary resist near-miss escapes
//      (wrong case, trailing whitespace, prefix/suffix additions, a string
//      that is merely long)?
//   B. Does the pipeline downstream of the producer (computeGate ->
//      writeOutputs -> disk -> service.gate()) sanitize anything on its own,
//      or does safety depend entirely on the producer? Proven by manually
//      constructing a SourceRunInfo with raw attacker text as `.error`
//      (bypassing runAdapter entirely, simulating what today's shipped
//      regressions would see if run.ts's fix were reverted) and confirming
//      the leak surfaces at every hop -- i.e. that the shipped regressions'
//      assertions are not vacuous.
//   C. Do the existing three T69 catch-arm producers (detect/execution/parse)
//      remain closed, and does `safeErrorCode`'s errno allowlist still reject
//      a smuggled payload riding in `error.code`?
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  runAdapter,
  writeOutputs,
} from "../../../../src/health/run";
import { computeGate } from "../../../../src/health/gate";
import { createCodeHealthService } from "../../../../src/health/service";
import { DEFAULT_HEALTH_CONFIG } from "../../../../src/health/config";
import type {
  HealthContext,
  HealthReport,
  SourceAdapter,
  SourceRunInfo,
} from "../../../../src/health/types";

const out = (row: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(row)}\n`);

const ATTACKER_PATH = "/Users/attacker/.ssh/id_rsa";
const ATTACKER_CRED = "AKIAIOSFODNN7EXAMPLE";
const ATTACKER = `${ATTACKER_PATH} ${ATTACKER_CRED}`;

function scan(text: string) {
  return {
    path: text.includes(ATTACKER_PATH),
    cred: text.includes(ATTACKER_CRED),
  };
}

async function ws(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "t76-health-"));
}

async function healthContext(cwd: string): Promise<HealthContext> {
  return {
    cwd,
    config: DEFAULT_HEALTH_CONFIG,
    strict: false,
    scopeSelector: { kind: "project" },
    changedFiles: null,
    sourceFiles: [],
    moduleOf: () => null,
  };
}

function artifactPath(cwd: string, file: "latest.json" | "latest.md"): string {
  return path.join(cwd, ".metaproject", "data", "health", "artifacts", file);
}

async function runAndAssert(
  label: string,
  adapter: SourceAdapter,
): Promise<void> {
  const root = await ws();
  try {
    const ctx = await healthContext(root);
    const { info } = await runAdapter(adapter, ctx, { mode: "auto", required: true }, "t76-stamp");
    const gate = computeGate({
      findings: [],
      projectMetrics: undefined,
      sources: [info],
      config: DEFAULT_HEALTH_CONFIG,
      strict: false,
    });
    const report: HealthReport = {
      schemaVersion: DEFAULT_HEALTH_CONFIG.schemaVersion,
      generatedAt: new Date().toISOString(),
      scope: "project",
      strict: false,
      gitRef: null,
      gate,
      sources: [info],
      metrics: [],
      findings: [],
    };
    await writeOutputs(root, report, DEFAULT_HEALTH_CONFIG, "t76-stamp");
    const jsonBytes = await readFile(artifactPath(root, "latest.json"), "utf8");
    const mdBytes = await readFile(artifactPath(root, "latest.md"), "utf8");
    const serviceGate = await createCodeHealthService().gate({ cwd: root });

    out({
      section: "A/C",
      label,
      infoError: info.error ?? null,
      gateStatusInMemory: gate.status,
      gateStatusOnDisk: (JSON.parse(jsonBytes) as { gate: { status: string } }).gate.status,
      serviceGateStatus: serviceGate.status,
      LEAK_json: scan(jsonBytes),
      LEAK_md: scan(mdBytes),
      LEAK_serviceReasons: scan(serviceGate.reasons.join("\n")),
      LEAK_inMemoryReasons: scan(gate.reasons.join("\n")),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function unreachable(): never {
  throw new Error("unreachable — the throwing/rejecting stage should run first");
}

// ---------------------------------------------------------------------------
// A. Closed-vocabulary escape attempts against the F-002 fix (run.ts:356-388,
//    safeValidationError / KNOWN_VALIDATION_ERRORS).
// ---------------------------------------------------------------------------
function validateAdapter(validateError: string | undefined): SourceAdapter {
  return {
    id: "eslint",
    detect: async () => "available",
    import: async () => ({
      source: "eslint",
      command: null,
      toolVersion: null,
      exitCode: 0,
      rawPath: "",
      content: "[]",
      imported: true,
    }),
    run: async () => unreachable(),
    parse: () => [],
    validate: () => ({ valid: false, error: validateError }),
  };
}

const A_ROWS: Array<{ id: string; error: string | undefined }> = [
  { id: "A1 raw attacker text (the original F-002 shape)", error: `synthetic validation failure ${ATTACKER}` },
  { id: "A2 exact known-safe string (must survive unchanged)", error: "ESLint JSON parse failed" },
  { id: "A3 known string + trailing space (must NOT survive)", error: "ESLint JSON parse failed " },
  { id: "A4 known string, different case (must NOT survive)", error: "eslint json parse failed" },
  { id: "A5 known string as a PREFIX of a longer attacker string (must NOT survive)", error: `ESLint JSON parse failed: ${ATTACKER}` },
  { id: "A6 known dependency-audit string used on the eslint adapter (still in the Set, must survive)", error: "dependency audit JSON parse failed" },
  { id: "A7 undefined (falls back to the same default the branch already used)", error: undefined },
  { id: "A8 empty string (not in the Set)", error: "" },
  { id: "A9 a very long attacker-controlled string, no known substring", error: "x".repeat(500) + ATTACKER },
];

for (const row of A_ROWS) {
  await runAndAssert(row.id, validateAdapter(row.error));
}

// ---------------------------------------------------------------------------
// C. The three T69 catch-arm producers: still closed, and safeErrorCode still
//    rejects a smuggled payload riding in `error.code`.
// ---------------------------------------------------------------------------
function leaky(code?: string): Error {
  const e = new Error(`ENOENT: no such file or directory, open '${ATTACKER_PATH}' token=${ATTACKER_CRED}`) as NodeJS.ErrnoException;
  if (code !== undefined) e.code = code;
  return e;
}

await runAndAssert("C1 detect() throws, no code", {
  id: "eslint",
  detect: async () => { throw leaky(); },
  import: async () => unreachable(),
  run: async () => unreachable(),
  parse: () => [],
});
await runAndAssert("C2 import() throws, legal errno ENOENT (must be KEPT, nothing else)", {
  id: "eslint",
  detect: async () => "available",
  import: async () => { throw leaky("ENOENT"); },
  run: async () => unreachable(),
  parse: () => [],
});
await runAndAssert("C3 parse() throws, code SMUGGLES the payload (must be rejected by the regex)", {
  id: "eslint",
  detect: async () => "available",
  import: async () => ({ source: "eslint", command: null, toolVersion: null, exitCode: 0, rawPath: "", content: "{}", imported: true }),
  run: async () => unreachable(),
  parse: () => { throw leaky(`EACCES ${ATTACKER}`); },
});
await runAndAssert("C4 detect() throws, code is a 64-char all-caps string (length bound)", {
  id: "eslint",
  detect: async () => { throw leaky("A".repeat(64)); },
  import: async () => unreachable(),
  run: async () => unreachable(),
  parse: () => [],
});
await runAndAssert("C5 control: clean run, no throw", {
  id: "eslint",
  detect: async () => "available",
  import: async () => ({ source: "eslint", command: null, toolVersion: null, exitCode: 0, rawPath: "", content: "[]", imported: true }),
  run: async () => unreachable(),
  parse: () => [],
});

// ---------------------------------------------------------------------------
// B. Does anything DOWNSTREAM of the producer (computeGate / writeOutputs /
//    disk / service.gate()) sanitize on its own? Manually construct a
//    SourceRunInfo carrying RAW attacker text in `.error` -- bypassing
//    runAdapter entirely, i.e. simulating exactly what would reach this same
//    pipeline if run.ts's fix at :356-388 were reverted -- and confirm the
//    leak is NOT caught downstream. This is the proof that the shipped
//    regressions' `not.toContain` assertions are load-bearing on the
//    PRODUCER (run.ts), not on some other safety net, and would legitimately
//    fail if that producer regressed.
// ---------------------------------------------------------------------------
{
  const root = await ws();
  try {
    const leakedInfo: SourceRunInfo = {
      source: "eslint",
      status: "configured-but-failed",
      mode: "auto",
      required: true,
      imported: true,
      command: null,
      toolVersion: null,
      findings: 0,
      execution: "completed",
      parse: "failed",
      exitCode: 0,
      // Deliberately RAW -- this is what run.ts:386 would produce if
      // `safeValidationError(...)` were removed/bypassed.
      error: `synthetic validation failure ${ATTACKER}`,
    };
    const gate = computeGate({
      findings: [],
      projectMetrics: undefined,
      sources: [leakedInfo],
      config: DEFAULT_HEALTH_CONFIG,
      strict: false,
    });
    const report: HealthReport = {
      schemaVersion: DEFAULT_HEALTH_CONFIG.schemaVersion,
      generatedAt: new Date().toISOString(),
      scope: "project",
      strict: false,
      gitRef: null,
      gate,
      sources: [leakedInfo],
      metrics: [],
      findings: [],
    };
    await writeOutputs(root, report, DEFAULT_HEALTH_CONFIG, "t76-stamp");
    const jsonBytes = await readFile(artifactPath(root, "latest.json"), "utf8");
    const mdBytes = await readFile(artifactPath(root, "latest.md"), "utf8");
    const serviceGate = await createCodeHealthService().gate({ cwd: root });

    out({
      section: "B",
      label: "SIMULATED REVERTED FIX -- proves the downstream pipeline does not sanitize on its own",
      LEAK_json: scan(jsonBytes),
      LEAK_md: scan(mdBytes),
      LEAK_serviceReasons: scan(serviceGate.reasons.join("\n")),
      // If these are all {path:true,cred:true}, the shipped regressions'
      // assertions genuinely exercise the fix, not a downstream filter.
      wouldShippedAssertionsHaveCaughtThis: {
        jsonNotContainPath: !jsonBytes.includes(ATTACKER_PATH),
        jsonNotContainCred: !jsonBytes.includes(ATTACKER_CRED),
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
