// Flow 291 — assembling, rendering and persisting the governance report
// (AC1-AC9 combined). Read-only over recorded artifacts (AC5); the only
// files this module writes are its own report artifacts (AC6).

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../lib/fs";
import { readJsonObjectFile } from "../lib/json";
import { listProjects } from "../lib/project-registry";
import { collectProjectGovernance } from "./aggregate";
import type { FlowDispatch, GovernanceFilters, GovernanceReport, GovernanceReportRead, ProjectGovernance } from "./types";

export const GOVERNANCE_SCHEMA_VERSION = 1 as const;

export function governanceDataRoot(cwd: string): string {
  return path.join(cwd, ".metaproject", "data", "governance");
}

function artifactPaths(cwd: string): { markdown: string; json: string } {
  const artifacts = path.join(governanceDataRoot(cwd), "artifacts");
  return { markdown: path.join(artifacts, "latest.md"), json: path.join(artifacts, "latest.json") };
}

export type BuildGovernanceReportOptions = {
  cwd: string;
  filters: GovernanceFilters;
  allProjects: boolean;
  now: () => Date;
  /** Injectable for tests: overrides where the user-global registry is read from. */
  registryDir?: string | undefined;
};

/**
 * AC8: the current project, plus — only with `--all-projects` — every other
 * project in the user-global registry. A registered project whose path is
 * missing or unreadable is included with `state: "skipped"` and a reason,
 * never dropped and never allowed to fail the whole report (the same
 * warning-collection discipline `listProjects()` itself applies).
 */
export async function buildGovernanceReport(options: BuildGovernanceReportOptions): Promise<GovernanceReport> {
  const { cwd, filters, allProjects, now } = options;
  const roots: Array<{ root: string; displayName: string | undefined }> = [{ root: cwd, displayName: undefined }];

  if (allProjects) {
    const warnings: string[] = [];
    const registered = listProjects(options.registryDir, (message) => warnings.push(message));
    const seen = new Set([path.resolve(cwd)]);
    for (const entry of registered) {
      const resolved = path.resolve(entry.path);
      if (seen.has(resolved)) {
        continue;
      }
      seen.add(resolved);
      roots.push({ root: entry.path, displayName: entry.displayName });
    }
  }

  const projects: ProjectGovernance[] = [];
  for (const { root, displayName } of roots) {
    try {
      if (!(await pathExists(root))) {
        projects.push({
          root,
          displayName,
          state: "skipped",
          reason: "project path does not exist on this machine",
          flows: [],
          triggerSpend: { state: "unreadable", reason: "project path does not exist" },
          policyDecisions: { recorded: false, reason: "project path does not exist; nothing could be read" },
        });
        continue;
      }
      projects.push(await collectProjectGovernance(root, filters, displayName));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      projects.push({
        root,
        displayName,
        state: "skipped",
        reason,
        flows: [],
        triggerSpend: { state: "unreadable", reason },
        policyDecisions: { recorded: false, reason: "project could not be read" },
      });
    }
  }

  return {
    schemaVersion: GOVERNANCE_SCHEMA_VERSION,
    generatedAt: now().toISOString(),
    filters,
    allProjects,
    projects,
  };
}

function usd(value: number | undefined): string {
  return value === undefined ? "not recorded" : `$${value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`;
}

function tokens(value: number | undefined): string {
  return value === undefined ? "not recorded" : value.toLocaleString("en-US");
}

function identityLine(identity: { value: string | null; basis: string; source: string } | undefined): string {
  if (identity === undefined) {
    return "not recorded";
  }
  return `${identity.value ?? "unknown"} [${identity.basis}]`;
}

