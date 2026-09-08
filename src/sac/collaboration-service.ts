import { appendFile, mkdir, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { WorkspaceService, localWorkspaceAuthorizationServer } from "./workspace-service";
import { isWorkspaceOwner } from "./index";
import type { SacAuthorizationServer } from "./index";
import type { StrictSacGuard } from "./index";

export type CollaborationActivity = Readonly<{ schemaVersion: "1.0"; id: string; kind: "reference-added" | "handoff-recorded"; workspaceId: string; actorSubject: string; occurredAt: string; reference?: { kind: "worktree" | "session"; uri: string; revision?: string }; handoff?: { from: string; to: string; artifactRef: string } }>;
/**
 * What a caller supplies. `handoff.from` is optional here and required on the
 * stored row: the service fills it from the authenticated actor rather than
 * trusting a caller-supplied one, so "who handed this over" is the subject the
 * authorization server resolved and not a string anyone can type.
 */
export type CollaborationActivityInput = Omit<CollaborationActivity, "schemaVersion" | "id" | "workspaceId" | "actorSubject" | "occurredAt" | "handoff"> & { handoff?: { from?: string; to: string; artifactRef: string } };
export class CollaborationServiceError extends Error { constructor(readonly code: "access_denied" | "invalid_activity", message: string) { super(message); } }
export class CollaborationService {
  constructor(private readonly input: { workspaceRoot: string; workspaces: WorkspaceService; authorizationServer: SacAuthorizationServer; now?: () => Date }) {}
  private file(id: string) { return path.join(this.input.workspaceRoot, ".metaproject", "workspaces", id, "activity.jsonl"); }
  async overview(input: { request: unknown; requestCorrelationId: string; workspaceId: string }) { const manifest = await this.input.workspaces.show(input); return normalizeCollaborationResult({ workspaceId: manifest.id, references: manifest.resources.filter((r) => r.kind === "worktree" || r.kind === "session"), activity: await this.activity(input) }); }
  async activity(input: { request: unknown; requestCorrelationId: string; workspaceId: string }): Promise<CollaborationActivity[]> { await this.input.workspaces.show(input); try { return (await readFile(this.file(input.workspaceId), "utf8")).trim().split("\n").filter(Boolean).map((line) => this.validate(JSON.parse(line))); } catch (error) { if (typeof error === "object" && error && "code" in error && error.code === "ENOENT") return []; throw error; } }
  async record(input: { request: unknown; requestCorrelationId: string; workspaceId: string; activity: CollaborationActivityInput }) { const actor = await this.input.authorizationServer.actorContextFor(input.request, input.requestCorrelationId); if (!actor) throw new CollaborationServiceError("access_denied", "trusted ActorContext is required"); return this.input.workspaces.withAuthorizedActor({ actorContext: actor, workspaceId: input.workspaceId, action: "write", execute: async (manifest) => { if (!isWorkspaceOwner(manifest.members, actor.subject)) throw new CollaborationServiceError("access_denied", "owner authority is required"); const supplied = input.activity as CollaborationActivityInput & Record<string, unknown>; const activity = this.validate({ schemaVersion: "1.0", id: `activity-${randomUUID()}`, workspaceId: manifest.id, actorSubject: actor.subject, occurredAt: (this.input.now ?? (() => new Date()))().toISOString(), ...supplied, ...(supplied.handoff && typeof supplied.handoff === "object" && !Array.isArray(supplied.handoff) ? { handoff: { ...supplied.handoff, from: supplied.handoff.from ?? actor.subject } } : {}) }); await mkdir(path.dirname(this.file(manifest.id)), { recursive: true, mode: 0o700 }); await appendFile(this.file(manifest.id), `${JSON.stringify(activity)}\n`, { mode: 0o600 }); return normalizeCollaborationResult(activity); } }); }
  private validate(value: unknown): CollaborationActivity { if (!value || typeof value !== "object" || Array.isArray(value)) throw new CollaborationServiceError("invalid_activity", "activity must be an object"); const r = value as Record<string, unknown>; const allowed = new Set(["schemaVersion", "id", "kind", "workspaceId", "actorSubject", "occurredAt", "reference", "handoff"]); if (Object.keys(r).some((key) => !allowed.has(key) || /prompt|transcript|secret|reasoning|content/i.test(key))) throw new CollaborationServiceError("invalid_activity", "activity contains forbidden metadata"); if (r.schemaVersion !== "1.0" || (r.kind !== "reference-added" && r.kind !== "handoff-recorded") || typeof r.id !== "string" || typeof r.workspaceId !== "string" || typeof r.actorSubject !== "string" || typeof r.occurredAt !== "string") throw new CollaborationServiceError("invalid_activity", "activity is malformed"); if (r.kind === "handoff-recorded") this.validateHandoff(r.handoff); return r as unknown as CollaborationActivity; }
  /**
   * A `handoff-recorded` row that names nobody is worse than no row: it says a
   * handoff happened and leaves the reader unable to act on it, which reads as
   * a record where there is none. The key allowlist above cannot catch this —
   * it checks which keys exist, not whether the payload says anything.
   */
  private validateHandoff(value: unknown): void {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new CollaborationServiceError("invalid_activity", "a handoff-recorded activity requires a handoff { from, to, artifactRef }");
    const handoff = value as Record<string, unknown>;
    const fields = ["from", "to", "artifactRef"] as const;
    if (Object.keys(handoff).some((key) => !(fields as readonly string[]).includes(key))) throw new CollaborationServiceError("invalid_activity", `handoff accepts only ${fields.join(", ")}`);
    for (const field of fields) {
      const raw = handoff[field];
      if (typeof raw !== "string" || raw.trim().length === 0) throw new CollaborationServiceError("invalid_activity", `handoff.${field} must be a non-empty string`);
      if (raw.length > MAX_HANDOFF_FIELD) throw new CollaborationServiceError("invalid_activity", `handoff.${field} exceeds ${MAX_HANDOFF_FIELD} characters — this field is a reference, not a payload`);
      // The store is line-oriented and read back by humans and agents alike.
      // Control characters would survive JSON encoding into a value nothing
      // renders faithfully, so they are refused at the door rather than escaped.
      if (CONTROL_CHARACTERS.test(raw)) throw new CollaborationServiceError("invalid_activity", `handoff.${field} contains control characters`);
    }
  }
}

/** A reference, not a payload: enough for a path, an id or a URL and no more. */
const MAX_HANDOFF_FIELD = 512;
// Matches C0 and C1 control characters. Built from a range rather than written
// out, so no literal control byte appears in this source file.
const CONTROL_CHARACTERS = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}-${String.fromCharCode(0x9f)}]`);
export function createLocalCollaborationService(cwd: string) { const guard: StrictSacGuard = { mode: "strict", availability: "available", decision: "pass", policyRevision: "local-offline-v1" }; const authorizationServer = localWorkspaceAuthorizationServer(); return new CollaborationService({ workspaceRoot: cwd, authorizationServer, workspaces: new WorkspaceService({ workspaceRoot: cwd, authorizationServer, strictGuard: guard }) }); }
export function normalizeCollaborationResult<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
