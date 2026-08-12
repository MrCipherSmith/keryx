import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { assembleAndRecordContext, recordNoContentContext, type ContextAssembly, type ContextCandidate, type ContextOverflow } from "../ctx/assembly";
import { evaluateStrictSacGuard, validateSacContract, type SacAuthorizationServer, type StrictSacGuard, type TrustedActorContext } from "./index";
import { localWorkspaceAuthorizationServer, WorkspaceService, WorkspaceServiceError } from "./workspace-service";
import { withFileLock } from "../lib/fs";
import {
  sealAccessReceipt,
  verifyAccessReceiptRecord,
  verifyAccessReceiptLedger,
  type AccessReceiptLedgerVerification,
  type IntegrityLinkedAccessReceipt,
} from "./receipt-integrity";

export type FwkEvidence = Readonly<{ id: string; uri: string; revision: string; observedAt: string; expiresAt: string; trust: "primary" | "accepted" | "reviewed"; visible: boolean; statement: string; status?: "fresh" | "stale" | "expired" | "denied" }>;
export type FwkKnowHow = Readonly<{ id: string; kind: "wiki" | "memory" | "skill"; uri: string; revision: string; trust: "accepted" | "reviewed"; status: "fresh" | "stale" | "withdrawn" | "denied"; applicability?: string; accepted: boolean; visible: boolean }>;
export type FwkWork = Readonly<{ flowRef?: { uri: string; snapshot: string; revision: string }; completed?: string[]; next?: string[]; blocked?: string[]; evidence?: FwkEvidence[] }>;
export type FwkSource = Readonly<{ facts: readonly FwkEvidence[]; work?: FwkWork; knowHow: readonly FwkKnowHow[] }>;
export type AccessReceipt = IntegrityLinkedAccessReceipt;
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

type LedgerIdentity = Readonly<{ ledgerBytes: number; device: string; inode: string; modifiedNs: string; changedNs: string }>;
type CheckpointBody = LedgerIdentity & Readonly<{ schemaVersion: "1.0"; recordCount: number; headHash: string; tailOffset: number }>;
type Checkpoint = CheckpointBody & Readonly<{ integrity: Readonly<{ checkpointHash: string }> }>;
type LedgerState = Readonly<{ identity: LedgerIdentity; recordCount: number; headHash: string; tailOffset: number }>;
type LedgerVerifier = (receipts: readonly IntegrityLinkedAccessReceipt[]) => AccessReceiptLedgerVerification | Promise<AccessReceiptLedgerVerification>;
const receiptHashPattern = /^[a-f0-9]{64}$/;
const missingIdentity: LedgerIdentity = Object.freeze({ ledgerBytes: 0, device: "0", inode: "0", modifiedNs: "0", changedNs: "0" });
const isMissing = (error: unknown): boolean => error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT";
const checkpointHash = (body: CheckpointBody): string => createHash("sha256").update(JSON.stringify(body), "utf8").digest("hex");