/** Markdown rendering — the human half of the artifact pair (AC6). */
export function renderGovernanceMarkdown(report: GovernanceReport): string {
  const lines: string[] = [
    "# Governance report",
    "",
    `generated_at: ${report.generatedAt}`,
    `filters: ${
      Object.entries(report.filters)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => `${key}=${value}`)
        .join(", ") || "none"
    }`,
    `all_projects: ${report.allProjects}`,
    "",
  ];

  for (const project of report.projects) {
    lines.push(`## Project: ${project.displayName ?? project.root}`);
    lines.push("");
    lines.push(`path: ${project.root}`);
    if (project.state === "skipped") {
      lines.push(`state: skipped (${project.reason ?? "unknown reason"})`);
      lines.push("");
      continue;
    }

    lines.push(
      `trigger spend (project-wide, never flow-attributed): ${renderTriggerSpendLine(project.triggerSpend)}`,
    );
    lines.push(`policy decisions: ${project.policyDecisions.recorded ? "recorded" : "not recorded"} (${project.policyDecisions.reason})`);
    lines.push("");

    if (project.flows.length === 0) {
      lines.push("_No flows matched._");
      lines.push("");
      continue;
    }

    for (const flow of project.flows) {
      lines.push(`### ${flow.id} — ${flow.title}`);
      lines.push("");
      lines.push(`status: ${flow.status}`);
      lines.push(`owner: ${identityLine(flow.owner)}`);
      lines.push(
        `review spend: spent=${usd(flow.spend.spentUsd)} (rounds_with_spent=${flow.spend.roundsWithSpentUsd}), ` +
          `input_tokens=${tokens(flow.spend.inputTokens)} (rounds=${flow.spend.roundsWithInputTokens}), ` +
          `output_tokens=${tokens(flow.spend.outputTokens)} (rounds=${flow.spend.roundsWithOutputTokens}), ` +
          `rounds_with_cost=${flow.spend.roundsWithCost}/${flow.spend.roundsTotal}`,
      );

      if (!flow.confirmations.recorded) {
        lines.push("confirmations: not recorded (predates signing)");
      } else {
        if (flow.confirmations.criteria.length === 0) {
          lines.push("confirmations: none yet");
        } else {
          for (const criterion of flow.confirmations.criteria) {
            lines.push(`  ${criterion.criterion}: confirmed_at=${criterion.confirmedAt} by ${identityLine(criterion.identity)}`);
          }
        }
        lines.push(
          `completion signature: ${
            flow.confirmations.completionSignature === undefined
              ? "not recorded"
              : `${identityLine(flow.confirmations.completionSignature.identity)} at ${flow.confirmations.completionSignature.at}`
          }`,
        );
      }

      if (!flow.gateOutcomes.recorded) {
        lines.push("gate outcomes: not recorded");
      } else {
        lines.push(`gate outcomes: ${flow.gateOutcomes.attempts.length} attempt(s) recorded`);
        flow.gateOutcomes.attempts.forEach((attempt, index) => {
          lines.push(
            `  attempt ${index + 1} (${attempt.at}): ${attempt.passed ? "passed" : "failed"} — ` +
              attempt.gates.map((gate) => `${gate.name}=${gate.status}`).join(", "),
          );
        });
      }
      lines.push(...renderFlowDispatchLines(flow.dispatch));
      lines.push("");
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * AC1, AC2: this flow's unattended trigger-dispatch runs — spend, outcome and
 * denials, joined from the same ledger `renderTriggerSpendLine` reads at the
 * project level. An open reservation is its own line, "reserved, not spent"
 * — never folded into `spent=`.
 */
function renderFlowDispatchLines(dispatch: FlowDispatch): string[] {
  if (dispatch.state === "absent") {
    return ["dispatch runs: none (no trigger has ever fired for this flow)"];
  }
  if (dispatch.state === "unreadable") {
    return [`dispatch runs: not recorded (${dispatch.reason})`];
  }
  const { spend, runs, openReservations } = dispatch;
  if (runs.length === 0 && openReservations.length === 0) {
    return ["dispatch runs: none"];
  }
  const lines = [
    `dispatch runs: spent=${usd(spend.spentUsd)} across ${spend.runsWithCostRecorded} run(s) with recorded cost; ` +
      `${spend.runsWithCostNotRecorded} run(s) with cost not recorded (never counted as $0); ` +
      `${openReservations.length} open reservation(s) totaling ${usd(spend.openReservedUsd)} (reserved, not spent); ` +
      `${spend.runsTotal} run(s) total`,
  ];
  for (const run of runs) {
    lines.push(
      `  ${run.trigger} run ${run.runId}${run.task !== undefined ? ` (task ${run.task})` : ""} at ${run.at}: ` +
        `outcome=${run.outcome} cost=${run.cost.recorded ? usd(run.cost.usd) : "not recorded"}` +
        (run.denials.length > 0 ? `, ${run.denials.length} denial(s)` : ""),
    );
    for (const denial of run.denials) {
      lines.push(`    denied: ${denial.tool} — ${denial.reason}`);
    }
  }
  for (const reservation of openReservations) {
    lines.push(
      `  ${reservation.trigger} run ${reservation.runId} at ${reservation.at}: ${usd(reservation.usd)} reserved, not spent (no closing record yet)`,
    );
  }
  return lines;
}

/** Same `usd()` formatter review spend uses — one place a figure becomes a string, not two. */
function renderTriggerSpendLine(spend: ProjectGovernance["triggerSpend"]): string {
  if (spend.state === "absent") {
    return `${usd(0)} (no trigger has ever run)`;
  }
  if (spend.state === "unreadable") {
    return `not recorded (${spend.reason})`;
  }
  return (
    `${usd(spend.spentUsd)} across ${spend.runsWithCostRecorded} run(s) with recorded cost; ` +
    `${spend.runsWithCostNotRecorded} run(s) fired with cost not recorded (never counted as $0); ` +
    `${spend.runsTotal} run(s) total`
  );
}

/** AC6: write the sibling markdown+json artifact pair, following `keryx health run`'s convention. */
export async function writeGovernanceArtifacts(
  cwd: string,
  report: GovernanceReport,
): Promise<{ markdownPath: string; jsonPath: string }> {
  const { markdown, json } = artifactPaths(cwd);
  await mkdir(path.dirname(markdown), { recursive: true });
  await writeFile(markdown, renderGovernanceMarkdown(report), "utf8");
  await writeFile(json, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return { markdownPath: markdown, jsonPath: json };
}

/**
 * Shape-guarded reader — mirrors `src/health/service.ts`'s `readLatest` /
 * `hasGateShape`: a missing or malformed stored report is "no report yet",
 * never a crash and never silently treated as an empty-but-valid one.
 */
export async function readLatestGovernanceReport(cwd: string): Promise<GovernanceReportRead> {
  const { json } = artifactPaths(cwd);
  if (!(await pathExists(json))) {
    return { state: "absent" };
  }
  const read = await readJsonObjectFile(json);
  if (read.state !== "object") {
    return { state: "malformed", reason: `${json} did not contain a JSON object` };
  }
  const value = read.value;
  if (
    typeof value["schemaVersion"] !== "number" ||
    typeof value["generatedAt"] !== "string" ||
    !Array.isArray(value["projects"])
  ) {
    return { state: "malformed", reason: `${json} is missing schemaVersion/generatedAt/projects` };
  }
  return { state: "present", report: value as unknown as GovernanceReport };
}
