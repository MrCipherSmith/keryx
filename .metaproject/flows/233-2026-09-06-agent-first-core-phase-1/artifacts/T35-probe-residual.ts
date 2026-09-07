/**
 * T35 independent probe D:
 *   D1  the disclosed residual -- a destroyed `security.config.json` takes the
 *       defaults (mode advisory), including in a workspace that HAS run before
 *       (state.json present with mode "ci"), so §14 self-protection is exercised.
 *   D2  the posture-unavailable branches (defects 4 and 5) reached the only way
 *       they can be reached now: by breaking the config module.
 *   D3  a twin of the T33 root trigger in the SIBLING reader
 *       (`isSecurityEnabled` -> `.metaproject/metaproject.json`), which the T33
 *       repair did not cover.
 *
 * Read-only on production code. All fixtures under mkdtemp, removed in finally.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mock } from "bun:test";
import { guardOutput, securityFlowGate, isSecurityEnabled } from "../../../../src/security/guard";
import { createFlowService } from "../../../../src/flow/service";
import type { FlowServiceDeps, TrackerAdapter } from "../../../../src/flow/types";
import { writeCleanReviewPackage } from "../../../../src/flow/review-fixtures";

const AWS_KEY = "AKIAABCDEFGHIJKLMNOP"; // synthetic, not a real credential
const HEAD = "c0ffee1c0ffee2c0ffee3c0ffee4c0ffee5c0ffe";
const out: Record<string, unknown> = {};
let failures = 0;

function check(label: string, ok: boolean, detail: unknown): void {
  if (!ok) failures += 1;
  out[label] = { ok, detail };
}

async function ws(opts: {
  manifest?: string;
  config?: string;
  priorMode?: string;
} = {}): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "t35-res-"));
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  await writeFile(
    path.join(root, ".metaproject", "metaproject.json"),
    opts.manifest ?? JSON.stringify({ modules: { security: { enabled: true } } }),
    "utf8",
  );
  if (opts.config !== undefined) {
    await writeFile(path.join(root, ".metaproject", "security.config.json"), opts.config, "utf8");
  }
  if (opts.priorMode) {
    const raw = path.join(root, ".metaproject", "data", "security", "raw");
    await mkdir(raw, { recursive: true });
    await writeFile(
      path.join(raw, "state.json"),
      JSON.stringify({
        mode: opts.priorMode,
        policies: { secrets: true, pii: true, promptInjection: true, egress: true, artifactSafety: true },
      }),
      "utf8",
    );
  }
  return root;
}

// ---------------------------------------------------------------------------
// D1: the disclosed residual, with and without prior state.
// ---------------------------------------------------------------------------
for (const prior of [undefined, "ci"] as const) {
  const root = await ws({
    config: "null",
    ...(prior ? { priorMode: prior } : {}),
  });
  try {
    const guard = await guardOutput({ cwd: root, content: `aws_key = ${AWS_KEY}`, target: "memory" });
    const flow = await securityFlowGate(root);
    check(
      `D1 destroyed config (prior state: ${prior ?? "none"}): the write is still ALLOWED`,
      guard.allowed === true,
      {
        allowed: guard.allowed,
        gate: guard.decision.gate,
        findings: guard.decision.findings.length,
        reason: guard.reason ?? null,
        flowGate: flow,
      },
    );
    // Documenting, not asserting a defect: does prior state change the outcome?
    out[`D1 detail (prior state: ${prior ?? "none"})`] = {
      guardAllowed: guard.allowed,
      decisionGate: guard.decision.gate,
      findingCount: guard.decision.findings.length,
      flowGateStatus: flow?.status ?? null,
      flowGateDetail: flow?.detail ?? null,
      flowGateBlocksCompletion: flow?.status === "fail",
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// D3: the sibling reader. `.metaproject/metaproject.json` == "null".
// ---------------------------------------------------------------------------
{
  const root = await ws({ manifest: "null", config: JSON.stringify({ schemaVersion: 1, mode: "ci" }) });
  try {
    let enabledThrew: string | null = null;
    try {
      await isSecurityEnabled(root);
    } catch (error) {
      enabledThrew = error instanceof Error ? error.message : String(error);
    }
    let guardThrew: string | null = null;
    let guardResult: unknown = null;
    try {
      guardResult = await guardOutput({ cwd: root, content: `aws_key = ${AWS_KEY}`, target: "memory" });
    } catch (error) {
      guardThrew = error instanceof Error ? error.message : String(error);
    }
    let gateThrew: string | null = null;
    let gateResult: unknown = null;
    try {
      gateResult = await securityFlowGate(root);
    } catch (error) {
      gateThrew = error instanceof Error ? error.message : String(error);
    }
    out["D3 manifest=null"] = {
      isSecurityEnabledThrew: enabledThrew,
      guardOutputThrew: guardThrew,
      guardOutputResult: guardResult,
      securityFlowGateThrew: gateThrew,
      securityFlowGateResult: gateResult,
    };
    check("D3 securityFlowGate is documented `Never throws`", gateThrew === null, gateThrew);
    check("D3 guardOutput is documented never to resolve toward `everything is fine`",
      guardThrew === null, guardThrew);

    // What does the flow completion pipeline do with a THROWING security gate?
    if (gateThrew !== null) {
      const deps: FlowServiceDeps = {
        tracker: {
          id: "fake", detect: async () => true, parseRef: () => null,
          fetchIssue: async () => ({ title: "T", body: "B" }),
          prStatus: async () => ({ exists: true, isDraft: true, checksGreen: true, headSha: HEAD }),
          comment: async () => true,
        } as TrackerAdapter,
        healthGate: async () => ({ status: "pass", reasons: [] }),
        now: () => new Date("2026-07-07T10:00:00Z"),
        securityGate: (cwd) => securityFlowGate(cwd),
      };
      const service = createFlowService(deps);
      const { flow, dir: created } = await service.init({ cwd: root, title: "T35 residual" });
      await writeFile(
        path.join(root, ".metaproject", "flows", path.basename(created), "acceptance-criteria.md"),
        "# Acceptance Criteria\n\n## Criteria\n\n- AC1: Criterion one\n", "utf8",
      );
      await service.freeze({ cwd: root, id: flow.id });
      await service.start({ cwd: root, id: flow.id });
      for (const t of ["T1", "T2", "T3", "T4"]) await service.taskDone({ cwd: root, id: flow.id, taskId: t });
      await service.implemented({ cwd: root, id: flow.id, prUrl: "https://github.com/acme/app/pull/1" });
      await service.acConfirm({ cwd: root, id: flow.id, criterion: "AC1" });
      await writeCleanReviewPackage({
        cwd: root, flowDir: path.basename(created), head: HEAD, prUrl: "https://github.com/acme/app/pull/1",
      });
      const result = await service.complete({ cwd: root, id: flow.id });
      const security = result.gates.find((g) => g.name === "security");
      out["D3 flow completion under the throwing gate"] = {
        passed: result.passed,
        securityGateRow: security ?? "<no security gate entry>",
        detailLeaksInternalError: String(security?.detail ?? "").includes("is not an object")
          || String(security?.detail ?? "").includes("undefined is not"),
      };
      check("D3 a security gate that could not run still blocks completion", result.passed === false, {
        passed: result.passed, security,
      });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// Non-null non-object manifests, for the class boundary.
for (const body of ["[]", "42", '"enabled"', "true"]) {
  const root = await ws({ manifest: body });
  try {
    let threw: string | null = null;
    let enabled: boolean | null = null;
    try {
      enabled = await isSecurityEnabled(root);
    } catch (error) {
      threw = error instanceof Error ? error.message : String(error);
    }
    out[`D3 manifest=${body}`] = { threw, enabled };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// D2: the posture-unavailable branches (defects 4 and 5) via a config-module break.
// ---------------------------------------------------------------------------
const realConfig = { ...(await import("../../../../src/security/config")) };
const SENTINEL = "T35-CONFIG-BREAK-SENTINEL";

for (const mode of ["enforced", "ci", "advisory"] as const) {
  const root = await ws({ config: JSON.stringify({ schemaVersion: 1, mode }) });
  mock.module("../../../../src/security/config", () => ({
    ...realConfig,
    loadSecurityConfig: () => Promise.reject(new Error(SENTINEL)),
  }));
  try {
    const guard = await guardOutput({ cwd: root, content: `aws_key = ${AWS_KEY}`, target: "memory" });
    const flow = await securityFlowGate(root);
    const serialized = JSON.stringify({ guard, flow });
    check(`D2 ${mode}: guardOutput refuses the write when the posture cannot be read`,
      guard.allowed === false && guard.decision.gate === "incomplete", guard);
    check(`D2 ${mode}: securityFlowGate returns a BLOCKING entry, not null`,
      flow !== null && flow.status === "fail", flow);
    check(`D2 ${mode}: nothing leaks (sentinel, workspace root, planted key)`,
      !serialized.includes(SENTINEL) && !serialized.includes(root) && !serialized.includes(AWS_KEY),
      { reason: guard.reason, detail: flow?.detail });
  } finally {
    mock.module("../../../../src/security/config", () => ({ ...realConfig }));
    await rm(root, { recursive: true, force: true });
  }
}

// Restoration check: after the finally above, the real loader must be back.
{
  const root = await ws({ config: JSON.stringify({ schemaVersion: 1, mode: "advisory" }) });
  try {
    const mod = await import("../../../../src/security/config");
    const cfg = await mod.loadSecurityConfig(root);
    check("D2 restore: the real loadSecurityConfig is back after the finally",
      cfg.mode === "advisory", cfg.mode);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

process.stdout.write(`${JSON.stringify({ probe: "T35-D residual + posture", out, failures }, null, 2)}\n`);
process.stdout.write(failures === 0 ? "\nT35-D: ALL CHECKS OK\n" : `\nT35-D: ${failures} CHECK(S) FAILED\n`);
process.exit(0);
