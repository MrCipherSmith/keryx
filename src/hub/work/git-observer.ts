import { fail } from "../domain";
import type { ResultSubject } from "./model";
import { workDigest } from "./domain";

import type { GitRepositoryConfig, GitCiRun, GitArtifactObservation, GitObservation } from "./git-observer-contract";
export type { GitRepositoryConfig, GitCiRun, GitArtifactObservation, GitObservation } from "./git-observer-contract";
export { gitObservationSchema } from "./git-observer-contract";
type Options = { id: string; actorId: string; generation: number; now?: () => number; fetch?: (request: Request) => Promise<Response>; timeoutMs?: number; maxResponseBytes?: number };
type GitArtifact = Extract<ResultSubject["artifacts"][number], { kind: "git" }>;
class ProviderUnavailable extends Error {}
class IdentityMismatch extends Error {}
const positive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const oid = (value: unknown): value is string => typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProviderUnavailable(); return value as Record<string, unknown>; }
function timestamp(value: unknown): string { if (typeof value !== "string" || value.length > 50 || !Number.isFinite(Date.parse(value))) throw new ProviderUnavailable(); return value; }
function numeric(value: unknown): number { if (!positive(value)) throw new ProviderUnavailable(); return value; }
const events = ["push", "pull_request", "workflow_dispatch", "workflow_call", "workflow_run", "schedule", "merge_group", "pull_request_target", "repository_dispatch"];
const statuses = ["completed", "in_progress", "queued", "requested", "waiting", "pending"];
const conclusions = ["success", "failure", "neutral", "cancelled", "skipped", "timed_out", "action_required", "stale", "startup_failure"];
/** Configuration is administrator-only. Response URLs are never followed. */
export function validateGitRepositoryConfig(config: GitRepositoryConfig): void {
    if (!config.projectId || !config.id || !["sha1", "sha256"].includes(config.objectFormat)) fail(503, "observer-configuration-invalid", "Git observer configuration is invalid");
    const github = config.github; if (!github) return;
    let url: URL; try { url = new URL(github.apiOrigin); } catch { fail(503, "observer-configuration-invalid", "Git observer configuration is invalid"); }
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (!(url.protocol === "https:" || url.protocol === "http:" && local) || url.username || url.password || url.search || url.hash || !["", "/", "/api/v3", "/api/v3/"].includes(url.pathname) || !/^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/.test(github.owner) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(github.repository) || !positive(github.repositoryId) || (github.trustedWorkflows?.length ?? 0) > 20 || github.requireCi && !github.trustedWorkflows?.length || github.maxAgeSeconds !== undefined && (!Number.isSafeInteger(github.maxAgeSeconds) || github.maxAgeSeconds < 1 || github.maxAgeSeconds > 86400)) fail(503, "observer-configuration-invalid", "Git observer configuration is invalid");
    const workflows = github.trustedWorkflows ?? [];
    if (new Set(workflows.map(workflow => workflow.workflowId)).size !== workflows.length || workflows.some(workflow => !positive(workflow.workflowId) || !/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(workflow.path) || workflow.ref !== undefined && !/^[A-Za-z0-9][A-Za-z0-9/._-]{0,199}$/.test(workflow.ref) || !workflow.events.length || workflow.events.length > events.length || workflow.events.some(event => !events.includes(event)))) fail(503, "observer-configuration-invalid", "Git observer configuration is invalid");
    if (github.token !== undefined && (!github.token || [...github.token].some(character => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127))) fail(503, "observer-configuration-invalid", "Git observer configuration is invalid");
}
/** Strict administrator config parsing; credentials are never copied into observations. */
export function parseGitRepositoryConfig(value: unknown): GitRepositoryConfig {
    const invalid = (): never => fail(503, "observer-configuration-invalid", "Git observer configuration is invalid");
    if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
    const config = value as Record<string, unknown>;
    if (Object.keys(config).some(key => !["projectId", "id", "objectFormat", "github"].includes(key)) || typeof config.projectId !== "string" || typeof config.id !== "string" || config.objectFormat !== "sha1" && config.objectFormat !== "sha256") invalid();
    if (config.github !== undefined) {
        if (!config.github || typeof config.github !== "object" || Array.isArray(config.github)) invalid();
        const github = config.github as Record<string, unknown>;
        if (Object.keys(github).some(key => !["apiOrigin", "owner", "repository", "repositoryId", "token", "trustedWorkflows", "requireCi", "maxAgeSeconds"].includes(key)) || ["apiOrigin", "owner", "repository"].some(key => typeof github[key] !== "string") || !positive(github.repositoryId) || github.token !== undefined && typeof github.token !== "string" || github.requireCi !== undefined && typeof github.requireCi !== "boolean" || github.maxAgeSeconds !== undefined && typeof github.maxAgeSeconds !== "number") invalid();
        if (github.trustedWorkflows !== undefined && (!Array.isArray(github.trustedWorkflows) || github.trustedWorkflows.some(item => {
            if (!item || typeof item !== "object" || Array.isArray(item)) return true;
            const workflow = item as Record<string, unknown>;
            return Object.keys(workflow).some(key => !["workflowId", "path", "ref", "events"].includes(key)) || !positive(workflow.workflowId) || typeof workflow.path !== "string" || workflow.ref !== undefined && typeof workflow.ref !== "string" || !Array.isArray(workflow.events) || workflow.events.some(event => typeof event !== "string");
        }))) invalid();
    }
    const parsed = value as GitRepositoryConfig; validateGitRepositoryConfig(parsed); return parsed;
}
function repository(configs: readonly GitRepositoryConfig[], projectId: string, repositoryId: string): GitRepositoryConfig | undefined { return configs.find(config => config.projectId === projectId && config.id === repositoryId); }
function policyDigest(config: GitRepositoryConfig): string {
    const { token: _token, ...policy } = config.github!;
    return workDigest({ projectId: config.projectId, localRepositoryId: config.id, objectFormat: config.objectFormat, ...policy });
}

