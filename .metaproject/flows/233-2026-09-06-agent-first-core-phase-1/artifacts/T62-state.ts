// T62 probe — row 2. Independent recheck of T61's extension of T58's guard to
// BOTH self-protection comparison arms (mode-downgrade AND disabled-policy).
//
// Measured at `analyze()` — the real call site of `evaluateSelfProtection`, and
// the only caller of `appendIncidents`/`writeState` — never at
// `evaluateSelfProtection` itself, so a fix made at the call site is observable
// and a defect at the call site cannot hide behind a clean pure function.
//
// Incidents are read from the durable, append-only `incidents.jsonl`
// IMMEDIATELY AFTER the broken run as well as after the repair, because T57
// F-002's defect was a durable entry written DURING the window that survived
// the repair.
//
// Read-only against production code; every fixture is `mkdtemp`, removed in
// `finally`.
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { analyze } from "../../../../src/security/service";
import { readState } from "../../../../src/security/self-protect";
import { listIncidents } from "../../../../src/security/incidents";
import { mergeSecurityConfig, renderSecurityConfig } from "../../../../src/security/config";
import type { SecurityConfig } from "../../../../src/security/types";

const out = (row: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(row)}\n`);

const CONTENT = "just some ordinary generated prose with no secret in it";

async function ws(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "t62-state-"));
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  await writeFile(
    path.join(root, ".metaproject", "metaproject.json"),
    JSON.stringify({ modules: { security: { enabled: true } } }),
    "utf8",
  );
  return root;
}

async function setRaw(root: string, body: string): Promise<void> {
  await writeFile(path.join(root, ".metaproject", "security.config.json"), body, "utf8");
}

// A well-formed config with a CORRECT `configChecksum`, so the checksum arm
// never fires and every incident measured below is the arm under test.
async function setReal(
  root: string,
  mode: string,
  disabled: string[] = [],
): Promise<void> {
  const base = mergeSecurityConfig({ mode } as Partial<SecurityConfig>);
  for (const name of disabled) {
    (base.policies as Record<string, { enabled: boolean }>)[name]!.enabled = false;
  }
  await setRaw(root, renderSecurityConfig(base));
}

// A config that PARSES but declares a mode this build cannot recognize, so
// `configUnreadable` is set while the operator's real `policies` survive the
// merge. This is the arm where suppressing the policy comparison suppresses a
// statement that IS true of the run.
async function setBrokenMode(root: string, disabled: string[] = []): Promise<void> {
  const base = mergeSecurityConfig({ mode: "advisory" } as Partial<SecurityConfig>);
  for (const name of disabled) {
    (base.policies as Record<string, { enabled: boolean }>)[name]!.enabled = false;
  }
  const rendered = JSON.parse(renderSecurityConfig(base)) as Record<string, unknown>;
  rendered.mode = "ENFORCED";
  await setRaw(root, JSON.stringify(rendered, null, 2));
}

async function run(root: string): Promise<{ warnings: string[] }> {
  const result = await analyze(root, {
    content: CONTENT,
    source: "generated",
    target: "memory",
  } as never);
  return { warnings: result.warnings };
}

async function trail(root: string) {
  const state = await readState(root);
  const incidents = await listIncidents(root);
  return {
    stateMode: state?.mode ?? "NO STATE FILE",
    statePolicies: state?.policies ?? null,
    incidentTypes: incidents.map((i) => i.type),
  };
}

const BROKEN: [string, (root: string) => Promise<void>][] = [
  ["unusable payload (null)", async (root) => setRaw(root, "null")],
  ["unrecognized mode (ENFORCED)", async (root) => setBrokenMode(root)],
];

// ---------------------------------------------------------------------------
// A. The mode arm. Prior real mode M, broken window, repair to R.
//    R is chosen to be the SAME mode, a STRICTER one, and a WEAKER one.
// ---------------------------------------------------------------------------
const MODE_MATRIX: [string, string, string, boolean][] = [
  // [prior, repairTo, direction, expectIncidentAfterRepair]
  ["gateway", "gateway", "same", false],
  ["gateway", "ci", "weaker", true],
  ["gateway", "advisory", "weaker", true],
  ["ci", "ci", "same", false],
  ["ci", "gateway", "stricter", false],
  ["ci", "advisory", "weaker", true],
  ["enforced", "enforced", "same", false],
  ["enforced", "gateway", "stricter", false],
  ["enforced", "advisory", "weaker", true],
  ["advisory", "advisory", "same", false],
  ["advisory", "enforced", "stricter", false],
];

for (const [brokenLabel, breakIt] of BROKEN) {
  for (const [prior, repairTo, direction, expectIncident] of MODE_MATRIX) {
    const root = await ws();
    try {
      await setReal(root, prior);
      await run(root);
      const afterReal = await trail(root);

      await breakIt(root);
      const brokenRun = await run(root);
      const duringWindow = await trail(root);

      await setReal(root, repairTo);
      const repairRun = await run(root);
      const afterRepair = await trail(root);

      out({
        label: `A [${brokenLabel}] ${prior} -> BROKEN -> ${repairTo} (${direction})`,
        stateAfterReal: afterReal.stateMode,
        stateDuringWindow: duringWindow.stateMode,
        stateAfterRepair: afterRepair.stateMode,
        incidentsDuringWindow: duringWindow.incidentTypes,
        incidentsAfterRepair: afterRepair.incidentTypes,
        warningsDuringWindow: brokenRun.warnings,
        warningsAfterRepair: repairRun.warnings,
        durableIncidentWrittenByTheBrokenRun:
          duringWindow.incidentTypes.length > afterReal.incidentTypes.length,
        expectedIncidentAfterRepair: expectIncident,
        actualIncidentAfterRepair: afterRepair.incidentTypes.includes("mode-downgrade"),
        verdict:
          afterRepair.incidentTypes.includes("mode-downgrade") === expectIncident &&
          duringWindow.incidentTypes.length === afterReal.incidentTypes.length
            ? "OK"
            : "MISMATCH",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}

// ---------------------------------------------------------------------------
// B. The disabled-policy arm — the arm T61 newly guarded.
//
// B1 is the case the guard's own justification does NOT cover: with an
// unrecognized mode, `mergeSecurityConfig` keeps the operator's REAL policies,
// so the policy comparison is a true statement about the operator's own file,
// not a derived substitute. Does the new guard suppress a genuine disable?
// ---------------------------------------------------------------------------
{
  // B0 control: readable config, policy genuinely disabled -> incident fires.
  const root = await ws();
  try {
    await setReal(root, "enforced");
    await run(root);
    await setReal(root, "enforced", ["promptInjection"]);
    const r = await run(root);
    const t = await trail(root);
    out({
      label: "B0 control: readable config, promptInjection disabled",
      incidents: t.incidentTypes,
      warnings: r.warnings,
      verdict: t.incidentTypes.includes("policy-disabled") ? "OK (detected)" : "MISS",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

{
  // B1: unrecognized mode AND a genuinely disabled policy in the SAME file.
  const root = await ws();
  try {
    await setReal(root, "enforced");
    await run(root);
    const afterReal = await trail(root);

    await setBrokenMode(root, ["promptInjection"]);
    const brokenRun = await run(root);
    const duringWindow = await trail(root);

    // Repair only the mode; the policy stays genuinely disabled.
    await setReal(root, "enforced", ["promptInjection"]);
    const repairRun = await run(root);
    const afterRepair = await trail(root);

    out({
      label: "B1 broken mode + REAL policy disable in the same file",
      incidentsAfterReal: afterReal.incidentTypes,
      incidentsDuringWindow: duringWindow.incidentTypes,
      warningsDuringWindow: brokenRun.warnings,
      incidentsAfterRepair: afterRepair.incidentTypes,
      warningsAfterRepair: repairRun.warnings,
      trueDisableSuppressedDuringWindow:
        !duringWindow.incidentTypes.includes("policy-disabled"),
      detectedOnceRepaired: afterRepair.incidentTypes.includes("policy-disabled"),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

{
  // B2: unrecognized mode + a genuinely disabled policy, and the operator NEVER
  // repairs. Two further broken runs. Is the real disable ever recorded?
  const root = await ws();
  try {
    await setReal(root, "enforced");
    await run(root);
    await setBrokenMode(root, ["promptInjection", "egress"]);
    await run(root);
    await run(root);
    await run(root);
    const t = await trail(root);
    out({
      label: "B2 broken mode + REAL policy disable, never repaired (3 runs)",
      incidents: t.incidentTypes,
      stateMode: t.stateMode,
      statePoliciesPromptInjection:
        (t.statePolicies as Record<string, boolean> | null)?.promptInjection ?? null,
      realDisableEverRecorded: t.incidentTypes.includes("policy-disabled"),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

{
  // B3: unusable payload after a real config with a disabled policy. The forced
  // config's policies are the DEFAULTS (all enabled), so no policy-disabled
  // comparison can fire in this direction at all — the control that shows the
  // guard is a no-op for this broken shape.
  const root = await ws();
  try {
    await setReal(root, "enforced", ["egress"]);
    await run(root);
    const afterReal = await trail(root);
    await setRaw(root, "null");
    await run(root);
    const duringWindow = await trail(root);
    out({
      label: "B3 unusable payload after a config that already disabled egress",
      incidentsAfterReal: afterReal.incidentTypes,
      incidentsDuringWindow: duringWindow.incidentTypes,
      statePoliciesEgress:
        (duringWindow.statePolicies as Record<string, boolean> | null)?.egress ?? null,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// C. First run ever, config already broken, no prior state.
// ---------------------------------------------------------------------------
for (const [brokenLabel, breakIt] of BROKEN) {
  const root = await ws();
  try {
    await breakIt(root);
    await run(root);
    const one = await trail(root);
    await run(root);
    await run(root);
    const three = await trail(root);
    await setReal(root, "ci");
    await run(root);
    const repaired = await trail(root);
    out({
      label: `C first run already broken [${brokenLabel}]`,
      stateAfterOneBrokenRun: one.stateMode,
      stateAfterThreeBrokenRuns: three.stateMode,
      incidentsAfterThreeBrokenRuns: three.incidentTypes,
      stateAfterFirstReadableConfig: repaired.stateMode,
      incidentsAfterFirstReadableConfig: repaired.incidentTypes,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// D. The checksum arm is NOT guarded by `configUnreadable`. Does a broken
//    window make it assert tampering that did not happen?
// ---------------------------------------------------------------------------
{
  const root = await ws();
  try {
    await setReal(root, "enforced");
    await run(root);
    // A file that parses, declares an unrecognized mode, and carries a
    // checksum that no longer matches its own policies.
    const base = mergeSecurityConfig({ mode: "advisory" } as Partial<SecurityConfig>);
    const rendered = JSON.parse(renderSecurityConfig(base)) as Record<string, unknown>;
    rendered.mode = "ENFORCED";
    rendered.configChecksum = "0".repeat(64);
    await setRaw(root, JSON.stringify(rendered, null, 2));
    const r = await run(root);
    const t = await trail(root);
    out({
      label: "D broken mode + a checksum that does not match its own policies",
      incidents: t.incidentTypes,
      warnings: r.warnings,
      note: "checksum arm is intentionally unguarded; it compares the file against itself",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
