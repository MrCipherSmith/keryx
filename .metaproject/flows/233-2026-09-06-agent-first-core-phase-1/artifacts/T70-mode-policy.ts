// T70 probe — row 2: MODE_RANK's new tie and the unguarded disabled-policy arm.
//
// Everything is driven through the REAL `analyze()` (the only caller of
// `appendIncidents`/`writeState`) and read back from the durable, append-only
// `incidents.jsonl` on disk — never from `evaluateSelfProtection`'s return
// value, so a defect at the call site cannot hide behind a clean pure function.
//
// Independent of T62-state.ts: this file drives ALL 12 ordered pairs of the four
// recognized modes with NO broken window at all (the transition alone), which
// T62-state.ts never does — its matrix always inserts a broken config between
// the two real modes and omits `gateway -> enforced`, `enforced -> ci` and
// `ci -> enforced` entirely.
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { analyze } from "../../../../src/security/service";
import { listIncidents } from "../../../../src/security/incidents";
import { readState } from "../../../../src/security/self-protect";
import { mergeSecurityConfig, renderSecurityConfig } from "../../../../src/security/config";
import type { SecurityConfig } from "../../../../src/security/types";

const out = (row: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(row)}\n`);
const CONTENT = "just some ordinary generated prose with no secret in it";
const MODES = ["advisory", "enforced", "ci", "gateway"] as const;
const BLOCKING = ["enforced", "ci", "gateway"];

async function ws(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "t70-mode-"));
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

async function setReal(root: string, mode: string, disabled: string[] = []): Promise<void> {
  const base = mergeSecurityConfig({ mode } as Partial<SecurityConfig>);
  for (const n of disabled) {
    (base.policies as Record<string, { enabled: boolean }>)[n]!.enabled = false;
  }
  await setRaw(root, renderSecurityConfig(base));
}

// Parses as an object, declares a mode this build does not recognize -> the
// loader keeps the operator's REAL policies and sets configUnreadable.
async function setBrokenMode(
  root: string,
  badMode: unknown,
  disabled: string[] = [],
): Promise<void> {
  const base = mergeSecurityConfig({ mode: "advisory" } as Partial<SecurityConfig>);
  for (const n of disabled) {
    (base.policies as Record<string, { enabled: boolean }>)[n]!.enabled = false;
  }
  const rendered = JSON.parse(renderSecurityConfig(base)) as Record<string, unknown>;
  rendered.mode = badMode;
  await setRaw(root, JSON.stringify(rendered, null, 2));
}

async function run(root: string) {
  const r = await analyze(root, {
    content: CONTENT,
    source: "generated",
    target: "memory",
  } as never);
  return { warnings: r.warnings };
}

async function trail(root: string) {
  const incidents = await listIncidents(root);
  const state = await readState(root);
  return {
    types: incidents.map((i) => i.type),
    messages: incidents.map((i) => i.message),
    stateMode: state?.mode ?? "NO STATE FILE",
    statePolicies: state?.policies ?? null,
  };
}

// ---------------------------------------------------------------------------
// M1: every ordered pair of recognized modes, NO broken window in between.
// Expectation derived from the contract, not from any prior artifact:
//   downgrade must be recorded IFF from is blocking and to is `advisory`.
// ---------------------------------------------------------------------------
for (const from of MODES) {
  for (const to of MODES) {
    if (from === to) continue;
    const root = await ws();
    try {
      await setReal(root, from);
      await run(root);
      const before = await trail(root);
      await setReal(root, to);
      await run(root);
      const after = await trail(root);
      const newTypes = after.types.slice(before.types.length);
      const detected = newTypes.includes("mode-downgrade");
      const shouldDetect = BLOCKING.includes(from) && to === "advisory";
      out({
        row: "M1",
        from,
        to,
        newIncidents: newTypes,
        newMessages: after.messages.slice(before.messages.length),
        downgradeDetected: detected,
        contractExpects: shouldDetect,
        verdict: detected === shouldDetect ? "OK" : "MISMATCH",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}

// ---------------------------------------------------------------------------
// M2: within-blocking transitions must record NOTHING AT ALL (not merely no
// mode-downgrade) — no warning either.
// ---------------------------------------------------------------------------
for (const from of BLOCKING) {
  for (const to of BLOCKING) {
    if (from === to) continue;
    const root = await ws();
    try {
      await setReal(root, from);
      await run(root);
      const before = await trail(root);
      await setReal(root, to);
      const r = await run(root);
      const after = await trail(root);
      out({
        row: "M2",
        from,
        to,
        newIncidents: after.types.slice(before.types.length),
        warnings: r.warnings,
        silent: after.types.length === before.types.length && r.warnings.length === 0,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}

// ---------------------------------------------------------------------------
// P: the disabled-policy arm through an UNRECOGNIZED-MODE window, across
// several spellings of "unrecognized" — including a null mode key and a
// trailing-space mode, which take the same loader branch.
// ---------------------------------------------------------------------------
const BAD_MODES: [string, unknown][] = [
  ["ENFORCED (case)", "ENFORCED"],
  ["'enforced ' (trailing space)", "enforced "],
  ["null mode key", null],
  ["numeric mode", 7],
  ["typo 'enfoced'", "enfoced"],
];

for (const [label, badMode] of BAD_MODES) {
  const root = await ws();
  try {
    await setReal(root, "enforced");
    await run(root);
    const before = await trail(root);
    await setBrokenMode(root, badMode, ["promptInjection"]);
    const r = await run(root);
    const during = await trail(root);
    out({
      row: "P1 unrecognized-mode window + a REAL policy disable",
      label,
      newIncidents: during.types.slice(before.types.length),
      warnings: r.warnings,
      realDisableDetectedDuringWindow: during.types
        .slice(before.types.length)
        .includes("policy-disabled"),
      stateNotOverwritten: during.stateMode === "enforced",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// P2: the UNUSABLE-PAYLOAD window. The implementer's claim is that removing the
// guard is a MATHEMATICAL no-op here because every derived policy is
// `enabled:true` by construction. Attack it with six unusable payload shapes
// AND with a prior state in which every policy was already disabled — the shape
// that would maximise the chance of a spurious `policy-disabled`.
// ---------------------------------------------------------------------------
const UNUSABLE: [string, string][] = [
  ["null", "null"],
  ["array", "[]"],
  ["number", "42"],
  ["string", '"advisory"'],
  ["boolean", "true"],
  ["unparseable", "{ not json"],
];
const ALL_POLICIES = ["secrets", "pii", "promptInjection", "egress", "artifactSafety"];

for (const [label, body] of UNUSABLE) {
  for (const prior of [[] as string[], ALL_POLICIES]) {
    const root = await ws();
    try {
      await setReal(root, "enforced", prior);
      await run(root);
      const before = await trail(root);
      await setRaw(root, body);
      const r = await run(root);
      const during = await trail(root);
      out({
        row: "P2 unusable-payload window (guard removed: must stay silent)",
        label,
        priorDisabled: prior.length,
        newIncidents: during.types.slice(before.types.length),
        warnings: r.warnings,
        silent: during.types.length === before.types.length && r.warnings.length === 0,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}

// ---------------------------------------------------------------------------
// P3: the system's own defensive reaction must stay suppressed. A REAL prior
// mode, then an unrecognized-mode window whose forced `mode:"enforced"` is
// WEAKER than the prior `gateway` under the OLD ranks and EQUAL under the new
// ones: no `mode-downgrade` may be written for the forced substitute, while the
// operator's genuine policy disable in the same file still is.
// ---------------------------------------------------------------------------
for (const prior of MODES) {
  const root = await ws();
  try {
    await setReal(root, prior);
    await run(root);
    const before = await trail(root);
    await setBrokenMode(root, "ENFORCED", ["egress"]);
    const r = await run(root);
    const during = await trail(root);
    const newTypes = during.types.slice(before.types.length);
    out({
      row: "P3 forced-substitute mode must not be reported as a downgrade",
      prior,
      newIncidents: newTypes,
      warnings: r.warnings,
      modeDowngradeFabricated: newTypes.includes("mode-downgrade"),
      realDisableStillReported: newTypes.includes("policy-disabled"),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
