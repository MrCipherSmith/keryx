import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { assembleContext, type ContextAssembly, type ContextCandidate, type ContextOverflow } from "../ctx/assembly";
import { evaluateStrictSacGuard, validateSacContract, type SacAuthorizationServer, type StrictSacGuard, type TrustedActorContext } from "./index";
import { localWorkspaceAuthorizationServer, WorkspaceService, WorkspaceServiceError } from "./workspace-service";
import { createFlowService } from "../flow/service";

export type FwkEvidence = Readonly<{ id: string; uri: string; revision: string; observedAt: string; expiresAt: string; trust: "primary" | "accepted" | "reviewed"; visible: boolean; statement: string }>;
export type FwkKnowHow = Readonly<{ id: string; kind: "wiki" | "memory" | "skill"; uri: string; revision: string; trust: "accepted" | "reviewed"; status: "fresh" | "stale" | "withdrawn" | "denied"; applicability?: string; accepted: boolean; visible: boolean }>;
export type FwkWork = Readonly<{ flowRef?: { uri: string; snapshot: string; revision: string }; completed?: string[]; next?: string[]; blocked?: string[]; evidence?: FwkEvidence[] }>;
export type FwkSource = Readonly<{ facts: readonly FwkEvidence[]; work?: FwkWork; knowHow: readonly FwkKnowHow[] }>;
export type AccessReceipt = Readonly<{ schemaVersion: "1.0"; id: string; workspaceId: string; actor: string; action: "overview" | "fwk" | "resource"; decision: "allowed" | "denied" | "budget-exhausted" | "stale"; recordedAt: string; cost: { tokens: number; toolCalls: number; elapsedMs: number }; contextAssembly: { traceRef: string; configurationRevision: string; selected: string[]; omittedOptional: string[] }; policy: { ref: string; revision: string }; integrity: { recordHash: string; previousRecordHash: "GENESIS" }; }>;
export type FwkResult = Readonly<{ partial: boolean; omittedOptional: string[]; manifest: { facts: unknown[]; work: unknown; knowHow: unknown[]; freshness: "fresh" | "stale" | "partial" | "denied" }; receipt: AccessReceipt }>;
export type FwkReadResult = FwkResult | ContextOverflow;

const metadataOnly = (value: unknown): boolean => {
  if (typeof value !== "object" || value === null) return true;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (["prompt", "transcript", "hiddenReasoning", "secret", "secrets", "rawContent"].includes(key)) return false;
    if (!metadataOnly(child)) return false;
  }
  return true;
};
const nowIso = (now: () => Date) => now().toISOString();

/** Read-only SAC facade; all sources are adapters owned by their source module. */
export class FwkReadService {
  constructor(private readonly options: {
    guard: StrictSacGuard;
    authorizationServer: SacAuthorizationServer;
    source: (input: { workspaceId: string; actorContext: TrustedActorContext }) => Promise<FwkSource>;
    canonical: { traceRef: string; configurationRevision: string; policyRef: string; policyRevision: string };
    now?: () => Date;
  }) {}

