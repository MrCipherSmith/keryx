import type {
  ExecutionRunRecord,
  MetricValue,
  Reliability,
  RetryType,
} from "./types";
export type { ExecutionRunRecord } from "./types";

const RELIABILITIES = new Set<Reliability>(["exact", "estimated", "unknown"]);
const RETRY_TYPES = new Set<RetryType>([
  "task",
  "keryx",
  "environment",
  "expected-tdd",
  "external",
  "unknown",
]);

export function stableJson(value: unknown): string {
  return `${JSON.stringify(sortValue(value), null, 2)}\n`;
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, sortValue(item)]),
    );
  }
  return value;
}

export function validateRunRecord(record: ExecutionRunRecord): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!/^run-[A-Za-z0-9._-]+$/.test(record.run_id)) errors.push("run_id");
  if (!record.schema_version) errors.push("schema_version");
  if (!["user-direct", "orchestrator", "subagent"].includes(record.run_mode)) errors.push("run_mode");
  if (record.run_mode === "subagent" && !record.parent_run_id) errors.push("parent_run_id");
  if (!record.skill) errors.push("skill");
  if (!isDateTime(record.started_at)) errors.push("started_at");
  if (!isDateTime(record.finished_at)) errors.push("finished_at");
  if (record.parent_run_id !== null && typeof record.parent_run_id !== "string") errors.push("parent_run_id");
  if (!record.provenance || typeof record.provenance !== "object") {
    errors.push("provenance");
  } else {
    for (const field of ["commit", "branch", "worktree"] as const) {
      if (record.provenance[field] !== null && typeof record.provenance[field] !== "string") {
        errors.push(`provenance.${field}`);
      }
    }
    if (!Array.isArray(record.provenance.sources)) errors.push("provenance.sources");
    for (const [index, source] of (record.provenance.sources ?? []).entries()) {
      if (!source.name || !RELIABILITIES.has(source.reliability)) errors.push(`provenance.sources[${index}]`);
      if (source.timestamp !== null && !isDateTime(source.timestamp)) errors.push(`provenance.sources[${index}].timestamp`);
      if (source.path !== null && typeof source.path !== "string") errors.push(`provenance.sources[${index}].path`);
    }
  }
  if (!record.metrics || typeof record.metrics !== "object" || Array.isArray(record.metrics)) errors.push("metrics");
  for (const [key, metric] of Object.entries(record.metrics ?? {})) {
    if (!RELIABILITIES.has(metric?.reliability)) {
      errors.push(`metrics.${key}.reliability`);
    } else if (!isMetric(metric)) {
      errors.push(`metrics.${key}`);
    }
  }
  if (!Array.isArray(record.retries)) errors.push("retries");
  for (const [index, retry] of (record.retries ?? []).entries()) {
    if (!RETRY_TYPES.has(retry.type) || !retry.reason || !RELIABILITIES.has(retry.reliability)) {
      errors.push(`retries[${index}]`);
    }
  }
  if (!["done", "partial", "blocked"].includes(record.final_status)) errors.push("final_status");
  if (!Array.isArray(record.artifact_paths) || record.artifact_paths.some((item) => typeof item !== "string")) errors.push("artifact_paths");
  return { valid: errors.length === 0, errors };
}

function isMetric(value: MetricValue): boolean {
  const valueType = typeof value?.value;
  return Boolean(value && (valueType === "number" || valueType === "string" || value.value === null)) &&
    RELIABILITIES.has(value.reliability) && typeof value.source === "string";
}

function isDateTime(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

export function renderRunMarkdown(record: ExecutionRunRecord): string {
  const provenance = record.provenance;
  const metrics = Object.entries(record.metrics)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, metric]) => `| ${key} | ${String(metric.value)} | ${metric.reliability} | ${metric.source} |`)
    .join("\n");
  const retries = record.retries.length > 0
    ? record.retries.map((retry) => `- [${retry.type}] ${retry.reason} (reliability: ${retry.reliability})`).join("\n")
    : "- none";
  const skipped = record.skipped_phases?.length
    ? record.skipped_phases.map((item) => `- ${item.phase}: ${item.reason}`).join("\n")
    : "- none";
  return `# Execution Metrics Run\n\n- run_id: ${record.run_id}\n- schema_version: ${record.schema_version}\n- run_mode: ${record.run_mode}\n- skill: ${record.skill}\n- started_at: ${record.started_at}\n- finished_at: ${record.finished_at}\n- final_status: ${record.final_status}\n- execution_profile: ${record.execution_profile ?? "full"}\n\n## Provenance\n\n- commit: ${provenance.commit ?? "unknown"}\n- branch: ${provenance.branch ?? "unknown"}\n- worktree: ${provenance.worktree ?? "unknown"}\n- parent_run_id: ${record.parent_run_id ?? "unknown"}\n\n## Metrics\n\n| Metric | Value | Reliability | Source |\n|---|---:|---|---|\n${metrics || "| none | n/a | unknown | unavailable |"}\n\n## Retries\n\n${retries}\n\n## Skipped phases\n\n${skipped}\n\n## Artifacts\n\n${record.artifact_paths.map((item) => `- ${item}`).join("\n") || "- none"}\n`;
}