async function ledgerIdentity(ledger: string): Promise<LedgerIdentity> {
  const value = await stat(ledger, { bigint: true });
  if (value.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("invalid access receipt ledger: ledger-too-large");
  return { ledgerBytes: Number(value.size), device: value.dev.toString(), inode: value.ino.toString(), modifiedNs: value.mtimeNs.toString(), changedNs: value.ctimeNs.toString() };
}
function parseCheckpoint(value: unknown): Checkpoint | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const document = value as Record<string, unknown>;
  const expected = ["schemaVersion", "ledgerBytes", "device", "inode", "modifiedNs", "changedNs", "recordCount", "headHash", "tailOffset", "integrity"];
  if (Object.keys(document).length !== expected.length || !expected.every((key) => Object.hasOwn(document, key)) || document.schemaVersion !== "1.0") return undefined;
  if (![document.ledgerBytes, document.recordCount, document.tailOffset].every((entry) => Number.isSafeInteger(entry) && Number(entry) >= 0)) return undefined;
  if (![document.device, document.inode, document.modifiedNs, document.changedNs].every((entry) => typeof entry === "string" && /^\d+$/.test(entry))) return undefined;
  if (typeof document.headHash !== "string" || (document.headHash !== "GENESIS" && !receiptHashPattern.test(document.headHash))) return undefined;
  if (typeof document.integrity !== "object" || document.integrity === null || Array.isArray(document.integrity)) return undefined;
  const integrity = document.integrity as Record<string, unknown>;
  if (Object.keys(integrity).length !== 1 || typeof integrity.checkpointHash !== "string" || !receiptHashPattern.test(integrity.checkpointHash)) return undefined;
  const body: CheckpointBody = { schemaVersion: "1.0", ledgerBytes: document.ledgerBytes as number, device: document.device as string, inode: document.inode as string, modifiedNs: document.modifiedNs as string, changedNs: document.changedNs as string, recordCount: document.recordCount as number, headHash: document.headHash, tailOffset: document.tailOffset as number };
  return checkpointHash(body) === integrity.checkpointHash ? { ...body, integrity: { checkpointHash: integrity.checkpointHash } } : undefined;
}
async function readCheckpoint(checkpointPath: string): Promise<{ present: boolean; checkpoint?: Checkpoint }> {
  try { const raw = await readFile(checkpointPath, "utf8"); try { const checkpoint = parseCheckpoint(JSON.parse(raw)); return checkpoint ? { present: true, checkpoint } : { present: true }; } catch { return { present: true }; } }
  catch (error) { if (isMissing(error)) return { present: false }; throw error; }
}
async function writeCheckpoint(checkpointPath: string, body: CheckpointBody): Promise<void> {
  const temporary = `${checkpointPath}.${process.pid}.${randomUUID()}.tmp`;
  const checkpoint: Checkpoint = { ...body, integrity: { checkpointHash: checkpointHash(body) } };
  try { await writeFile(temporary, `${JSON.stringify(checkpoint)}\n`, { mode: 0o600, flag: "wx" }); await rename(temporary, checkpointPath); }
  catch (error) { await rm(temporary, { force: true }).catch(() => undefined); throw error; }
}
function identityMatches(checkpoint: Checkpoint, identity: LedgerIdentity): boolean {
  return checkpoint.ledgerBytes === identity.ledgerBytes && checkpoint.device === identity.device && checkpoint.inode === identity.inode && checkpoint.modifiedNs === identity.modifiedNs && checkpoint.changedNs === identity.changedNs;
}
async function fastCheckpointState(ledger: string, checkpoint: Checkpoint, identity: LedgerIdentity): Promise<LedgerState | undefined> {
  if (!identityMatches(checkpoint, identity)) return undefined;
  if (checkpoint.recordCount === 0) return checkpoint.ledgerBytes === 0 && checkpoint.headHash === "GENESIS" && checkpoint.tailOffset === 0 ? { identity, recordCount: 0, headHash: "GENESIS", tailOffset: 0 } : undefined;
  const tailBytes = checkpoint.ledgerBytes - checkpoint.tailOffset;
  if (checkpoint.tailOffset < 0 || tailBytes <= 1 || tailBytes > 1024 * 1024) return undefined;
  const handle = await open(ledger, "r");
  try {
    const buffer = Buffer.alloc(tailBytes); let offset = 0;
    while (offset < buffer.length) { const result = await handle.read(buffer, offset, buffer.length - offset, checkpoint.tailOffset + offset); if (result.bytesRead === 0) return undefined; offset += result.bytesRead; }
    if (buffer.at(-1) !== 0x0a || buffer.subarray(0, -1).includes(0x0a)) return undefined;
    let receipt: IntegrityLinkedAccessReceipt;
    try { receipt = JSON.parse(buffer.subarray(0, -1).toString("utf8")) as IntegrityLinkedAccessReceipt; } catch { return undefined; }
    if (!verifyAccessReceiptRecord(receipt) || receipt.integrity.recordHash !== checkpoint.headHash) return undefined;
    return { identity, recordCount: checkpoint.recordCount, headHash: checkpoint.headHash, tailOffset: checkpoint.tailOffset };
  } finally { await handle.close(); }
}
async function auditLedger(ledger: string, checkpointPath: string, verifier: LedgerVerifier): Promise<LedgerState> {
  const raw = await readFile(ledger, "utf8");
  if (raw.length > 0 && !raw.endsWith("\n")) throw new Error("invalid access receipt ledger: unterminated-record");
  const lines = raw.length === 0 ? [] : raw.slice(0, -1).split("\n"); let receipts: IntegrityLinkedAccessReceipt[];
  try { receipts = lines.map((line) => JSON.parse(line) as IntegrityLinkedAccessReceipt); } catch { throw new Error("invalid access receipt ledger: malformed-json"); }
  const verification = await verifier(receipts);
  if (!verification.ok) throw new Error(`invalid access receipt ledger: ${verification.reason} at record ${verification.firstInvalidIndex}`);
  const identity = await ledgerIdentity(ledger); const bytes = Buffer.from(raw, "utf8");
  const tailOffset = receipts.length === 0 ? 0 : bytes.lastIndexOf(0x0a, bytes.length - 2) + 1;
  const state = { identity, recordCount: receipts.length, headHash: verification.headHash, tailOffset };
  await writeCheckpoint(checkpointPath, { schemaVersion: "1.0", ...identity, recordCount: state.recordCount, headHash: state.headHash, tailOffset });
  return state;
}
async function resolveLedgerState(ledger: string, checkpointPath: string, verifier: LedgerVerifier): Promise<LedgerState> {
  const document = await readCheckpoint(checkpointPath); let identity: LedgerIdentity;
  try { identity = await ledgerIdentity(ledger); } catch (error) {
    if (!isMissing(error)) throw error;
    if (document.present) throw new Error("invalid access receipt ledger: orphaned-checkpoint");
    return { identity: missingIdentity, recordCount: 0, headHash: "GENESIS", tailOffset: 0 };
  }
  if (document.checkpoint) { const fast = await fastCheckpointState(ledger, document.checkpoint, identity); if (fast) return fast; }
  return auditLedger(ledger, checkpointPath, verifier);
}

