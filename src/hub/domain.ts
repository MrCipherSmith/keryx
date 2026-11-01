import { createHash, randomUUID } from "node:crypto";
import { canTransition } from "../flow/machine";
import type { CodeRevision, GitDeliveryAdapter, GitDeliveryRequest, GitDeliveryResult, HubConfig, HubDocument, HubFlow, Principal, Project, Proposal, Receipt, RevisionChange, RevisionFile } from "./contracts";
import type { HubState } from "./store";
export class HubFailure extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export function fail(status: number, code: string, message: string): never { throw new HubFailure(status, code, message); }
export function sha256(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(400, "invalid-body", "Expected a JSON object");
  return value as Record<string, unknown>;
}
export function text(value: unknown, name: string, max = 4096): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > max) fail(400, "invalid-field", `Invalid ${name}`);
  return value;
}
function documentContent(value: unknown): string {
  if (typeof value !== "string" || Buffer.byteLength(value) > 1024 * 1024) fail(400, "invalid-field", "Invalid document content");
  return value;
}
function integer(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) fail(400, "invalid-field", `Invalid ${name}`);
  return value;
}
function list(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) fail(400, "invalid-list", "Invalid or oversized list");
  return value;
}
function version(expected: unknown, actual: number) { if (integer(expected, "expectedVersion") !== actual) fail(409, "version-conflict", "Version changed; reload before retrying"); }
function human(actor: Principal) { if (actor.kind !== "human") fail(403, "human-required", "This action requires a human"); }
function found<T>(item: T | undefined): T { if (!item) fail(404, "not-found", "Resource not found"); return item; }
function pathName(value: unknown): string {
  const path = text(value, "path", 1024);
  if (path.startsWith("/") || path.includes("\\") || /^[A-Za-z]:/.test(path) || path.split("/").some((v) => !v || v === "." || v === ".." || v.toLowerCase() === ".git") || [...path].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) fail(400, "unsafe-path", "Unsafe relative file path");
  return path;
}
function event(state: HubState, actor: Principal, projectId: string, type: string, entityId: string) {
  state.events.push({ sequence: (state.events.at(-1)?.sequence ?? 0) + 1, projectId, type, entityId, actorId: actor.id, actorRole: actor.role, createdAt: new Date().toISOString() });
}
function receipt(actor: Principal): Receipt { return { id: randomUUID(), actorId: actor.id, createdAt: new Date().toISOString() }; }
function changedDocument(state: HubState, p: Project, doc: HubDocument) {
  p.contextRevision++;
  state.documentChanges.push({ projectId: p.id, revision: p.contextRevision, document: structuredClone(doc) });
}
function proposal(state: HubState, actor: Principal, p: Project, doc: HubDocument, content: string, reason: string, sourceRevision?: string): Proposal {
  const value: Proposal = { id: randomUUID(), projectId: p.id, documentId: doc.id, baseVersion: doc.version, content, contentDigest: sha256(content), reason, status: "pending", version: 1, createdBy: actor.id, ...(sourceRevision ? { sourceRevision } : {}) };
  state.proposals.push(value); event(state, actor, p.id, "proposal-created", value.id); return value;
}
/** Shared guard for REST/MCP and remote execution/result adapters. */
export function assertLegacyFlowWritable(state:HubState,projectId:string,flowId:string):void {
  const conversion=state.legacyConversions?.[flowId];
  if(conversion?.projectId===projectId)fail(409,'flow-converted','Legacy Flow is read-only; managed replacement '+conversion.managedFlowId);
}
function currentSpec(state: HubState, flow: HubFlow) {
  const spec = found(state.documents.find((d) => d.id === flow.specDocumentId && d.projectId === flow.projectId));
  if (spec.contentDigest !== flow.specContentDigest) fail(409, "spec-changed", "Pinned specification changed; create a new Flow");
}
function successfulEvidence(state: HubState, flow: HubFlow, subject: string) {
  const reports = state.evidence.filter((e) => e.flowId === flow.id && e.subjectRevisionId === subject);
  if (!reports.length || reports.some((e) => e.exitCode !== 0)) fail(409, "evidence-required", "Successful evidence for this exact subject is required");
}
function transition(flow: HubFlow, status: HubFlow["status"]) {
  if (!canTransition(flow.status, status)) fail(409, "invalid-transition", `Cannot transition ${flow.status} to ${status}`);
  flow.status = status;
}
function revisionChanges(value: unknown): RevisionChange[] {
  const seen = new Set<string>();
  return list(value, 5000).map((raw) => {
    const c = object(raw); const path = pathName(c.path);
    if (seen.has(path)) fail(400, "duplicate-path", "Duplicate path"); seen.add(path);
    if (c.deleted !== undefined && c.deleted !== true) fail(400, "invalid-change", "deleted must be true");
    if (c.deleted) {
      if (c.contentBase64 !== undefined || c.mode !== undefined) fail(400, "invalid-change", "Deletion cannot have bytes or mode");
      return { path, deleted: true };
    }
    if (c.mode !== undefined && c.mode !== "100644" && c.mode !== "100755") fail(400, "unsupported-mode", "Only regular tracked files are supported");
    if (typeof c.contentBase64 !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(c.contentBase64)) fail(400, "invalid-base64", "Invalid file encoding");
    return { path, contentBase64: c.contentBase64, mode: c.mode ?? "100644" };
  });
}
function scopedRevision(state: HubState, p: Project, id: unknown): CodeRevision {
  return found(state.revisions.find((r) => r.projectId === p.id && r.id === text(id, "revisionId")));
}
function deliverableRevision(revision: CodeRevision): void {
  if (revision.purpose === "review-bundle") fail(409, "review-bundle-not-deliverable", "Review bundles are evidence subjects, not integration snapshots");
}
export function hubRead(state: HubState, path: string[], url: URL): unknown {
  if (path.length === 1 && path[0] === "projects") return { projects: state.projects };
  if (path[0] !== "projects") fail(404, "not-found", "Route not found");
  const p = found(state.projects.find((p) => p.id === path[1]));
  if (path.length === 2) return p;
  switch (path[2]) {
    case "documents": return path[3] ? found(state.documents.find((d) => d.projectId === p.id && d.id === path[3])) : { documents: state.documents.filter((d) => d.projectId === p.id) };
    case "proposals": return { proposals: state.proposals.filter((d) => d.projectId === p.id) };
    case "flows": {
      if (!path[3]) return { flows: state.flows.filter((f) => f.projectId === p.id) };
      const f = found(state.flows.find((f) => f.projectId === p.id && f.id === path[3]));
      if (path[4] === "evidence") return { evidence: state.evidence.filter((e) => e.flowId === f.id) };
      return f;
    }
    case "context": {
      const afterRaw = url.searchParams.get("after"); const after = afterRaw === null ? -1 : Number(afterRaw);
      const fullSnapshot = !Number.isSafeInteger(after) || after < 0 || after > p.contextRevision;
      const documents = state.documents.filter((d) => d.projectId === p.id);
      const changed = new Set(state.documentChanges.filter((c) => c.projectId === p.id && c.revision > after).map((c) => c.document.id));
      return { revision: p.contextRevision, fullSnapshot, manifest: documents.map(({ id, path, kind, version, contentDigest }) => ({ id, path, kind, version, contentDigest })), documents: fullSnapshot ? documents : documents.filter((d) => changed.has(d.id)), deletedDocumentIds: [] };
    }
    case "revisions": {
      if (!path[3]) {
        const revisions = state.revisions.filter((r) => r.projectId === p.id);
        return { revisions: url.searchParams.get("summary") === "1" ? revisions.map(({ files, ...metadata }) => ({ ...metadata, fileCount: files.length })) : revisions };
      }
      const r = scopedRevision(state, p, path[3]);
      if (path[4] !== "changes") return r;
      const from = url.searchParams.get("from"); const base = from ? scopedRevision(state, p, from) : null;
      const changes: RevisionChange[] = r.files.filter((file) => !base?.files.some((f) => f.path === file.path && f.contentDigest === file.contentDigest && f.mode === file.mode)).map(({ path, mode, contentBase64 }) => ({ path, mode, contentBase64 }));
      for (const f of base?.files ?? []) if (!r.files.some((n) => n.path === f.path)) changes.push({ path: f.path, deleted: true });
      return { baseRevisionId: base?.id ?? null, revisionId: r.id, changes };
    }
    case "deliveries": return { deliveries: state.deliveries.filter((d) => d.projectId === p.id) };
    case "events": {
      const after = Number(url.searchParams.get("after") ?? "0");
      if (!Number.isSafeInteger(after) || after < 0) fail(400, "invalid-cursor", "Invalid event cursor");
      const events = state.events.filter((e) => e.projectId === p.id && e.sequence > after).slice(0, 500);
      return { events, cursor: events.at(-1)?.sequence ?? after };
    }
    default: fail(404, "not-found", "Route not found");
  }
}
export async function hubMutate(state: HubState, actor: Principal, path: string[], input: unknown, config: HubConfig, deliveryAdapter: GitDeliveryAdapter, operationId: string): Promise<unknown> {
  const body = object(input);
  if (path.length === 1 && path[0] === "projects") {
    const p: Project = { id: randomUUID(), name: text(body.name, "name", 200), version: 1, lineRevisionId: null, lineVersion: 0, contextRevision: 0 };
    state.projects.push(p); event(state, actor, p.id, "project-created", p.id); return p;
  }
  if (path[0] !== "projects") fail(404, "not-found", "Route not found");
  const p = found(state.projects.find((p) => p.id === path[1]));
  if (path.length === 3 && path[2] === "import") {
    version(body.expectedVersion, p.version); const sourceRevision = text(body.sourceRevision, "sourceRevision");
    const seen = new Set<string>(); const documents: HubDocument[] = []; const proposals: Proposal[] = [];
    for (const raw of list(body.documents, 500)) {
      const item = object(raw); const path = pathName(item.path); const content = documentContent(item.content);
      if (seen.has(path)) fail(400, "duplicate-path", "Duplicate document path"); seen.add(path);
      if (item.kind !== "wiki" && item.kind !== "spec") fail(400, "invalid-kind", "Expected wiki or spec");
      const existing = state.documents.find((d) => d.projectId === p.id && d.path === path);
      if (existing) {
        if (existing.kind !== item.kind) fail(409, "kind-conflict", "Document kind cannot change");
        if (existing.contentDigest !== sha256(content)) proposals.push(proposal(state, actor, p, existing, content, "Imported source changed", sourceRevision));
        documents.push(existing);
      } else {
        const doc: HubDocument = { id: randomUUID(), projectId: p.id, path, kind: item.kind, content, contentDigest: sha256(content), version: 1, approval: "unreviewed", sourceRevision };
        state.documents.push(doc); changedDocument(state, p, doc); documents.push(doc);
      }
    }
    p.version++; const resultReceipt = receipt(actor); event(state, actor, p.id, "documents-imported", p.id);
    return { project: p, documents, proposals, receipt: resultReceipt };
  }
  if (path[2] === "proposals") {
    if (path.length === 3) {
      const doc = found(state.documents.find((d) => d.projectId === p.id && d.id === body.documentId));
      version(body.baseVersion, doc.version);
      return proposal(state, actor, p, doc, documentContent(body.content), text(body.reason, "reason"), body.sourceRevision === undefined ? undefined : text(body.sourceRevision, "sourceRevision"));
    }
    if (path.length === 5 && path[4] === "review") {
      human(actor); const value = found(state.proposals.find((v) => v.id === path[3] && v.projectId === p.id)); version(body.expectedVersion, value.version);
      if (value.status !== "pending" || body.contentDigest !== value.contentDigest) fail(409, "proposal-conflict", "Proposal changed or was already reviewed");
      if (body.decision !== "accepted" && body.decision !== "rejected") fail(400, "invalid-decision", "Expected accepted or rejected");
      const doc = found(state.documents.find((d) => d.id === value.documentId && d.projectId === p.id));
      if (body.decision === "accepted") {
        version(value.baseVersion, doc.version); doc.content = value.content; doc.contentDigest = value.contentDigest; doc.version++; doc.approval = "accepted"; doc.acceptedBy = actor.id; doc.acceptedAt = new Date().toISOString(); changedDocument(state, p, doc); p.version++;
      }
      value.status = body.decision; value.version++; value.reviewedBy = actor.id; value.reviewedAt = new Date().toISOString(); value.receipt = receipt(actor);
      event(state, actor, p.id, `proposal-${value.status}`, value.id); return value;
    }
  }
  if (path[2] === "flows") {
    if (path.length === 3) {
      const spec = found(state.documents.find((d) => d.projectId === p.id && d.id === body.specDocumentId && d.kind === "spec"));
      const criteria = list(body.criteria, 100).map((c) => text(c, "criterion")); if (!criteria.length) fail(400, "criteria-required", "At least one criterion is required");
      const f: HubFlow = { id: randomUUID(), projectId: p.id, title: text(body.title, "title", 500), specDocumentId: spec.id, specContentDigest: spec.contentDigest, criteria, status: "initializing", version: 1, subjectRevisionId: null };
      state.flows.push(f); event(state, actor, p.id, "flow-created", f.id); return f;
    }
    const f = found(state.flows.find((f) => f.projectId === p.id && f.id === path[3])); assertLegacyFlowWritable(state,p.id,f.id); const action = path[4];
    if (path.length === 5 && action === "evidence") {
      if (f.status !== "in-progress") fail(409, "invalid-transition", "Evidence can only be submitted during implementation");
      const r = scopedRevision(state, p, body.subjectRevisionId); const exitCode = integer(body.exitCode, "exitCode");
      let output = typeof body.output === "string" ? body.output : fail(400, "invalid-field", "Invalid output");
      if (Buffer.byteLength(output) > 2 * 1024 * 1024) fail(413, "quota-exceeded", "Evidence output exceeds quota");
      let command = text(body.command, "command", 4096);
      for (const token of [config.operatorToken, config.agentToken, config.reviewerToken]) if (token) { output = output.replaceAll(token, "[REDACTED]"); command = command.replaceAll(token, "[REDACTED]"); }
      output = output.replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+/gi, "$1[REDACTED]").slice(0, 65536);
      const e = { id: randomUUID(), projectId: p.id, flowId: f.id, subjectRevisionId: r.id, checkId: text(body.checkId, "checkId", 200), command, exitCode, output, actorId: actor.id, provenance: "self-reported" as const, createdAt: new Date().toISOString() };
      state.evidence.push(e); event(state, actor, p.id, "evidence-submitted", e.id); return e;
    }
    if (path.length !== 5) fail(404, "not-found", "Route not found");
    if (action === "freeze" || action === "accept") human(actor);
    version(body.expectedVersion, f.version); currentSpec(state, f);
    switch (action) {
      case "freeze": transition(f, "ready"); f.frozenBy = actor.id; break;
      case "start": transition(f, "in-progress"); break;
      case "submit-for-review": {
        const r = scopedRevision(state, p, body.subjectRevisionId); successfulEvidence(state, f, r.id); transition(f, "implemented"); f.subjectRevisionId = r.id; break;
      }
      case "accept": {
        if (body.subjectRevisionId !== f.subjectRevisionId) fail(409, "subject-conflict", "Review subject changed");
        if (body.acknowledgeSelfReportedEvidence !== true) fail(400, "trust-acknowledgment-required", "Explicit acknowledgment of self-reported evidence is required");
        successfulEvidence(state, f, text(body.subjectRevisionId, "subjectRevisionId")); transition(f, "completing"); transition(f, "done"); f.acceptedBy = actor.id; f.acceptedAt = new Date().toISOString(); f.receipt = receipt(actor); break;
      }
      default: fail(404, "not-found", "Route not found");
    }
    f.version++; event(state, actor, p.id, `flow-${action}`, f.id); return f;
  }
  if (path.length === 3 && path[2] === "revisions") {
    const r = buildRevisionRecord(state, p.id, actor.id, body); event(state, actor, p.id, "revision-created", r.id); return r;
  }
  if (path.length === 3 && path[2] === "line") {
    human(actor); version(body.expectedVersion, p.lineVersion); const r = scopedRevision(state, p, body.revisionId);
    deliverableRevision(r);
    p.lineRevisionId = r.id; p.lineVersion++; event(state, actor, p.id, "line-selected", r.id); return p;
  }
  if (path.length === 3 && path[2] === "deliveries") {
    const request = prepareGitDelivery(state, actor, p.id, body, config.dataDir, operationId);
    let result: GitDeliveryResult;
    try { result = await deliveryAdapter(request); }
    catch { result = { status: 'failed', error: 'Git delivery failed; inspect managed repository state before retry' }; }
    return completeGitDelivery(state, actor, request, result, Number(body.expectedLineVersion));
  }
  fail(404, "not-found", "Route not found");
}

