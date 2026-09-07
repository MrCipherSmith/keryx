import { mock, test, expect } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  formatGuardWarning,
  guardOutput,
  isSecurityEnabled,
  prepareOutputForPersistence,
  redactRaw,
  securityFlowGate,
} from "./guard";
import { runGate, runReport } from "./service";
import { loadSecurityConfig } from "./config";
import type { SecurityGateStatus, SecurityMode } from "./types";
import { keyDir } from "./redact";

const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";

// Create a temp workspace. `security` controls whether the module is enabled in
// metaproject.json; `mode` (when given) writes a security.config.json so the
// engine loads advisory/enforced/ci as requested.
async function makeWorkspace(opts: {
  security?: boolean;
  mode?: SecurityMode;
} = {}): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "gd-guard-"));
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
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

test("disabled module: guardOutput is a no-op allow with no findings", async () => {
  const root = await makeWorkspace({ security: false, mode: "enforced" });
  try {
    const result = await guardOutput({
      cwd: root,
      content: `token = ${AWS_KEY}`,
      target: "memory",
    });
    expect(result.allowed).toBe(true);
    expect(result.decision.findings).toEqual([]);
    expect(result.reason).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("no manifest at all: security is disabled and guardOutput is a no-op", async () => {
  const root = await makeWorkspace({});
  try {
    expect(await isSecurityEnabled(root)).toBe(false);
    const result = await guardOutput({ cwd: root, content: AWS_KEY, target: "wiki" });
    expect(result.allowed).toBe(true);
    expect(result.decision.findings).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("empty content short-circuits to allow even when enabled+enforced", async () => {
  const root = await makeWorkspace({ security: true, mode: "enforced" });
  try {
    const result = await guardOutput({ cwd: root, content: "", target: "memory" });
    expect(result.allowed).toBe(true);
    expect(result.decision.findings).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("advisory: allowed:true even with a planted secret (report-only)", async () => {
  const root = await makeWorkspace({ security: true, mode: "advisory" });
  try {
    const result = await guardOutput({
      cwd: root,
      content: `aws_key = ${AWS_KEY}`,
      target: "memory",
    });
    expect(result.allowed).toBe(true);
    expect(result.decision.findings.length).toBeGreaterThan(0);
    expect(result.decision.findings.some((f) => f.category === "secret")).toBe(true);
    // A secret must never appear raw in the returned decision.
    expect(JSON.stringify(result.decision)).not.toContain(AWS_KEY);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// T44: the persistence materializer must carry the redaction outcome through
// the FULL seam, not just against a hand-built GuardResult (see the unit-level
// regressions in persistence-sinks.test.ts). Advisory mode is used here
// because it never blocks, so the same call proves guardOutput's real
// `redacted` content flows into `prepareOutputForPersistence`.
//
// Note what this demonstrates about the two-pass architecture: the mandatory
// deterministic floor already runs once inside `guardOutput` itself (on the
// caller's original bytes), so by the time `prepareOutputForPersistence` runs
// its OWN pass over `guard.redacted`, that text is already clean and its
// `redaction.state` reads "none" -- the masking already happened upstream.
// `bytesPreserved` is therefore the reliable, always-correct signal for "did
// I get back my exact original bytes", end to end; `redaction` additionally
// names *why* when the materializer's own pass is what found the problem
// (the `pass`-fixture "guard omitted redaction" scenarios in
// persistence-sinks.test.ts, and the duplicate-member/canonical-form class
// when `guard.redacted` was not already set to the canonical form).
test("advisory guardOutput -> prepareOutputForPersistence: a caller can tell a masked write from a byte-preserved one", async () => {
  const root = await makeWorkspace({ security: true, mode: "advisory" });
  try {
    const secretContent = JSON.stringify({ aws_key: AWS_KEY, note: "safe" });
    const guard = await guardOutput({ cwd: root, content: secretContent, target: "memory" });
    expect(guard.allowed).toBe(true);
    expect(guard.redacted).toBeDefined();
    const masked = prepareOutputForPersistence(guard, secretContent);
    expect(masked.allowed).toBe(true);
    if (!masked.allowed) return;
    expect(masked.content).not.toContain(AWS_KEY);
    // Not byte-preserved -- this is the reliable signal a caller checks first.
    expect(masked.bytesPreserved).toBe(false);
    expect(masked.content).not.toBe(secretContent);

    const cleanContent = JSON.stringify({ note: "nothing sensitive here" });
    const cleanGuard = await guardOutput({ cwd: root, content: cleanContent, target: "memory" });
    expect(cleanGuard.redacted).toBeUndefined();
    const preserved = prepareOutputForPersistence(cleanGuard, cleanContent);
    expect(preserved.allowed).toBe(true);
    if (!preserved.allowed) return;
    expect(preserved.content).toBe(cleanContent);
    expect(preserved.bytesPreserved).toBe(true);
    expect(preserved.redaction.state).toBe("none");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("enforced: allowed:false on a planted secret, with a leak-safe reason", async () => {
  const root = await makeWorkspace({ security: true, mode: "enforced" });
  try {
    const result = await guardOutput({
      cwd: root,
      content: `aws_key = ${AWS_KEY}`,
      target: "memory",
    });
    expect(result.allowed).toBe(false);
    expect(result.decision.gate).toBe("fail");
    expect(result.reason).toBeDefined();
    expect(result.reason).not.toContain(AWS_KEY);
    expect(result.reason).toContain("secret");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ci mode also blocks a failing decision", async () => {
  const root = await makeWorkspace({ security: true, mode: "ci" });
  try {
    const result = await guardOutput({ cwd: root, content: AWS_KEY, target: "report" });
    expect(result.allowed).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("formatGuardWarning summarizes by category+count and never leaks raw content", async () => {
  const root = await makeWorkspace({ security: true, mode: "advisory" });
  try {
    const result = await guardOutput({
      cwd: root,
      content: `aws_key = ${AWS_KEY}`,
      target: "memory",
    });
    const warning = formatGuardWarning(result.decision, "memory");
    expect(warning).toBeString();
    expect(warning).not.toContain(AWS_KEY);
    expect(warning).toContain("secret");
    expect(warning).toContain("[memory]");
    // No findings -> null.
    expect(formatGuardWarning({ gate: "pass", action: "allow", findings: [] })).toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("redactRaw: disabled advisory module still applies the mandatory secret floor", async () => {
  const root = await makeWorkspace({ security: false });
  try {
    const content = `token = ${AWS_KEY}\nplain line`;
    const out = await redactRaw({ cwd: root, content });
    expect(out.content).not.toContain(AWS_KEY);
    expect(out.content).toContain("plain line");
    expect(out.findings).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("redactRaw: no secret -> byte-identical", async () => {
  const root = await makeWorkspace({ security: true, mode: "advisory" });
  try {
    const content = "just some normal log output\nnothing sensitive here\n";
    const out = await redactRaw({ cwd: root, content });
    expect(out.content).toBe(content);
    expect(out.findings).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("redactRaw: secret is masked and the raw value is gone", async () => {
  const root = await makeWorkspace({ security: true, mode: "advisory" });
  try {
    const content = `aws_key = ${AWS_KEY}\ntrailing`;
    const out = await redactRaw({ cwd: root, content });
    expect(out.findings.length).toBeGreaterThan(0);
    expect(out.content).not.toContain(AWS_KEY);
    expect(out.content).toContain("trailing");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("securityFlowGate: disabled -> null (gate omitted)", async () => {
  const root = await makeWorkspace({ security: false });
  try {
    expect(await securityFlowGate(root)).toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("securityFlowGate: advisory -> informational pass", async () => {
  const root = await makeWorkspace({ security: true, mode: "advisory" });
  try {
    const gate = await securityFlowGate(root);
    expect(gate?.status).toBe("pass");
    expect(gate?.detail).toContain("advisory");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("securityFlowGate: enforced with a failing scan report -> fail", async () => {
  const root = await makeWorkspace({ security: true, mode: "enforced" });
  try {
    const artifactsDir = path.join(root, ".metaproject", "data", "security", "artifacts");
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(
      path.join(artifactsDir, "latest.json"),
      JSON.stringify({ gate: "fail", findings: [] }),
      "utf8",
    );
    const gate = await securityFlowGate(root);
    expect(gate?.status).toBe("fail");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const mode of ["enforced", "ci", "advisory"] as const) {
  test(`guard preserves incomplete engine evidence in ${mode} mode`, async () => {
    const root = await makeWorkspace({ security: true, mode });
    try {
      await mkdir(path.join(keyDir(root), "hmac.key"), { recursive: true });
      const result = await guardOutput({ cwd: root, content: "ordinary text", target: "memory" });
      expect(result.decision.gate).toBe("incomplete");
      expect(result.allowed).toBe(mode === "advisory");
      expect(formatGuardWarning(result.decision)).toContain("incomplete");
      expect(JSON.stringify(result)).not.toContain(root);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test("strict flow gate refuses incomplete security evidence", async () => {
  const root = await makeWorkspace({ security: true, mode: "enforced" });
  try {
    const artifacts = path.join(root, ".metaproject", "data", "security", "artifacts");
    await mkdir(artifacts, { recursive: true });
    await writeFile(path.join(artifacts, "latest.json"), JSON.stringify({ gate: "incomplete", findings: [] }));
    const gate = await securityFlowGate(root);
    expect(gate?.status).toBe("fail");
    expect(gate?.detail).toContain("incomplete");
  } finally { await rm(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// T33 regressions: one per defect on the path from loading the security config
// to the flow-completion gate. `runGate`/`runReport` are exercised from this
// file because it is the one test file that owns this seam end to end - the
// flow gate's answer is only as truthful as the gate fold underneath it.
// ---------------------------------------------------------------------------

// A stored artifact with the full committable shape, parameterized by `gate`.
function storedReport(gate: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    createdAt: "2026-09-06T00:00:00.000Z",
    mode: "ci",
    gate,
    rawRetention: "off",
    summary: { total: 0, bySeverity: {}, byAction: {}, byCategory: {} },
    findings: [],
    ...extra,
  });
}

async function writeLatest(root: string, body: string): Promise<void> {
  const dir = path.join(root, ".metaproject", "data", "security", "artifacts");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "latest.json"), body, "utf8");
}

// A workspace whose stored evidence is `body`; `undefined` writes nothing.
async function workspaceWithLatest(body?: string): Promise<string> {
  const root = await makeWorkspace({ security: true, mode: "ci" });
  if (body !== undefined) {
    await writeLatest(root, body);
  }
  return root;
}

// Force `loadSecurityConfig` to reject, which is the only way to reach the two
// posture-unavailable catch branches once the root trigger (a non-object config
// payload) is repaired in config.ts. Restored by the caller's `finally`.
// Snapshotted eagerly: a module namespace is live, so a reference to it would
// hand the mocked function back at restore time and leak the break into every
// later test in this file.
const realConfigExports = { ...(await import("./config")) };
const LOAD_ERROR_SENTINEL = "T33-CONFIG-LOAD-SENTINEL";

function breakConfigLoad(): void {
  mock.module("./config", () => ({
    ...realConfigExports,
    loadSecurityConfig: () => Promise.reject(new Error(LOAD_ERROR_SENTINEL)),
  }));
}

function restoreConfigLoad(): void {
  mock.module("./config", () => ({ ...realConfigExports }));
}

test("T33 D1: runGate reads missing or unparseable evidence as incomplete, never pass", async () => {
  const cases: Array<{ name: string; latest?: string }> = [
    { name: "no report at all" },
    { name: "truncated JSON", latest: '{"schemaVersion": 1, "gate": "fa' },
    { name: "empty file", latest: "" },
  ];
  for (const testCase of cases) {
    const root = await workspaceWithLatest(testCase.latest);
    try {
      const gate = await runGate({ cwd: root });
      expect(gate.status).toBe("incomplete");
      // The reason stays a constant: no path, no error text, no source bytes.
      expect(gate.reasons.join(" ")).not.toContain(root);
      expect(gate.reasons.join(" ")).not.toContain("JSON");
      // `report` shares `readLatestReport`; it must not synthesize a clean scan.
      expect((await runReport({ cwd: root })).gate).toBe("incomplete");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("T33 D2: the gate fold is exhaustive over recognized gates and refuses the rest", async () => {
  // `usable` says whether the stored bytes are a report at all: `runReport`
  // returns a usable artifact verbatim (it aggregates the last scan, it does
  // not re-decide it) and synthesizes an `incomplete` one otherwise.
  const cases: Array<{ latest: string; status: SecurityGateStatus; usable: boolean }> = [
    { latest: storedReport("pass"), status: "pass", usable: true },
    { latest: storedReport("fail"), status: "fail", usable: true },
    { latest: storedReport("incomplete"), status: "incomplete", usable: true },
    // The value that exists to stop an unattended write pending a human.
    { latest: storedReport("needs-approval"), status: "needs-approval", usable: true },
    { latest: storedReport("banana"), status: "incomplete", usable: false },
    { latest: '{"unrelated": true}', status: "incomplete", usable: false },
    { latest: JSON.stringify({ schemaVersion: 1, findings: [] }), status: "incomplete", usable: false },
    { latest: "[]", status: "incomplete", usable: false },
    { latest: "null", status: "incomplete", usable: false },
    // An artifact that claims a pass over coverage it calls incomplete.
    {
      latest: storedReport("pass", {
        coverage: { status: "incomplete", required: true, reasons: ["unreadable or denied entry"] },
      }),
      status: "incomplete",
      usable: true,
    },
  ];
  for (const testCase of cases) {
    const root = await workspaceWithLatest(testCase.latest);
    try {
      const gate = await runGate({ cwd: root });
      expect(gate.status).toBe(testCase.status);
      expect(gate.reasons.join(" ")).not.toContain("undefined");
      expect(gate.reasons.join(" ")).not.toContain(root);
      // Unusable bytes must never aggregate into a clean report either.
      if (!testCase.usable) {
        expect((await runReport({ cwd: root })).gate).toBe("incomplete");
      }
      // Whatever the artifact says, only a verified pass leaves the flow gate
      // non-blocking - `src/flow/service.ts` blocks on `fail` and nothing else.
      const flowGate = await securityFlowGate(root);
      expect(flowGate?.status).toBe(testCase.status === "pass" ? "pass" : "fail");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("T33 D2b: a recognized pass artifact still reports pass end to end", async () => {
  const root = await workspaceWithLatest(storedReport("pass"));
  try {
    expect((await runGate({ cwd: root })).status).toBe("pass");
    expect((await runReport({ cwd: root })).gate).toBe("pass");
    expect((await securityFlowGate(root))?.status).toBe("pass");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("T33 D3: guardOutput refuses a write when the security posture cannot be read", async () => {
  const root = await makeWorkspace({ security: true, mode: "enforced" });
  breakConfigLoad();
  try {
    const result = await guardOutput({
      cwd: root,
      content: `aws_key = ${AWS_KEY}`,
      target: "memory",
    });
    expect(result.allowed).toBe(false);
    expect(result.decision.gate).toBe("incomplete");
    expect(result.reason).toBeDefined();
    expect(result.reason).not.toContain(LOAD_ERROR_SENTINEL);
    expect(result.reason).not.toContain(root);
    expect(JSON.stringify(result)).not.toContain(AWS_KEY);
  } finally {
    restoreConfigLoad();
    await rm(root, { recursive: true, force: true });
  }
});

test("T33 D4: securityFlowGate blocks instead of vanishing when the posture cannot be read", async () => {
  const root = await makeWorkspace({ security: true, mode: "enforced" });
  breakConfigLoad();
  try {
    const gate = await securityFlowGate(root);
    // `null` means "module disabled" and omits the gate from flow completion;
    // an enabled module that cannot read its own mode must never borrow it.
    expect(gate).not.toBeNull();
    expect(gate?.status).toBe("fail");
    expect(gate?.detail).not.toContain(LOAD_ERROR_SENTINEL);
    expect(gate?.detail).not.toContain(root);
  } finally {
    restoreConfigLoad();
    await rm(root, { recursive: true, force: true });
  }
});

test("T33 D5: a stored needs-approval report blocks flow completion", async () => {
  const root = await makeWorkspace({ security: true, mode: "enforced" });
  try {
    await writeLatest(root, storedReport("needs-approval"));
    const gate = await securityFlowGate(root);
    // Only `fail` blocks completion in flow/service.ts, so an approval
    // requirement that maps anywhere else is consumed as approved.
    expect(gate?.status).toBe("fail");
    expect(gate?.detail).toContain("needs-approval");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("T33 root trigger: a non-object security.config.json falls back instead of throwing", async () => {
  const root = await makeWorkspace({ security: true, mode: "enforced" });
  try {
    for (const payload of ["null", "[]", "42", '"advisory"']) {
      await writeFile(
        path.join(root, ".metaproject", "security.config.json"),
        payload,
        "utf8",
      );
      const config = await loadSecurityConfig(root);
      expect(config.policies.secrets.enabled).toBe(true);

      // The reproducer from the T30 review: the planted secret used to pass
      // through with `allowed: true` and a `pass` decision carrying no
      // findings. T33 stopped the throw; T35 F-003 / T37 close the residual
      // T33 left open (see T37-implementation.md): a present-but-unusable
      // config is now posture-unavailable and BLOCKS before analysis ever
      // runs, rather than silently taking the permissive `advisory` default
      // and still analyzing content (which is what T33's version of this
      // test asserted via `findings.length > 0` -- that assertion no longer
      // holds because analysis does not run on this path at all now, and is
      // replaced by the stronger `allowed === false`).
      const result = await guardOutput({
        cwd: root,
        content: `aws_key = ${AWS_KEY}`,
        target: "memory",
      });
      expect(result.allowed).toBe(false);
      expect(result.decision.gate).not.toBe("pass");
      // And the flow gate participates rather than disappearing.
      expect(await securityFlowGate(root)).not.toBeNull();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// T37 regressions: T35 F-001 (blocker, manifest dereference), F-003 (major
// residual, config non-object payload downgrades enforcement), F-004 (minor,
// coverage-consistency fold not shared/exhaustive). Same shape as T33's own
// regressions above: a small file that parses but is not an object must make
// the security posture BLOCK, never disappear or silently downgrade.
// ---------------------------------------------------------------------------

// A workspace whose `.metaproject/metaproject.json` is `body` verbatim, for
// manifest-shape regressions (F-001).
async function workspaceWithManifest(body: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "gd-guard-"));
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  await writeFile(path.join(root, ".metaproject", "metaproject.json"), body, "utf8");
  return root;
}

// A workspace with security enabled and `.metaproject/security.config.json`
// set to `configBody` verbatim, optionally with a recorded prior
// self-protection mode, for config-shape regressions (F-003).
async function workspaceWithConfigBody(
  configBody: string,
  opts: { priorMode?: SecurityMode } = {},
): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "gd-guard-"));
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  await writeFile(
    path.join(root, ".metaproject", "metaproject.json"),
    JSON.stringify({ modules: { security: { enabled: true } } }),
    "utf8",
  );
  await writeFile(path.join(root, ".metaproject", "security.config.json"), configBody, "utf8");
  if (opts.priorMode) {
    const rawDir = path.join(root, ".metaproject", "data", "security", "raw");
    await mkdir(rawDir, { recursive: true });
    await writeFile(
      path.join(rawDir, "state.json"),
      JSON.stringify({
        mode: opts.priorMode,
        policies: { secrets: true, pii: true, promptInjection: true, egress: true, artifactSafety: true },
      }),
      "utf8",
    );
  }
  return root;
}

test("T37 D1: a metaproject.json that parses but is not an object never throws and blocks as posture-unavailable, not disabled", async () => {
  const root = await workspaceWithManifest("null");
  try {
    let threw: string | null = null;
    let enabled: boolean | null = null;
    try {
      enabled = await isSecurityEnabled(root);
    } catch (error) {
      threw = error instanceof Error ? error.message : String(error);
    }
    expect(threw).toBeNull();
    expect(enabled).toBe(false);

    // Not a disappearance: the posture cannot be established, so both seams
    // must block rather than silently allow / omit the gate.
    const guard = await guardOutput({ cwd: root, content: `aws_key = ${AWS_KEY}`, target: "memory" });
    expect(guard.allowed).toBe(false);
    expect(guard.decision.gate).toBe("incomplete");
    expect(guard.reason).toBeDefined();
    expect(guard.reason).not.toContain(root);
    expect(JSON.stringify(guard)).not.toContain(AWS_KEY);

    const gate = await securityFlowGate(root);
    expect(gate).not.toBeNull();
    expect(gate?.status).toBe("fail");
    expect(gate?.detail).not.toContain(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("T37 D1b: non-null non-object manifests (array, number, string, boolean) get the same never-throws, posture-unavailable treatment", async () => {
  for (const body of ["[]", "42", '"enabled"', "true"]) {
    const root = await workspaceWithManifest(body);
    try {
      let threw: string | null = null;
      let enabled: boolean | null = null;
      try {
        enabled = await isSecurityEnabled(root);
      } catch (error) {
        threw = error instanceof Error ? error.message : String(error);
      }
      expect(threw).toBeNull();
      expect(enabled).toBe(false);
      const gate = await securityFlowGate(root);
      expect(gate).not.toBeNull();
      expect(gate?.status).toBe("fail");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("T37 D2: a security.config.json that parses but is not an object blocks instead of silently downgrading to advisory, even with a recorded prior strict mode", async () => {
  for (const prior of [undefined, "ci" as const]) {
    const root = await workspaceWithConfigBody("null", prior ? { priorMode: prior } : {});
    try {
      const config = await loadSecurityConfig(root);
      expect(config.mode).toBe("enforced");
      expect(config.configUnreadable).toBe(true);

      const guard = await guardOutput({ cwd: root, content: `aws_key = ${AWS_KEY}`, target: "memory" });
      expect(guard.allowed).toBe(false);
      expect(guard.decision.gate).toBe("incomplete");
      expect(guard.reason).toBeDefined();
      expect(guard.reason).not.toContain(root);
      expect(JSON.stringify(guard)).not.toContain(AWS_KEY);

      const gate = await securityFlowGate(root);
      expect(gate?.status).toBe("fail");
      expect(gate?.detail).not.toContain(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("T37 D2b: a security.config.json that fails to parse takes the same unreadable path as a non-object payload", async () => {
  const root = await workspaceWithConfigBody("{not json");
  try {
    const config = await loadSecurityConfig(root);
    expect(config.mode).toBe("enforced");
    expect(config.configUnreadable).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("T37 D2c: an absent config file and a legitimate empty config object are unaffected -- defaults, not unreadable", async () => {
  const rootAbsent = await makeWorkspace({ security: true });
  try {
    const config = await loadSecurityConfig(rootAbsent);
    expect(config.mode).toBe("advisory");
    expect(config.configUnreadable).toBeUndefined();
  } finally {
    await rm(rootAbsent, { recursive: true, force: true });
  }

  const rootEmpty = await workspaceWithConfigBody("{}");
  try {
    const config = await loadSecurityConfig(rootEmpty);
    expect(config.mode).toBe("advisory");
    expect(config.configUnreadable).toBeUndefined();
  } finally {
    await rm(rootEmpty, { recursive: true, force: true });
  }
});

test("T37 D3: a coverage status that is neither complete nor incomplete reads as incomplete at both runGate and runReport", async () => {
  const root = await workspaceWithLatest(
    storedReport("pass", { coverage: { status: "partial", required: true, reasons: [] } }),
  );
  try {
    expect((await runGate({ cwd: root })).status).toBe("incomplete");
    expect((await runReport({ cwd: root })).gate).toBe("incomplete");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("T37 D3b: the coverage fold is exhaustive -- a non-object coverage value is incomplete, absent/null coverage still passes", async () => {
  const cases: Array<{ coverage?: unknown; expected: "pass" | "incomplete" }> = [
    { coverage: "incomplete", expected: "incomplete" }, // bare string, not an object
    { expected: "pass" }, // no coverage key at all -- no claim, not incomplete
    { coverage: null, expected: "pass" }, // explicit null -- no claim, not incomplete
  ];
  for (const testCase of cases) {
    const extra = "coverage" in testCase ? { coverage: testCase.coverage } : {};
    const root = await workspaceWithLatest(storedReport("pass", extra));
    try {
      expect((await runGate({ cwd: root })).status).toBe(testCase.expected);
      expect((await runReport({ cwd: root })).gate).toBe(testCase.expected);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

// ---------------------------------------------------------------------------
// T54 regressions: T39 F-002 (major -- a `mode` outside the closed union
// silently resolves to report-only), F-005 (minor -- a readable manifest with
// no `modules` key is treated as unreadable), F-008 (info -- the forced-closed
// posture must stay a returned flag). Same shape as the T37 block above: the
// posture a workspace cannot establish must BLOCK, and a posture it states
// perfectly clearly must be read as stated.
// ---------------------------------------------------------------------------

// Every mode value that is NOT one of the four `SecurityMode` declares, written
// verbatim into `security.config.json`. Each must be at least as strict as
// `enforced`, never report-only.
const UNRECOGNIZED_MODE_BODIES = [
  '{"mode":"bananas"}',
  '{"mode":"ENFORCED"}',
  '{"mode":"Ci"}',
  '{"mode":"enforced "}',
  '{"mode":" ci"}',
  '{"mode":"report-only"}',
  '{"mode":42}',
  '{"mode":true}',
  '{"mode":null}',
  '{"mode":[]}',
  '{"mode":{}}',
];

test("T54 D1: an unrecognized mode string resolves to the strictest posture, not to report-only", async () => {
  for (const body of ['{"mode":"bananas"}', '{"mode":"ENFORCED"}']) {
    const root = await workspaceWithConfigBody(body);
    try {
      // The mode axis carries the same rule as the config-shape axis (T37): a
      // posture this build cannot recognize is not a posture advisory can
      // report on, so it fails closed rather than defaulting to permissive.
      const config = await loadSecurityConfig(root);
      expect(config.mode).toBe("enforced");
      expect(config.configUnreadable).toBe(true);

      const guard = await guardOutput({
        cwd: root,
        content: `aws_key = ${AWS_KEY}`,
        target: "memory",
      });
      expect(guard.allowed).toBe(false);
      expect(guard.decision.gate).not.toBe("pass");
      expect(guard.reason).toBeDefined();
      expect(guard.reason).not.toContain(root);
      // The unrecognized value itself is source bytes and must not be echoed.
      expect(guard.reason).not.toContain("bananas");
      expect(guard.reason).not.toContain("ENFORCED");
      expect(JSON.stringify(guard)).not.toContain(AWS_KEY);

      const gate = await securityFlowGate(root);
      expect(gate).not.toBeNull();
      expect(gate?.status).toBe("fail");
      expect(gate?.detail).not.toContain(root);
      expect(gate?.detail).not.toContain("bananas");
      expect(gate?.detail).not.toContain("ENFORCED");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("T54 D1b: case, whitespace and non-string mode values are all forced closed -- the union is closed at the loader", async () => {
  for (const body of UNRECOGNIZED_MODE_BODIES) {
    const root = await workspaceWithConfigBody(body);
    try {
      const config = await loadSecurityConfig(root);
      expect(config.mode).toBe("enforced");
      expect(config.configUnreadable).toBe(true);
      const gate = await securityFlowGate(root);
      expect(gate?.status).toBe("fail");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("T54 D1c: an absent mode key is still the ordinary advisory default, and every recognized mode still resolves verbatim", async () => {
  // Non-regression pin for the permissive side: `{}` and a config with other
  // keys but no `mode` are "no mode configured", not "an unrecognized mode".
  for (const body of ["{}", '{"storeHashes":true}']) {
    const root = await workspaceWithConfigBody(body);
    try {
      const config = await loadSecurityConfig(root);
      expect(config.mode).toBe("advisory");
      expect(config.configUnreadable).toBeUndefined();
      expect((await securityFlowGate(root))?.status).toBe("pass");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  // `gateway`'s row was `blocks: false` (grouped with `advisory`) until T61.
  // T57 F-002 / "Judgement calls" #4 found that classification could not
  // stand alongside `MODE_RANK` (`self-protect.ts`), which ranks `gateway`
  // strictest of the four recognized modes -- a real AWS key allowed through
  // under the mode the codebase treats as its strictest posture. `MODE_RANK`
  // is the one anchored by committed, must-keep-passing behavior (T58's
  // `gateway -> ci` downgrade regression), so `isBlockingMode` (`guard.ts`)
  // was corrected to agree with it instead. See T61-spec.md.
  const recognized: Array<{ mode: SecurityMode; blocks: boolean }> = [
    { mode: "advisory", blocks: false },
    { mode: "gateway", blocks: true },
    { mode: "enforced", blocks: true },
    { mode: "ci", blocks: true },
  ];
  for (const { mode, blocks } of recognized) {
    const root = await workspaceWithConfigBody(JSON.stringify({ mode }));
    try {
      const config = await loadSecurityConfig(root);
      expect(config.mode).toBe(mode);
      expect(config.configUnreadable).toBeUndefined();
      const guard = await guardOutput({
        cwd: root,
        content: `aws_key = ${AWS_KEY}`,
        target: "memory",
      });
      expect(guard.allowed).toBe(!blocks);
      // The finding is on the decision in every mode; only blocking differs.
      expect(guard.decision.gate).toBe("fail");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("T54 D2: a readable manifest with no modules key means the module is disabled, not that the manifest is unreadable", async () => {
  // Every other manifest reader in the repository (capability/seam.ts,
  // commands/ctx.ts, testing/capability.ts, gdskills/*) reads an absent
  // `modules` as "module not configured". The security reader was alone in
  // reading it as a fault, which made a well-formed manifest harsher than an
  // absent one (T39 F-005).
  for (const body of ["{}", '{"name":"demo"}', '{"modules":{}}']) {
    const root = await workspaceWithManifest(body);
    try {
      expect(await isSecurityEnabled(root)).toBe(false);
      const guard = await guardOutput({
        cwd: root,
        content: `aws_key = ${AWS_KEY}`,
        target: "memory",
      });
      expect(guard.allowed).toBe(true);
      expect(await securityFlowGate(root)).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("T54 D2b: a manifest that exists but does not parse still blocks, and no enablement is inherited from a payload", async () => {
  // The unreadable verdict must come from an explicit "did not parse" signal,
  // not from the accident that `readJsonFileOr`'s `{}` fallback has no
  // `modules` key -- otherwise narrowing D2 would silently unblock these.
  for (const body of ["{not json", "", "   \n "]) {
    const root = await workspaceWithManifest(body);
    try {
      expect(await isSecurityEnabled(root)).toBe(false);
      const guard = await guardOutput({
        cwd: root,
        content: `aws_key = ${AWS_KEY}`,
        target: "memory",
      });
      expect(guard.allowed).toBe(false);
      expect(guard.decision.gate).toBe("incomplete");
      expect(guard.reason).not.toContain(root);
      expect((await securityFlowGate(root))?.status).toBe("fail");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  // A `__proto__` payload is a readable object whose OWN `modules` is absent,
  // so under D2 it reads as "module disabled" -- the same as `{}`. What must
  // hold either way is that no enablement is inherited from the payload and
  // the prototype is untouched.
  const proto = await workspaceWithManifest(
    '{"__proto__":{"modules":{"security":{"enabled":true}}}}',
  );
  try {
    expect(await isSecurityEnabled(proto)).toBe(false);
    expect(await securityFlowGate(proto)).toBeNull();
    expect((Object.prototype as unknown as { modules?: unknown }).modules).toBeUndefined();
  } finally {
    await rm(proto, { recursive: true, force: true });
  }
});

test("T54 D3: a forced-closed posture is a returned flag and never a write to the operator's config file", async () => {
  // A posture forced closed because the config is unusable (T37) or because
  // its mode is unrecognized (D1) is a derived, momentary fact. It is
  // observable through `configUnreadable`, and the config file on disk is
  // never rewritten to record it (T39 F-008: whatever consumes this must not
  // persist the synthesized mode as if it were the operator's choice).
  for (const body of ["null", '{"mode":"ENFORCED"}']) {
    const root = await workspaceWithConfigBody(body);
    const file = path.join(root, ".metaproject", "security.config.json");
    try {
      const config = await loadSecurityConfig(root);
      expect(config.mode).toBe("enforced");
      expect(config.configUnreadable).toBe(true);
      await guardOutput({ cwd: root, content: `aws_key = ${AWS_KEY}`, target: "memory" });
      await securityFlowGate(root);
      expect(await readFile(file, "utf8")).toBe(body);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});