  async overview(input: { workspaceId: string; request: unknown; requestCorrelationId: string; budget: { maxItems: number; maxTokens: number }; required?: string[]; optional?: string[] }): Promise<FwkReadResult> {
    // Actor identity is intentionally absent from the public payload.  Only a
    // transport-owned authorization server may issue the WeakSet-trusted
    // context carried into source resolution.
    const actor = await this.options.authorizationServer.actorContextFor(input.request, input.requestCorrelationId);
    if (!actor) return this.denied(input.workspaceId, "service:untrusted");
    const guard = await evaluateStrictSacGuard({ guard: this.options.guard, operation: "read" });
    if (!guard.allowed) return this.denied(input.workspaceId, actor.subject);
    let source: FwkSource;
    try {
      // The source adapter must authorize/revalidate while opening its source,
      // so a role revoked after actor issuance cannot disclose a reference.
      source = await this.options.source({ workspaceId: input.workspaceId, actorContext: actor });
    } catch (error) {
      // Do not turn source existence, cross-workspace, or revoked-role errors
      // into a discovery oracle.  All are represented as the same receipt.
      if (error instanceof WorkspaceServiceError && (error.code === "access_denied" || error.code === "not_found")) return this.denied(input.workspaceId, actor.subject);
      throw error;
    }
    const now = this.options.now ?? (() => new Date());
    const required = new Set(input.required ?? []); const optional = new Set(input.optional ?? []);
    const facts = source.facts.map((fact) => ({ ...fact, freshness: !fact.visible ? "denied" : new Date(fact.expiresAt) <= now() ? "expired" : "fresh" as const }));
    const usableFacts = facts.filter((fact) => fact.visible && fact.freshness === "fresh");
    const knowHow = source.knowHow.filter((item) => item.visible && item.accepted && item.status !== "withdrawn");
    const work = source.work?.flowRef ? { state: "bound" as const, ...source.work } : { state: "unbound" as const };
    const candidates: ContextCandidate[] = [
      ...usableFacts.map((fact) => ({ id: fact.id, required: required.has(fact.id) || !optional.has(fact.id), tokens: Math.ceil(fact.statement.length / 4) })),
      ...(work.state === "bound" ? [{ id: "work", required: required.has("work") || !optional.has("work"), tokens: 32 }] : []),
      ...knowHow.map((item) => ({ id: item.id, required: required.has(item.id), tokens: 16 })),
    ];
    const assembly = assembleContext({ ...input.budget, candidates, ...this.options.canonical });
    if ("code" in assembly) return assembly;
    return this.success(input.workspaceId, actor.subject, assembly, usableFacts, work, knowHow, now);
  }

  private async success(workspaceId: string, actor: string, assembly: ContextAssembly, facts: Array<FwkEvidence & { freshness: string }>, work: unknown, knowHow: FwkKnowHow[], now: () => Date): Promise<FwkResult> {
    const selected = new Set(assembly.selected);
    const manifest = { schemaVersion: "1.0" as const, workspaceId, generatedAt: nowIso(now), facts: facts.filter((fact) => selected.has(fact.id)).map((fact) => ({ statement: fact.statement, evidence: [{ kind: "artifact" as const, uri: fact.uri, revision: fact.revision, observedAt: fact.observedAt, trust: fact.trust }], observedAt: fact.observedAt, expiresAt: fact.expiresAt, freshness: "fresh" as const })), work: selected.has("work") ? work : { state: "unbound" }, knowHow: knowHow.filter((item) => selected.has(item.id)).map(({ id, accepted, visible, ...item }) => item), freshness: assembly.partial ? "partial" as const : "fresh" as const };
    const fwk = await validateSacContract({ schema: "fwk-receipt", document: manifest });
    if (!fwk.valid) throw new Error(`invalid FWK manifest: ${fwk.errors.map((error) => error.code).join(",")}`);
    const receipt = this.receipt(workspaceId, actor, "allowed", assembly, now);
    if (!metadataOnly(receipt)) throw new Error("receipt metadata contract violated");
    const validation = await validateSacContract({ schema: "access-receipt", document: receipt });
    if (!validation.valid) throw new Error(`invalid access receipt: ${validation.errors.map((error) => error.code).join(",")}`);
    return { partial: assembly.partial, omittedOptional: assembly.omittedOptional, manifest, receipt };
  }

  private async denied(workspaceId: string, actor: string): Promise<FwkResult> {
    const now = this.options.now ?? (() => new Date());
    const assembly: ContextAssembly = { ...this.options.canonical, selected: [], omittedOptional: [], partial: false };
    const receipt = this.receipt(workspaceId, actor, "denied", assembly, now);
    if (!metadataOnly(receipt)) throw new Error("receipt metadata contract violated");
    const validation = await validateSacContract({ schema: "access-receipt", document: receipt });
    if (!validation.valid) throw new Error(`invalid access receipt: ${validation.errors.map((error) => error.code).join(",")}`);
    return { partial: false, omittedOptional: [], manifest: { facts: [], work: { state: "unbound" }, knowHow: [], freshness: "denied" }, receipt };
  }