/** Pure reservation checks; the caller must run Git outside its authority transaction. */
export function prepareGitDelivery(state: HubState, actor: Principal, projectId: string, input: unknown, dataDir: string, operationId: string): GitDeliveryRequest {
  const body = object(input), p = found(state.projects.find(project => project.id === projectId));
  human(actor); version(body.expectedLineVersion, p.lineVersion);
  const revision = scopedRevision(state, p, body.revisionId); deliverableRevision(revision);
  if (p.lineRevisionId !== revision.id) fail(409, 'line-conflict', 'Revision is not the selected integration line');
  return { dataDir, projectId, operationId, revision, remoteUrl: text(body.remoteUrl,'remoteUrl'), baseBranch: text(body.baseBranch,'baseBranch',200) };
}
/** Finalize against current authority state, never the pre-network legacy snapshot. */
export function completeGitDelivery(state: HubState, actor: Principal, request: GitDeliveryRequest, result: GitDeliveryResult, expectedLineVersion: number) {
  const p = found(state.projects.find(project => project.id === request.projectId));
  human(actor); version(expectedLineVersion, p.lineVersion);
  if (p.lineRevisionId !== request.revision.id) fail(409,'line-conflict','Selected integration line changed during Git delivery; inspect the recorded external result');
  const delivery = { id: request.operationId, projectId: p.id, revisionId: request.revision.id, remoteUrl: request.remoteUrl, baseBranch: request.baseBranch, ...result, receipt: receipt(actor) };
  state.deliveries.push(delivery); event(state, actor, p.id, `delivery-${result.status}`, delivery.id);
  return delivery;
}

