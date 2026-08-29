// ---------------------------------------------------------------------------
// Runtime source of truth for the FlowState / FlowTask JSON Schema.
//
// `flowStateSchema()` returns a JSON Schema (Draft-07 subset, understood by the
// deterministic validator in src/contracts/validator.ts) describing a flow.json
// document for BOTH schemaVersion 1 and 2. Every v2-only field is optional and
// additive (TM-01); no v1 field is removed or made required that a v1 file lacks.
//
// This schema is the single runtime source. The committed docpack copy at
// docs/requirements/keryx-metaproject-native/schemas/flow-state.schema.json is
// kept byte-consistent with it (asserted by src/flow/schema.test.ts). To emit
// or regenerate the docpack copy, use `keryx flow schema [--out <path>]`.
//
// Design notes:
//   - `additionalProperties: true` at the document and task level lets older or
//     newer flows carry fields this build does not model, without failing.
//   - The top-level `required` set is intentionally minimal — only fields present
//     in every on-disk flow.json (v1 and v2) are required, so validation never
//     rejects a legitimate historical flow.
//   - The FlowTask `required` set is the v1 core (id/title/kind/status); all v2
//     fields (dependsOn, attempts, disposition, acRefs, evidenceRefs, budget,
//     runLink) are optional.
// ---------------------------------------------------------------------------

const FLOW_STATUSES = [
  "initializing",
  "ready",
  "in-progress",
  "implemented",
  "completing",
  "done",
  "blocked",
] as const;

/**
 * Return the JSON Schema describing a flow.json document (FlowState + FlowTask)
 * for schemaVersion 1 and 2. A fresh object is returned on every call so callers
 * may mutate/serialize it freely without affecting the runtime source.
 */
export function flowStateSchema(): Record<string, unknown> {
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: "flow-state.schema.json",
    title: "FlowState",
    description:
      "Universal, runtime-agnostic contract for a keryx Task Manager flow (flow.json). Validates schemaVersion 1 and 2 — every v2 field is optional/additive (TM-01). Any runtime may READ and VALIDATE against this; WRITES go only through FlowService (D-02: flow.json is never hand-edited).",
    type: "object",
    additionalProperties: true,
    required: ["schemaVersion", "id", "slug", "title", "status", "createdAt", "updatedAt", "tasks"],
    properties: {
      schemaVersion: { type: "integer", enum: [1, 2] },
      id: { type: "string", description: "Zero-padded flow id, e.g. 007." },
      slug: { type: "string" },
      title: { type: "string" },
      status: {
        type: "string",
        enum: [...FLOW_STATUSES],
      },
      previousStatus: {
        type: "string",
        enum: [...FLOW_STATUSES],
        description: "Restored on unblock.",
      },
      createdAt: { type: "string", description: "ISO 8601." },
      updatedAt: { type: "string", description: "ISO 8601." },
      source: {
        type: "object",
        additionalProperties: false,
        required: ["type", "ref"],
        properties: {
          type: { type: "string", enum: ["github-issue", "description"] },
          ref: { type: ["string", "null"] },
        },
      },
      acChecksum: { type: ["string", "null"], description: "SHA-256 of the frozen acceptance criteria." },
      gates: {
        type: "object",
        additionalProperties: true,
        description:
          "Which completion gates this package opted into at creation. Absent on packages created before a gate existed, which is how a gate is added without retroactively invalidating history: an absent flag reports the gate as skipped rather than passed.",
        properties: {
          tasks: {
            type: "boolean",
            description: "Written by `flow init`. When true, `flow complete` fails while any task is non-terminal.",
          },
        },
      },
      acConfirmed: {
        type: "object",
        description: "Per-AC confirmation records keyed by AC id (e.g. AC1).",
        additionalProperties: {
          type: "object",
          additionalProperties: false,
          required: ["at"],
          properties: {
            at: { type: "string" },
            note: { type: "string" },
          },
        },
      },
      pr: {
        type: "object",
        additionalProperties: false,
        properties: { url: { type: ["string", "null"] } },
      },
      merged: {
        type: "object",
        additionalProperties: false,
        required: ["commit", "at"],
        properties: {
          commit: { type: "string" },
          ref: { type: "string" },
          at: { type: "string" },
        },
      },
      tasks: {
        type: "array",
        items: { $ref: "#/definitions/flowTask" },
      },
      history: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["at", "event"],
          properties: {
            at: { type: "string" },
            event: { type: "string" },
            detail: { type: "string" },
          },
        },
      },
    },
    definitions: {
      flowTask: {
        type: "object",
        description: "A flow task. v1 requires id/title/kind/status; all other fields are v2 additive (optional).",
        additionalProperties: true,
        required: ["id", "title", "kind", "status"],
        properties: {
          id: { type: "string", description: "Task id, e.g. T1." },
          title: { type: "string" },
          kind: { type: "string", enum: ["context", "implement", "test", "verify", "review", "docs"] },
          status: { type: "string", enum: ["todo", "in-progress", "done"] },
          dependsOn: {
            type: "array",
            items: { type: "string" },
            description: "v2: task ids this task depends on.",
          },
          attempts: {
            type: "object",
            additionalProperties: false,
            description: "v2: append-only attempt log (harness appends; Task Manager owns retry policy).",
            required: ["count", "log"],
            properties: {
              count: { type: "integer", minimum: 0 },
              log: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["at", "outcome"],
                  properties: {
                    at: { type: "string" },
                    outcome: { type: "string", enum: ["started", "paused", "completed", "failed", "blocked"] },
                    detail: { type: "string" },
                  },
                },
              },
            },
          },
          disposition: {
            type: "string",
            enum: ["completed", "blocked", "failed", "skipped"],
            description: "v2: terminal outcome when status is done (distinct from status).",
          },
          dispositionReason: {
            type: "string",
            description:
              "Why the task ended this way. Required in practice for `skipped`: the task gate treats an unreasoned skip as non-terminal, because a skip nobody has to justify is a one-flag bypass of the gate.",
          },
          acRefs: { type: "array", items: { type: "string" }, description: "v2: AC ids this task addresses." },
          evidenceRefs: { type: "array", items: { type: "string" }, description: "v2: artifact paths." },
          budget: {
            type: "object",
            additionalProperties: false,
            description: "v2: per-task budget (values OPEN in TM-01).",
            properties: {
              maxSeconds: { type: "number" },
              maxToolCalls: { type: "integer" },
              maxRetries: { type: "integer" },
              maxTokens: { type: "integer" },
            },
          },
          runLink: {
            type: "object",
            additionalProperties: false,
            description: "v2: harness run linkage. Set by the Task Manager only; harness is read-only here.",
            required: ["runId", "sessionId", "attempt"],
            properties: {
              runId: { type: "string" },
              sessionId: { type: "string" },
              attempt: { type: "integer", minimum: 1 },
              at: { type: "string" },
            },
          },
        },
      },
    },
  };
}