  private receipt(workspaceId: string, actor: string, decision: AccessReceipt["decision"], assembly: ContextAssembly, now: () => Date): AccessReceipt {
    const recordedAt = nowIso(now); const id = `receipt-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const base = { schemaVersion: "1.0" as const, id, workspaceId, actor, action: "overview" as const, decision, recordedAt, cost: { tokens: 0, toolCalls: 1, elapsedMs: 0 }, contextAssembly: { traceRef: assembly.traceRef, configurationRevision: assembly.configurationRevision, selected: assembly.selected.map((id) => `./ids/${id}`), omittedOptional: assembly.omittedOptional.map((id) => `./ids/${id}`) }, policy: { ref: assembly.policyRef, revision: assembly.policyRevision } };
    return { ...base, integrity: { recordHash: createHash("sha256").update(JSON.stringify(base)).digest("hex"), previousRecordHash: "GENESIS" } };
  }
}

/** Local-only composition for the CLI and stdio MCP adapters. */
export function createLocalFwkReadService(cwd: string): FwkReadService {
  const authorizationServer = localWorkspaceAuthorizationServer();
  const workspaces = new WorkspaceService({
    workspaceRoot: cwd,
    authorizationServer,
    strictGuard: { mode: "strict", availability: "available", decision: "pass", policyRevision: "local-offline-v1" },
  });
  return new FwkReadService({
    guard: { mode: "strict", availability: "available", decision: "pass", policyRevision: "local-offline-v1" },
    authorizationServer,
    source: async ({ workspaceId, actorContext }) => {
      const manifest = await workspaces.showForActor({ actorContext, workspaceId });
      const flow = manifest.resources.find((resource) => resource.kind === "flow");
      const facts = await Promise.all(manifest.resources.filter((resource) => resource.kind === "evidence").map(async (resource, index) => {
        const raw = await readFile(path.resolve(cwd, resource.uri.slice(2)));
        const revision = createHash("sha256").update(raw).digest("hex");
        if (resource.revision !== revision) return undefined;
        return { id: `fact-${index}`, uri: resource.uri, revision, observedAt: manifest.updatedAt, expiresAt: "9999-12-31T23:59:59Z", trust: "primary" as const, visible: true, statement: `Evidence reference ${resource.uri}` };
      }));
      const knowHow = await Promise.all(manifest.resources.filter((resource) => resource.kind === "wiki" || resource.kind === "memory" || resource.kind === "skill").map(async (resource, index) => {
        const raw = await readFile(path.resolve(cwd, resource.uri.slice(2)), "utf8");
        const revision = createHash("sha256").update(raw).digest("hex");
        const accepted = /^Status:\s*(accepted|reviewed)\s*$/mi.test(raw);
        if (!accepted || resource.revision !== revision) return undefined;
        return { id: `knowhow-${index}`, kind: resource.kind as "wiki" | "memory" | "skill", uri: resource.uri, revision, trust: "accepted" as const, status: "fresh" as const, accepted: true, visible: true };
      }));
      const work = flow ? await (async () => {
        const id = /(?:^|\/)0*([0-9]+)-/.exec(flow.uri)?.[1];
        if (!id) return undefined;
        const snapshot = await createFlowService({ tracker: null, healthGate: async () => ({ status: "skipped", reasons: [] }), now: () => new Date() }).get({ cwd, id });
        return { flowRef: { uri: flow.uri, snapshot: snapshot.status, revision: snapshot.updatedAt }, completed: snapshot.tasks.filter((task) => task.status === "done").map((task) => task.id), next: snapshot.tasks.filter((task) => task.status !== "done").map((task) => task.id), blocked: snapshot.status === "blocked" ? [snapshot.id] : [] };
      })() : undefined;
      return {
        facts: facts.filter((entry): entry is NonNullable<typeof entry> => entry !== undefined),
        ...(work ? { work } : {}),
        knowHow: knowHow.filter((entry): entry is NonNullable<typeof entry> => entry !== undefined),
      };
    },
    canonical: { traceRef: "./context-operations/traces/local-read-v1", configurationRevision: "context-operations-v1", policyRef: "./security/policy/local", policyRevision: "local-offline-v1" },
  });
}

/** The only transport serialization contract used by both CLI and MCP. */
export function normalizeFwkResult(result: FwkReadResult): FwkReadResult { return JSON.parse(JSON.stringify(result)) as FwkReadResult; }