/** Read-only SAC facade; all sources are adapters owned by their source module. */
export class FwkReadService {
  constructor(private readonly options: {
    guard: StrictSacGuard;
    authorizationServer: SacAuthorizationServer;
    source: (input: { workspaceId: string; actorContext: TrustedActorContext }) => Promise<FwkSource>;
    canonical: { workspaceRoot: string; configurationRevision: string; policyRef: string; policyRevision: string };
    now?: () => Date;
    verifyReceiptLedger?: LedgerVerifier;
    refreshReceiptCheckpoint?: (checkpointPath: string, body: CheckpointBody) => Promise<void>;
    receiptLockOptions?: { timeoutMs?: number; retryMs?: number; staleMs?: number; heartbeatMs?: number };
  }) {}

  async overview(input: { workspaceId: string; request: unknown; requestCorrelationId: string; budget: { maxItems: number; maxTokens: number }; required?: string[]; optional?: string[] }): Promise<FwkReadResult> {
    return this.resolve(input, "overview");
  }

  /** Progressive, read-only detail operation over a single previously discoverable ID. */
  async read(input: { workspaceId: string; itemId: string; request: unknown; requestCorrelationId: string; budget: { maxItems: number; maxTokens: number } }): Promise<FwkReadResult> {
    return this.resolve({ ...input, required: [input.itemId], optional: [] }, "resource", input.itemId);
  }

