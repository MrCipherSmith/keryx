import path from "node:path";
import { readFile } from "node:fs/promises";
import { pathExists } from "../lib/fs";
import { loadSecurityConfig } from "./config";
import { runDetectors } from "./detect";
import { getHmacKey, hmacHash } from "./redact";
import {
  computeGate,
  resolveDecision,
  strongestAction,
  type BuildFindingOptions,
} from "./resolve";
import {
  buildReport,
  writeSecurityArtifacts,
  artifactsDir,
} from "./report";
import { appendIncidents } from "./incidents";
import {
  currentState,
  evaluateSelfProtection,
  readState,
  writeState,
} from "./self-protect";
import type {
  SecurityCheck,
  SecurityConfig,
  SecurityDecision,
  SecurityFinding,
  SecurityReport,
  SecurityService,
  SecuritySource,
} from "./types";

// Result of a full analysis: the decision plus the surfaced self-protection
// warnings (§14) that the CLI prints. This is the richer, non-contract entry
// point; `createSecurityService().check` is the thin contract wrapper over it.
export type AnalysisResult = {
  decision: SecurityDecision;
  warnings: string[];
  config: SecurityConfig;
};

async function hashFnFor(cwd: string): Promise<(value: string) => string> {
  const key = await getHmacKey(cwd);
  return (value: string) => hmacHash(value, key);
}

// Core analysis: run detectors, resolve the decision, and apply self-protection
// (checksum/downgrade/disabled-policy). Persists incidents + state. Findings from
// self-protection are folded into the decision so they gate.
export async function analyze(
  cwd: string,
  input: SecurityCheck,
): Promise<AnalysisResult> {
  const config = await loadSecurityConfig(cwd);
  const matches = runDetectors(input.content, config);
  const hashFn = await hashFnFor(cwd);

  const buildOpts: BuildFindingOptions = {
    source: input.source,
    content: input.content,
    hashFn,
  };
  if (input.target !== undefined) {
    buildOpts.target = input.target;
  }
  if (input.path !== undefined) {
    buildOpts.path = input.path;
  }

  const decision = resolveDecision(config, { ...buildOpts, matches });

  const previous = await readState(cwd);
  const selfProtection = evaluateSelfProtection(config, previous);
  if (selfProtection.incidents.length > 0) {
    await appendIncidents(cwd, selfProtection.incidents);
  }
  await writeState(cwd, currentState(config));

  if (selfProtection.findings.length > 0) {
    decision.findings.push(...selfProtection.findings);
    decision.gate = computeGate(decision.findings, config).gate;
    decision.action = strongestAction(decision.findings.map((f) => f.action));
  }

  return { decision, warnings: selfProtection.warnings, config };
}

// Scan a file/content, build a report, and write committable artifacts.
export async function runScan(
  cwd: string,
  input: SecurityCheck,
): Promise<{
  decision: SecurityDecision;
  report: SecurityReport;
  warnings: string[];
  markdownPath: string;
  jsonPath: string;
}> {
  const { decision, warnings, config } = await analyze(cwd, input);
  const report = buildReport(decision.findings, config, decision.gate);
  const paths = await writeSecurityArtifacts(cwd, report, config);
  return { decision, report, warnings, ...paths };
}

async function readLatestReport(cwd: string): Promise<SecurityReport | null> {
  const file = path.join(artifactsDir(cwd), "latest.json");
  if (!(await pathExists(file))) {
    return null;
  }
  try {
    return JSON.parse(await readFile(file, "utf8")) as SecurityReport;
  } catch {
    return null;
  }
}

// Build a report from the latest scan artifact, or an empty report when none
// exists. `report` never re-scans the tree; it aggregates the last scan.
export async function runReport(input: {
  cwd: string;
  since?: string;
}): Promise<SecurityReport> {
  const config = await loadSecurityConfig(input.cwd);
  const latest = await readLatestReport(input.cwd);
  if (latest) {
    return latest;
  }
  return buildReport([], config, "pass");
}

export async function runGate(input: {
  cwd: string;
}): Promise<{ status: "pass" | "fail"; reasons: string[] }> {
  const latest = await readLatestReport(input.cwd);
  if (!latest) {
    return {
      status: "pass",
      reasons: ["no security report; run `gd-metapro security scan` first"],
    };
  }
  if (latest.gate === "fail") {
    return {
      status: "fail",
      reasons: [`security gate: ${latest.gate}`],
    };
  }
  return { status: "pass", reasons: [`security gate: ${latest.gate}`] };
}

// The in-process service contract (specification.md §6a). `check` never throws
// in advisory mode; the caller may proceed after logging. In enforced/ci mode a
// fail/needs-approval decision must stop the controlled write.
export function createSecurityService(cwd: string = process.cwd()): SecurityService {
  return {
    async check(input: SecurityCheck): Promise<SecurityDecision> {
      try {
        const { decision } = await analyze(cwd, input);
        return decision;
      } catch {
        // Advisory-safe: an analysis error must not break the caller.
        return { gate: "pass", action: "allow", findings: [] };
      }
    },

    async redact(
      content: string,
      opts?: { source?: SecuritySource },
    ): Promise<{ redacted: string; findings: SecurityFinding[] }> {
      const config = await loadSecurityConfig(cwd);
      const matches = runDetectors(content, config);
      const hashFn = await hashFnFor(cwd);
      const source: SecuritySource = opts?.source ?? "generated";
      const decision = resolveDecision(config, {
        matches,
        source,
        content,
        hashFn,
      });
      return {
        redacted: decision.redacted ?? content,
        findings: decision.findings,
      };
    },

    report: (input) => runReport(input),

    gate: (input) => runGate(input),
  };
}