/** Fetches only constructed GET endpoints. One abort deadline covers fetches and body streams. */
export async function observeGitSubject(subject: ResultSubject, configs: readonly GitRepositoryConfig[], options: Options): Promise<GitObservation> {
    const now = options.now ?? Date.now, fetcher = options.fetch ?? globalThis.fetch;
    const signal = AbortSignal.timeout(options.timeoutMs ?? 15000), maxResponseBytes = options.maxResponseBytes ?? 1048576;
    let totalBytes = 0, requests = 0;
    async function get(config: GitRepositoryConfig, suffix: string): Promise<unknown> {
        const github = config.github!;
        if (signal.aborted || ++requests > 500) throw new ProviderUnavailable();
        const base = github.apiOrigin.replace(/\/$/, ""), url = `${base}/repos/${encodeURIComponent(github.owner)}/${encodeURIComponent(github.repository)}${suffix}`;
        const response = await fetcher(new Request(url, { method: "GET", redirect: "error", signal, headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...(github.token ? { Authorization: `Bearer ${github.token}` } : {}) } }));
        if (response.status !== 200 || !response.body) { await response.body?.cancel(); throw new ProviderUnavailable(); }
        const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
        try {
            while (true) {
                const chunk = await reader.read(); if (chunk.done) break;
                bytes += chunk.value.byteLength; totalBytes += chunk.value.byteLength;
                if (bytes > maxResponseBytes || totalBytes > 8 * 1048576) { await reader.cancel(); throw new ProviderUnavailable(); }
                chunks.push(chunk.value);
            }
        } finally { reader.releaseLock(); }
        const raw = Buffer.concat(chunks).toString("utf8");
        const parsed: unknown = JSON.parse(raw);
        if (github.token) JSON.stringify(parsed, (_key, value: unknown) => { if (typeof value === "string" && value.includes(github.token!)) throw new ProviderUnavailable(); return value; });
        return parsed;
    }
    async function pull(config: GitRepositoryConfig, number: number): Promise<NonNullable<GitArtifactObservation["pullRequest"]>> {
        const data = record(await get(config, `/pulls/${number}`)), base = record(record(data.base).repo), head = record(data.head), headRepo = record(head.repo);
        if (data.number !== number || base.id !== config.github!.repositoryId || !oid(head.sha)) throw new IdentityMismatch();
        if (data.state !== "open" && data.state !== "closed") throw new ProviderUnavailable();
        return { number, headOid: head.sha, baseRepositoryId: numeric(base.id), headRepositoryId: numeric(headRepo.id), state: data.state, updatedAt: timestamp(data.updated_at) };
    }
    async function ci(config: GitRepositoryConfig, artifact: GitArtifact): Promise<GitArtifactObservation["ci"]> {
        const github = config.github!;
        if (!github.trustedWorkflows?.length) return { availability: "not-configured", runs: [] };
        try {
            const data = record(await get(config, `/actions/runs?head_sha=${artifact.commitOid}&per_page=100&page=1`));
            if (!Number.isSafeInteger(data.total_count) || Number(data.total_count) < 0 || Number(data.total_count) > 100 || !Array.isArray(data.workflow_runs) || data.workflow_runs.length > 100 || data.workflow_runs.length !== data.total_count) throw new ProviderUnavailable();
            const runs: GitCiRun[] = data.workflow_runs.map((value: unknown) => {
                const run = record(value), runRepo = record(run.repository), headRepo = record(run.head_repository);
                if (!oid(run.head_sha) || typeof run.path !== "string" || run.path.length > 300 || typeof run.event !== "string" || !events.includes(run.event) || typeof run.status !== "string" || !statuses.includes(run.status) || run.conclusion !== null && (typeof run.conclusion !== "string" || !conclusions.includes(run.conclusion))) throw new ProviderUnavailable();
                const parts = run.path.split("@"), workflowPath = parts[0]!, workflowRef = parts.length === 1 ? null : parts.length === 2 ? parts[1]! : "";
                if (workflowRef !== null && !/^[A-Za-z0-9][A-Za-z0-9/._-]{0,199}$/.test(workflowRef)) throw new ProviderUnavailable();
                const workflow = github.trustedWorkflows!.find(workflow => workflow.workflowId === run.workflow_id && workflow.path === workflowPath && (workflow.ref ?? null) === workflowRef && workflow.events.includes(String(run.event)));
                return { runId: numeric(run.id), runNumber: numeric(run.run_number), runAttempt: numeric(run.run_attempt), workflowId: numeric(run.workflow_id), workflowPath, workflowRef, headOid: run.head_sha, repositoryProviderId: numeric(runRepo.id), headRepositoryProviderId: numeric(headRepo.id), event: run.event, status: run.status, conclusion: run.conclusion, updatedAt: timestamp(run.updated_at), trusted: !!workflow && run.head_sha === artifact.commitOid && runRepo.id === github.repositoryId && headRepo.id === github.repositoryId };
            });
            return { availability: "available", runs: runs.sort((a, b) => a.runId - b.runId || a.runAttempt - b.runAttempt) };
        } catch { return { availability: "unavailable", runs: [] }; }
    }
    const artifacts: GitArtifactObservation[] = [];
    for (const artifact of subject.artifacts) {
        if (artifact.kind !== "git") continue;
        const config = repository(configs, subject.projectId, artifact.repositoryId);
        const unavailable: GitArtifactObservation = { repositoryId: artifact.repositoryId, commitOid: artifact.commitOid, treeOid: artifact.treeOid, policyDigest: config?.github ? policyDigest(config) : null, availability: "not-configured", reasonCode: "not-configured", pullRequest: null, ci: { availability: "not-configured", runs: [] } };
        if (!config?.github) { artifacts.push(unavailable); continue; }
        validateGitRepositoryConfig(config);
        try {
            if (!oid(artifact.commitOid) || artifact.commitOid.length !== (config.objectFormat === "sha1" ? 40 : 64)) throw new IdentityMismatch();
            const repo = record(await get(config, ""));
            if (repo.id !== config.github.repositoryId || typeof repo.full_name !== "string" || repo.full_name.toLowerCase() !== `${config.github.owner}/${config.github.repository}`.toLowerCase()) throw new IdentityMismatch();
            const commit = record(await get(config, `/git/commits/${artifact.commitOid}`)), tree = record(commit.tree);
            if (commit.sha !== artifact.commitOid || !oid(tree.sha) || artifact.treeOid !== null && tree.sha !== artifact.treeOid) throw new IdentityMismatch();
            const firstPr = artifact.pullRequest ? await pull(config, artifact.pullRequest.number) : null;
            const check = await ci(config, artifact);
            // The second authoritative read closes the window while CI was fetched.
            const currentPr = firstPr ? await pull(config, firstPr.number) : null;
            artifacts.push({ ...unavailable, treeOid: tree.sha, availability: "available", reasonCode: "observed", pullRequest: currentPr, ci: check });
        } catch (error) { artifacts.push({ ...unavailable, availability: error instanceof IdentityMismatch ? "identity-mismatch" : "unavailable", reasonCode: error instanceof IdentityMismatch ? "identity-mismatch" : "provider-unavailable" }); }
    }
    const value = { id: options.id, projectId: subject.projectId, subjectId: subject.id, subjectDigest: subject.contentDigest, createdBy: options.actorId, observedAt: new Date(now()).toISOString(), generation: options.generation, artifacts };
    const secrets = configs.flatMap(config => config.github?.token ? [config.github.token] : []);
    JSON.stringify(value, (_key, item: unknown) => { if (typeof item === "string" && secrets.some(secret => item.includes(secret))) fail(400, "credential-material", "Git observation contains protected credential material"); return item; });
    return { ...value, contentDigest: workDigest(value) };
}