  private async resolve(input: { workspaceId: string; request: unknown; requestCorrelationId: string; budget: { maxItems: number; maxTokens: number }; required?: string[]; optional?: string[] }, action: "overview" | "resource", itemId?: string): Promise<FwkReadResult> {
    // Actor identity is intentionally absent from the public payload.  Only a
    // transport-owned authorization server may issue the WeakSet-trusted
    // context carried into source resolution.
    const actor = await this.options.authorizationServer.actorContextFor(input.request, input.requestCorrelationId);
    if (!actor) return this.denied(input.workspaceId, "service:untrusted", input.requestCorrelationId);
    const guard = await evaluateStrictSacGuard({ guard: this.options.guard, operation: "read" });
    if (!guard.allowed) return this.denied(input.workspaceId, actor.subject, input.requestCorrelationId);
    let source: FwkSource;
    try {
      // The source adapter must authorize/revalidate while opening its source,
      // so a role revoked after actor issuance cannot disclose a reference.
      source = await this.options.source({ workspaceId: input.workspaceId, actorContext: actor });
    } catch (error) {
      // Do not turn source existence, cross-workspace, or revoked-role errors
      // into a discovery oracle.  All are represented as the same receipt.
      if (error instanceof WorkspaceServiceError && (error.code === "access_denied" || error.code === "not_found" || error.code === "invalid_reference")) return this.denied(input.workspaceId, actor.subject, input.requestCorrelationId);
      throw error;
    }
    const now = this.options.now ?? (() => new Date());
    const required = new Set(input.required ?? []); const optional = new Set(input.optional ?? []);
    const facts = source.facts.map((fact) => ({ ...fact, freshness: !fact.visible ? "denied" as const : fact.status === "stale" ? "stale" as const : new Date(fact.expiresAt) <= now() ? "expired" as const : "fresh" as const }));
    const knowHow = source.knowHow.map((item) => ({ ...item, status: !item.visible ? "denied" as const : !item.accepted ? "denied" as const : item.status }));
    const work = source.work?.flowRef ? { state: "bound" as const, ...source.work } : { state: "unbound" as const };
    const visibleFacts = facts.filter((fact) => fact.visible);
    const acceptedKnowHow = knowHow.filter((entry) => entry.visible && entry.accepted && entry.status !== "withdrawn" && entry.status !== "denied");
    const withheld = [...facts.filter((fact) => !fact.visible).map((fact) => fact.id), ...knowHow.filter((entry) => !entry.visible || !entry.accepted || entry.status === "withdrawn" || entry.status === "denied").map((entry) => entry.id)];
    const select = <T extends { id: string }>(items: T[]): T[] => itemId ? items.filter((entry) => entry.id === itemId) : items;
    const candidates: ContextCandidate[] = [
      ...select(visibleFacts).map((fact) => ({ id: fact.id, required: required.has(fact.id) || !optional.has(fact.id), tokens: Math.ceil(fact.statement.length / 4) })),
      ...(work.state === "bound" && (!itemId || itemId === "work") ? [{ id: "work", required: required.has("work") || !optional.has("work"), tokens: 32 }] : []),
      ...select(acceptedKnowHow).map((item) => ({ id: item.id, required: required.has(item.id) || !optional.has(item.id), tokens: 16 })),
    ];
    const assembly = await assembleAndRecordContext({ workspaceRoot: this.options.canonical.workspaceRoot, correlationId: input.requestCorrelationId, ...input.budget, candidates, omittedOptional: withheld, configurationRevision: this.options.canonical.configurationRevision, policyRef: this.options.canonical.policyRef, policyRevision: this.options.canonical.policyRevision });
    if ("code" in assembly) return assembly;
    return this.success(input.workspaceId, actor.subject, assembly, facts, work, acceptedKnowHow, now, action, itemId);
  }

