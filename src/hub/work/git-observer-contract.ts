import type { WorkSchema } from "./openapi";

export type GitRepositoryConfig = {
    projectId: string; id: string; objectFormat: "sha1" | "sha256";
    github?: { apiOrigin: string; owner: string; repository: string; repositoryId: number; token?: string; trustedWorkflows?: { workflowId: number; path: string; ref?: string; events: string[] }[]; requireCi?: boolean; maxAgeSeconds?: number };
};
export type GitCiRun = { runId: number; runNumber: number; runAttempt: number; workflowId: number; workflowPath: string; workflowRef: string | null; headOid: string; repositoryProviderId: number; headRepositoryProviderId: number; event: string; status: string; conclusion: string | null; updatedAt: string; trusted: boolean };
export type GitArtifactObservation = {
    repositoryId: string; commitOid: string; treeOid: string | null; policyDigest: string | null;
    availability: "available" | "unavailable" | "identity-mismatch" | "not-configured";
    reasonCode: "observed" | "not-configured" | "provider-unavailable" | "identity-mismatch";
    pullRequest: { number: number; headOid: string; baseRepositoryId: number; headRepositoryId: number; state: "open" | "closed"; updatedAt: string } | null;
    ci: { availability: "available" | "unavailable" | "not-configured"; runs: GitCiRun[] };
};
export type GitObservation = { id: string; projectId: string; subjectId: string; subjectDigest: string; createdBy: string; observedAt: string; generation: number; artifacts: GitArtifactObservation[]; contentDigest: string };
const events = ["push", "pull_request", "workflow_dispatch", "workflow_call", "workflow_run", "schedule", "merge_group", "pull_request_target", "repository_dispatch"];
const statuses = ["completed", "in_progress", "queued", "requested", "waiting", "pending"];
const conclusions = ["success", "failure", "neutral", "cancelled", "skipped", "timed_out", "action_required", "stale", "startup_failure"];
const string: WorkSchema = { type: "string", minLength: 1, maxLength: 200 };
const integer: WorkSchema = { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const object = (properties: Record<string, WorkSchema>): WorkSchema => ({ type: "object", additionalProperties: false, properties, required: Object.keys(properties) });
const oidSchema: WorkSchema = { type: "string", pattern: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$" };
const ciRun = object({ runId: integer, runNumber: integer, runAttempt: integer, workflowId: integer, workflowPath: { type: "string", minLength: 1, maxLength: 300 }, workflowRef: { anyOf: [{ type: "string", minLength: 1, maxLength: 200 }, { type: "null" }] }, headOid: oidSchema, repositoryProviderId: integer, headRepositoryProviderId: integer, event: { enum: events }, status: { enum: statuses }, conclusion: { anyOf: [{ enum: conclusions }, { type: "null" }] }, updatedAt: { type: "string", minLength: 1, maxLength: 50 }, trusted: { type: "boolean" } });
export const gitObservationSchema: WorkSchema = object({ id: string, projectId: string, subjectId: string, subjectDigest: { type: "string", pattern: "^[a-f0-9]{64}$" }, createdBy: string, observedAt: { type: "string", minLength: 1, maxLength: 50 }, generation: integer, artifacts: { type: "array", maxItems: 100, items: object({ repositoryId: string, commitOid: oidSchema, treeOid: { anyOf: [oidSchema, { type: "null" }] }, policyDigest: { anyOf: [{ type: "string", pattern: "^[a-f0-9]{64}$" }, { type: "null" }] }, availability: { enum: ["available", "unavailable", "identity-mismatch", "not-configured"] }, reasonCode: { enum: ["observed", "not-configured", "provider-unavailable", "identity-mismatch"] }, pullRequest: { anyOf: [object({ number: integer, headOid: oidSchema, baseRepositoryId: integer, headRepositoryId: integer, state: { enum: ["open", "closed"] }, updatedAt: { type: "string", minLength: 1, maxLength: 50 } }), { type: "null" }] }, ci: object({ availability: { enum: ["available", "unavailable", "not-configured"] }, runs: { type: "array", maxItems: 100, items: ciRun } }) }) }, contentDigest: { type: "string", pattern: "^[a-f0-9]{64}$" } });