/** Observations constrain live-PR acceptance. They never create Evidence or Decisions. */
export function assertGitSubjectAcceptable(projectId: string, subject: ResultSubject, observations: readonly GitObservation[], configs: readonly GitRepositoryConfig[], now = Date.now()): void {
    if (subject.projectId !== projectId) fail(404, "not-found", "Subject not found");
    const latest = observations.filter(observation => observation.projectId === projectId && observation.subjectId === subject.id && observation.subjectDigest === subject.contentDigest).sort((a, b) => b.generation - a.generation)[0];
    for (const artifact of subject.artifacts) {
        if (artifact.kind !== "git" || !artifact.pullRequest) continue;
        const config = repository(configs, projectId, artifact.repositoryId);
        if (!config?.github || !latest) fail(409, "observer-unavailable", "Current PR acceptance requires a configured Git observation");
        const age = now - Date.parse(latest.observedAt);
        if (!Number.isFinite(age) || age < 0 || age > (config.github.maxAgeSeconds ?? 300) * 1000) fail(409, "observation-stale", "Refresh Git observation before current PR acceptance");
        const observed = latest.artifacts.find(item => item.repositoryId === artifact.repositoryId && item.commitOid === artifact.commitOid && item.pullRequest?.number === artifact.pullRequest!.number);
        if (!observed || observed.availability !== "available") fail(503, "observation-unavailable", "Git subject observation is unavailable");
        if (observed.policyDigest !== policyDigest(config)) fail(409, "observation-policy-changed", "Refresh Git observation after administrator policy changes");
        if (artifact.treeOid !== null && observed.treeOid !== artifact.treeOid) fail(409, "subject-drift", "Observed tree differs from the immutable reviewed tree");
        if (observed.pullRequest!.headOid !== artifact.commitOid) fail(409, "subject-drift", "Current PR head differs from the immutable reviewed commit");
        if (config.github.requireCi) {
            if (observed.ci.availability !== "available") fail(503, "observation-unavailable", "CI observation is unavailable");
            for (const workflow of config.github.trustedWorkflows ?? []) {
                const run = observed.ci.runs.filter(run => run.trusted && run.workflowId === workflow.workflowId && run.workflowPath === workflow.path && run.workflowRef === (workflow.ref ?? null) && workflow.events.includes(run.event) && run.headOid === artifact.commitOid && run.repositoryProviderId === config.github!.repositoryId && run.headRepositoryProviderId === config.github!.repositoryId).sort((a, b) => b.runNumber - a.runNumber || b.runAttempt - a.runAttempt || b.runId - a.runId)[0];
                if (!run || run.status !== "completed" || run.conclusion !== "success") fail(409, "ci-not-passing", "Configured exact-subject CI is not passing");
            }
        }
    }
}