  private async success(workspaceId: string, actor: string, assembly: ContextAssembly, facts: Array<FwkEvidence & { freshness: "fresh" | "stale" | "expired" | "denied" }>, work: unknown, knowHow: FwkKnowHow[], now: () => Date, action: "overview" | "resource", resourceId?: string): Promise<FwkResult> {
    const selected = new Set(assembly.selected);
    const selectedFacts = facts.filter((fact) => selected.has(fact.id));
    const selectedKnowHow = knowHow.filter((item) => selected.has(item.id));
    const stale = selectedFacts.some((fact) => fact.freshness !== "fresh") || selectedKnowHow.some((item) => item.status !== "fresh");
    const manifest = { schemaVersion: "1.0" as const, workspaceId, generatedAt: nowIso(now), facts: selectedFacts.map((fact) => ({ statement: fact.statement, evidence: [{ kind: "artifact" as const, uri: fact.uri, revision: fact.revision, observedAt: fact.observedAt, trust: fact.trust }], observedAt: fact.observedAt, expiresAt: fact.expiresAt, freshness: fact.freshness })), work: selected.has("work") ? work : { state: "unbound" }, knowHow: selectedKnowHow.map(({ id, accepted, visible, ...item }) => item), freshness: stale ? "stale" as const : assembly.partial ? "partial" as const : "fresh" as const };
    const fwk = await validateSacContract({ schema: "fwk-receipt", document: manifest });
    if (!fwk.valid) throw new Error(`invalid FWK manifest: ${fwk.errors.map((error) => error.code).join(",")}`);
    const receipt = await this.receipt(workspaceId, actor, stale ? "stale" : "allowed", assembly, now, action, resourceId);
    if (!metadataOnly(receipt)) throw new Error("receipt metadata contract violated");
    const validation = await validateSacContract({ schema: "access-receipt", document: receipt });
    if (!validation.valid) throw new Error(`invalid access receipt: ${validation.errors.map((error) => error.code).join(",")}`);
    return { partial: assembly.partial, omittedOptional: assembly.omittedOptional, manifest, receipt };
  }

  private async denied(workspaceId: string, actor: string, correlationId: string): Promise<FwkResult> {
    const now = this.options.now ?? (() => new Date());
    const assembly = await recordNoContentContext({ workspaceRoot: this.options.canonical.workspaceRoot, correlationId, configurationRevision: this.options.canonical.configurationRevision, policyRef: this.options.canonical.policyRef, policyRevision: this.options.canonical.policyRevision, outcome: "denied" });
    const receipt = await this.receipt(workspaceId, actor, "denied", assembly, now);
    if (!metadataOnly(receipt)) throw new Error("receipt metadata contract violated");
    const validation = await validateSacContract({ schema: "access-receipt", document: receipt });
    if (!validation.valid) throw new Error(`invalid access receipt: ${validation.errors.map((error) => error.code).join(",")}`);
    return { partial: false, omittedOptional: [], manifest: { facts: [], work: { state: "unbound" }, knowHow: [], freshness: "denied" }, receipt };
  }

