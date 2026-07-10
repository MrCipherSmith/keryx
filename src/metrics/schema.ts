import type { JsonSchema } from "../standard/schemas";

export const EXECUTION_RUN_SCHEMA_VERSION = "0.1.0";

// Runtime copy of the published requirements contract. Keeping this small
// schema in source prevents the packaged CLI from depending on docs/.
export const EXECUTION_RUN_SCHEMA: JsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://keryx.dev/schemas/execution-metrics-run.schema.json",
  title: "Keryx Execution Metrics Run",
  type: "object",
  required: [
    "run_id",
    "schema_version",
    "run_mode",
    "skill",
    "started_at",
    "finished_at",
    "provenance",
    "metrics",
    "retries",
    "final_status",
    "artifact_paths",
  ],
  properties: {
    run_id: { type: "string", pattern: "^run-[A-Za-z0-9._-]+$" },
    schema_version: { type: "string" },
    run_mode: { type: "string", enum: ["user-direct", "orchestrator", "subagent"] },
    skill: { type: "string" },
    started_at: { type: "string", format: "date-time" },
    finished_at: { type: "string", format: "date-time" },
    parent_run_id: { type: ["string", "null"] },
    provenance: { type: "object" },
    metrics: { type: "object" },
    retries: { type: "array" },
    final_status: { type: "string", enum: ["done", "partial", "blocked"] },
    artifact_paths: { type: "array", items: { type: "string" } },
  },
};