/** Shared synchronous revision construction; callers supply their own authority and transaction. */
export function buildRevisionRecord(state: HubState, projectId: string, actorId: string, input: unknown): CodeRevision {
  const p = found(state.projects.find((project) => project.id === projectId)); const body = object(input);
    const base = body.baseRevisionId === null ? null : scopedRevision(state, p, body.baseRevisionId);
    if (body.purpose !== undefined && body.purpose !== "snapshot" && body.purpose !== "review-bundle") fail(400, "invalid-purpose", "Expected snapshot or review-bundle purpose");
    const purpose = body.purpose;
    if (base && (base.purpose ?? "snapshot") !== (purpose ?? "snapshot")) fail(409, "revision-purpose-conflict", "Incremental revision purpose must match its base");
    const gitBaseSha = text(body.gitBaseSha, "gitBaseSha", 64); if (!/^[0-9a-f]{40,64}$/i.test(gitBaseSha)) fail(400, "invalid-sha", "Expected Git object SHA");
    const files = new Map<string, RevisionFile>((base?.files ?? []).map((f) => [f.path, { ...f }]));
    for (const change of revisionChanges(body.changes)) {
      if (change.deleted) files.delete(change.path);
      else {
        const contentBase64 = change.contentBase64!;
        files.set(change.path, { path: change.path, contentBase64, mode: change.mode ?? "100644", contentDigest: sha256(Buffer.from(contentBase64, "base64")) });
      }
    }
    const tree = [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
    if (tree.length > 5000 || tree.reduce((sum, f) => sum + Buffer.byteLength(f.contentBase64, "base64"), 0) > 20 * 1024 * 1024) fail(413, "quota-exceeded", "Snapshot exceeds quota");
    for (const f of tree) if (tree.some((other) => other.path.startsWith(`${f.path}/`))) fail(400, "path-conflict", "File and directory paths collide");
    const r: CodeRevision = { id: randomUUID(), projectId: p.id, baseRevisionId: base?.id ?? null, gitBaseSha, message: text(body.message, "message"), files: tree, createdBy: actorId, createdAt: new Date().toISOString(), treeDigest: sha256(JSON.stringify(tree.map(({ path, mode, contentDigest }) => ({ path, mode, contentDigest })))), ...(purpose ? { purpose } : {}) };
    state.revisions.push(r); return r;
}