  private async receipt(workspaceId: string, actor: string, decision: AccessReceipt["decision"], assembly: ContextAssembly, now: () => Date, action: "overview" | "resource" = "overview", resourceId?: string): Promise<AccessReceipt> {
    const recordedAt = nowIso(now); const id = `receipt-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const base = { schemaVersion: "1.0" as const, id, workspaceId, actor, action, decision, recordedAt, cost: { tokens: 0, toolCalls: 1, elapsedMs: 0 }, contextAssembly: { traceRef: assembly.traceRef, configurationRevision: assembly.configurationRevision, selected: assembly.selected.map((id) => `./ids/${id}`), omittedOptional: assembly.omittedOptional.map((id) => `./ids/${id}`) }, policy: { ref: assembly.policyRef, revision: assembly.policyRevision }, ...(action === "resource" ? { resourceRef: `./ids/${resourceId ?? "unknown"}` } : {}) };
    const ledger = path.join(this.options.canonical.workspaceRoot, ".metaproject", "context-operations", "access-receipts.jsonl");
    const checkpointPath = path.join(path.dirname(ledger), "access-receipts.checkpoint.json");
    await mkdir(path.dirname(ledger), { recursive: true, mode: 0o700 });
    return withFileLock(`${ledger}.lock`, async () => {
      const state = await resolveLedgerState(ledger, checkpointPath, this.options.verifyReceiptLedger ?? verifyAccessReceiptLedger);
      const receipt = sealAccessReceipt(base, state.headHash) as AccessReceipt;
      if (!metadataOnly(receipt)) throw new Error("receipt metadata contract violated");
      const validation = await validateSacContract({ schema: "access-receipt", document: receipt });
      if (!validation.valid) throw new Error(`invalid access receipt: ${validation.errors.map((error) => error.code).join(",")}`);
      await appendFile(ledger, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
      try {
        const identity = await ledgerIdentity(ledger);
        await (this.options.refreshReceiptCheckpoint ?? writeCheckpoint)(checkpointPath, {
          schemaVersion: "1.0", ...identity, recordCount: state.recordCount + 1,
          headHash: receipt.integrity.recordHash, tailOffset: state.identity.ledgerBytes,
        });
      } catch {
        // The ledger append is the commit point. A checkpoint is only a bounded
        // verification cache, so invalidate it and rebuild under the next lock.
        await rm(checkpointPath, { force: true }).catch(() => undefined);
      }
      return receipt;
    }, this.options.receiptLockOptions);
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
        const raw = await workspaces.readResourceForActor({ actorContext, workspaceId, resource }) as Buffer;
        const revision = createHash("sha256").update(raw).digest("hex");
        return { id: `fact-${index}`, uri: resource.uri, revision: resource.revision ?? revision, observedAt: manifest.updatedAt, expiresAt: "9999-12-31T23:59:59Z", trust: "primary" as const, visible: true, statement: `Evidence reference ${resource.uri}`, status: resource.revision === revision || resource.revision === undefined ? "fresh" as const : "stale" as const };
      }));
      const knowHow = await Promise.all(manifest.resources.filter((resource) => resource.kind === "wiki" || resource.kind === "memory" || resource.kind === "skill").map(async (resource, index) => {
        const raw = await workspaces.readResourceForActor({ actorContext, workspaceId, resource, encoding: "utf8" }) as string;
        const revision = createHash("sha256").update(raw).digest("hex");
        const accepted = /^Status:\s*(accepted|reviewed)\s*$/mi.test(raw);
        return { id: `knowhow-${index}`, kind: resource.kind as "wiki" | "memory" | "skill", uri: resource.uri, revision: resource.revision ?? revision, trust: "accepted" as const, status: resource.revision === revision || resource.revision === undefined ? "fresh" as const : "stale" as const, accepted, visible: true };
      }));
      const work = flow ? await (async () => {
        const raw = await workspaces.readResourceForActor({ actorContext, workspaceId, resource: flow, encoding: "utf8" }) as string;
        const snapshot = JSON.parse(raw) as { id?: string; status?: string; updatedAt?: string; tasks?: Array<{ id: string; status: string }> };
        if (!snapshot.id || !snapshot.status || !snapshot.updatedAt || !Array.isArray(snapshot.tasks)) return undefined;
        return { flowRef: { uri: flow.uri, snapshot: snapshot.status, revision: snapshot.updatedAt }, completed: snapshot.tasks.filter((task) => task.status === "done").map((task) => task.id), next: snapshot.tasks.filter((task) => task.status !== "done").map((task) => task.id), blocked: snapshot.status === "blocked" ? [snapshot.id] : [] };
      })() : undefined;
      return {
        facts: facts.filter((entry): entry is NonNullable<typeof entry> => entry !== undefined),
        ...(work ? { work } : {}),
        knowHow: knowHow.filter((entry): entry is NonNullable<typeof entry> => entry !== undefined),
      };
    },
    canonical: { workspaceRoot: cwd, configurationRevision: "context-operations-v1", policyRef: "./security/policy/local", policyRevision: "local-offline-v1" },
  });
}

/** The only transport serialization contract used by both CLI and MCP. */
export function normalizeFwkResult(result: FwkReadResult): FwkReadResult { return JSON.parse(JSON.stringify(result)) as FwkReadResult; }
