import { mkdir, readdir, readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { isNotFound, withFileLock, writeFileAtomic } from "../lib/fs";
import { readWorkspaceFileNoFollow } from "./secure-resource-read";
import {
  authorizeSacUse,
  createSacAuthorizationServer,
  evaluateStrictSacGuard,
  isTrustedActorContext,
  isWorkspaceOwner,
  resolveWorkspaceReference,
  validateSacContract,
  type SacAuthorizationServer,
  type StrictSacGuard,
  type TrustedActorContext,
  type WorkspaceReferenceKind,
} from "./index";

export type WorkspaceMember = { subject: string; role: "owner" | "editor" | "viewer" };
export type WorkspaceResource = { kind: Extract<WorkspaceReferenceKind, "component" | "repository" | "flow" | "wiki" | "memory" | "skill" | "evidence" | "worktree" | "session">; uri: string; revision?: string };
export type WorkspaceManifest = {
  schemaVersion: "1.0";
  id: string;
  title: string;
  status: "active" | "archived";
  members: WorkspaceMember[];
  resources: WorkspaceResource[];
  createdAt: string;
  updatedAt: string;
};

/**
 * What one declared reference answers RIGHT NOW, as opposed to what the
 * manifest claims it points at.
 *
 * `unverifiable` is deliberately its own state and is never folded into either
 * `resolved` or `changed`: "the target is there and is byte-identical to what
 * was pinned", "the target is there and is NOT what was pinned", and "the
 * target is there but nothing was pinned, so I cannot tell" are three different
 * answers, and collapsing the third into the first is exactly the substitution
 * hole this report exists to expose.
 */
export type WorkspaceReferenceState = "resolved" | "unresolvable" | "changed" | "unverifiable";
export type WorkspaceReferenceStatus = Readonly<{
  kind: WorkspaceResource["kind"];
  uri: string;
  state: WorkspaceReferenceState;
  detail: string;
  /** The revision recorded on the manifest resource, when it has one. */
  pinnedRevision?: string;
  /** sha256 of the target's current bytes, when they could be read. */
  observedRevision?: string;
}>;
/**
 * Every reference's current answer, computed at read time and reported
 * alongside the manifest instead of deciding whether the manifest is disclosed
 * at all. A workspace with a dangling reference is still a workspace; hiding it
 * makes it indistinguishable from one that never existed.
 */
export type WorkspaceReferenceReport = Readonly<{
  /** True only when every reference resolved AND matched its pinned revision. */
  ok: boolean;
  resources: readonly WorkspaceReferenceStatus[];
  unresolvable: readonly string[];
  changed: readonly string[];
  unverifiable: readonly string[];
}>;
export type WorkspaceView = Readonly<{ manifest: WorkspaceManifest; references: WorkspaceReferenceReport }>;

/** A revision that is a sha256 content digest — the only kind that can prove a target did not change. */
const CONTENT_DIGEST_PATTERN = /^[a-f0-9]{64}$/;

type WorkspaceServiceOptions = {
  workspaceRoot: string;
  storageRoot?: string;
  authorizationServer: SacAuthorizationServer;
  strictGuard: StrictSacGuard;
  now?: () => Date;
  /** Test seam: runs after authorization/containment but before the safe FD open. */
  beforeResourceOpen?: () => Promise<void> | void;
};

export class WorkspaceServiceError extends Error {
  constructor(readonly code: "access_denied" | "guard_denied" | "invalid_manifest" | "invalid_reference" | "not_found" | "write_failed" | "conflict", message: string) {
    super(message);
  }
}

/** Offline-only owner of SAC's one primary record: workspace.json. */
export class WorkspaceService {
  private readonly root: string;
  private readonly storageRoot: string;
  private readonly now: () => Date;

  constructor(private readonly options: WorkspaceServiceOptions) {
    this.root = path.resolve(options.workspaceRoot);
    this.storageRoot = path.resolve(options.storageRoot ?? path.join(this.root, ".metaproject", "workspaces"));
    this.now = options.now ?? (() => new Date());
  }

  async create(input: { request: unknown; requestCorrelationId: string; id: string; title: string; component?: WorkspaceResource }): Promise<WorkspaceManifest> {
    const actor = await this.requireActor(input.request, input.requestCorrelationId);
    await this.requireStrict("write");
    const manifest: WorkspaceManifest = {
      schemaVersion: "1.0", id: input.id, title: input.title, status: "active",
      members: [{ subject: actor.subject, role: "owner" }], resources: input.component ? [input.component] : [],
      createdAt: this.timestamp(), updatedAt: this.timestamp(),
    };
    // Shape first (an escaping/malformed uri is `invalid_manifest`), then the
    // component reference is RESOLVED and pinned here rather than inside
    // `validateManifest`: `validateManifest` no longer resolves every declared
    // reference, because a workspace whose target was deleted after the fact
    // must still be readable and writable — see `readManifest`. Add-time
    // resolution is a real guard and stays; read-time resolution was a
    // disclosure decision, and it is gone.
    await this.validateManifest(manifest);
    if (input.component) manifest.resources = [await this.pinResource(input.component)];
    const dir = this.workspaceDir(manifest.id);
    await mkdir(this.storageRoot, { recursive: true, mode: 0o700 });
    await withFileLock(this.lockPath(manifest.id), async () => {
      try {
        await readFile(this.manifestPath(manifest.id), "utf8");
        throw new WorkspaceServiceError("conflict", "workspace already exists");
      } catch (error) {
        if (error instanceof WorkspaceServiceError || !isNotFound(error)) throw error;
      }
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFileAtomic(this.manifestPath(manifest.id), `${JSON.stringify(manifest, null, 2)}\n`);
    });
    return manifest;
  }

  async list(input: { request: unknown; requestCorrelationId: string; includeArchived?: boolean }): Promise<WorkspaceManifest[]> {
    const actor = await this.requireActor(input.request, input.requestCorrelationId);
    await this.requireStrict("read");
    return this.enumerateVisible(actor, input.includeArchived);
  }

  /**
   * `listForActor` mirror of `list()` for a caller that already holds a
   * trusted, previously-issued `TrustedActorContext` and does not need (or
   * want) `requireActor`'s own `request` re-authentication — same shape as
   * `showForActor` vs. `show()`. Reuses `enumerateVisible`, the exact same
   * enumerate-storageRoot + parse-manifest + `currentRole` visibility filter
   * `list()` itself runs, so the two can never silently drift apart (plan.md
   * Risks: "listForActor visibility drift from list()").
   */
  async listForActor(input: { actorContext: TrustedActorContext; includeArchived?: boolean }): Promise<WorkspaceManifest[]> {
    await this.requireStrict("read");
    // Flow 165 fix (finding A): unlike every other actor-accepting method on
    // this class, `listForActor` receives an already-issued `TrustedActorContext`
    // with no separate `requireAuthorization`/`authorizeSacUse` call downstream
    // to catch an untrusted, merely object-shaped caller — verify trust here,
    // before it is ever used for visibility filtering.
    if (!isTrustedActorContext(input.actorContext)) throw new WorkspaceServiceError("access_denied", "untrusted actor");
    return this.enumerateVisible(input.actorContext, input.includeArchived);
  }

  /** Shared enumerate+filter loop behind both `list()` and `listForActor()`. */
  private async enumerateVisible(actor: TrustedActorContext, includeArchived?: boolean): Promise<WorkspaceManifest[]> {
    try { await mkdir(this.storageRoot, { recursive: true, mode: 0o700 }); } catch { return []; }
    const entries = await readdir(this.storageRoot, { withFileTypes: true });
    const visible: WorkspaceManifest[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const manifest = await this.readManifest(entry.name);
        const role = currentRole(manifest, actor.subject);
        if (role && (includeArchived === true || manifest.status !== "archived")) visible.push(manifest);
      } catch { /* corrupt or inaccessible workspaces are never disclosed by discovery */ }
    }
    return visible.sort((left, right) => left.id.localeCompare(right.id));
  }

  async show(input: { request: unknown; requestCorrelationId: string; workspaceId: string }): Promise<WorkspaceManifest> {
    const actor = await this.requireActor(input.request, input.requestCorrelationId);
    return this.showForActor({ actorContext: actor, workspaceId: input.workspaceId });
  }

  /**
   * In-process SAC readers receive this only after their transport boundary has
   * issued a TrustedActorContext.  The trust marker is verified again by
   * requireAuthorization; a structurally similar client object cannot pass.
   */
  async showForActor(input: { actorContext: TrustedActorContext; workspaceId: string }): Promise<WorkspaceManifest> {
    await this.requireStrict("read");
    const initial = await this.readManifest(input.workspaceId);
    const authorization = await this.requireAuthorization(input.actorContext, initial.id, "read");
    // Re-read and re-authorize at the source-use point.  This is deliberately
    // adjacent to returning the manifest to a resolver, rather than trusting a
    // role snapshot captured at the transport boundary.
    const manifest = await this.readManifest(input.workspaceId);
    const atUse = await authorization.authorizeAtUse(async () => currentRoleOrRevoked(manifest, input.actorContext.subject));
    if (!atUse.allowed) throw new WorkspaceServiceError("access_denied", atUse.code);
    return manifest;
  }

  /**
   * Executes a SAC-owned lifecycle operation while the workspace ACL is held
   * stable by the same lock used for manifest writes.  The caller receives the
   * manifest only after trusted-actor authorization has been rechecked at use;
   * it cannot turn the manifest into a client supplied capability.
   */
  async withAuthorizedActor<T>(input: { actorContext: TrustedActorContext; workspaceId: string; action: "write" | "review"; execute: (manifest: WorkspaceManifest) => Promise<T> }): Promise<T> {
    await this.requireStrict("write");
    const initial = await this.readManifest(input.workspaceId);
    const authorization = await this.requireAuthorization(input.actorContext, initial.id, input.action);
    return withFileLock(this.lockPath(input.workspaceId), async () => {
      const manifest = await this.readManifest(input.workspaceId);
      // Reuses `manifest`, just read under this exclusive lock, for the
      // at-use role check below instead of re-reading. `withFileLock`
      // (src/lib/fs.ts) is a cross-process mkdir-based exclusive lock, so no
      // writer can race between this read and the check — a second read here
      // would return byte-identical content, not fresher data. This is unlike
      // `reauthorizeAtUse`/`resolveResourceForActor`, which deliberately
      // re-read because they run with no lock held.
      const atUse = await authorization.authorizeAtUse(async () => currentRoleOrRevoked(manifest, input.actorContext.subject));
      if (!atUse.allowed) throw new WorkspaceServiceError("access_denied", atUse.code);
      return input.execute(manifest);
    });
  }

  /** Re-checks the trusted actor and current role at a guarded owner-use point. */
  async reauthorizeAtUse(input: { actorContext: TrustedActorContext; workspaceId: string; action: "write" | "review" }): Promise<WorkspaceManifest> {
    await this.requireStrict("write");
    const initial = await this.readManifest(input.workspaceId);
    const authorization = await this.requireAuthorization(input.actorContext, initial.id, input.action);
    const manifest = await this.readManifest(input.workspaceId);
    const atUse = await authorization.authorizeAtUse(async () => currentRoleOrRevoked(await this.readManifest(input.workspaceId), input.actorContext.subject));
    if (!atUse.allowed) throw new WorkspaceServiceError("access_denied", atUse.code);
    return manifest;
  }

  /** Owner-use evidence gate: ACL and FD-safe source bytes are obtained together. */
  async readEvidenceAtUse(input: { actorContext: TrustedActorContext; workspaceId: string; uri: string }): Promise<Buffer> {
    await this.reauthorizeAtUse({ actorContext: input.actorContext, workspaceId: input.workspaceId, action: "review" });
    let absolutePath: string;
    try { absolutePath = await resolveWorkspaceReference({ workspaceRoot: this.root, kind: "evidence", uri: input.uri }); }
    catch (error) { throw new WorkspaceServiceError("invalid_reference", error instanceof Error ? error.message : "unsafe evidence reference"); }
    try { return readWorkspaceFileNoFollow(this.root, absolutePath); }
    catch (error) { throw new WorkspaceServiceError("invalid_reference", error instanceof Error ? error.message : "safe evidence open failed"); }
  }

  /**
   * Re-authorize and realpath-resolve immediately before a SAC resolver opens
   * a source target.  A previously returned manifest is never an authority to
   * disclose a later resource path.
   */
  async resolveResourceForActor(input: { actorContext: TrustedActorContext; workspaceId: string; resource: WorkspaceResource }): Promise<WorkspaceResource & { absolutePath: string }> {
    await this.requireStrict("read");
    const initial = await this.readManifest(input.workspaceId);
    const authorization = await this.requireAuthorization(input.actorContext, initial.id, "read");
    const manifest = await this.readManifest(input.workspaceId);
    const atUse = await authorization.authorizeAtUse(async () => currentRoleOrRevoked(await this.readManifest(input.workspaceId), input.actorContext.subject));
    if (!atUse.allowed) throw new WorkspaceServiceError("access_denied", atUse.code);
    const resource = manifest.resources.find((candidate) => candidate.kind === input.resource.kind && candidate.uri === input.resource.uri && candidate.revision === input.resource.revision);
    if (!resource) throw new WorkspaceServiceError("not_found", "workspace resource is no longer available");
    try {
      const absolutePath = await resolveWorkspaceReference({ workspaceRoot: this.root, kind: resource.kind, uri: resource.uri });
      return { ...resource, absolutePath };
    } catch (error) {
      throw new WorkspaceServiceError("invalid_reference", error instanceof Error ? error.message : "unsafe workspace reference");
    }
  }

  /**
   * The only source-content boundary for local SAC resolvers.  It revalidates
   * ACL and containment immediately before opening, then walks every parent
   * directory via descriptor-relative O_NOFOLLOW opens. Reads are from the
   * final descriptor, so neither intermediate nor final swaps can redirect
   * disclosed content.
   */
  async readResourceForActor(input: { actorContext: TrustedActorContext; workspaceId: string; resource: WorkspaceResource; encoding?: BufferEncoding }): Promise<Buffer | string> {
    await this.resolveResourceForActor(input);
    await this.options.beforeResourceOpen?.();
    // Revalidate the actual target immediately before FD acquisition. The
    // descriptor-relative walk below closes both intermediate and final swaps.
    const target = await this.resolveResourceForActor(input);
    try {
      const content = readWorkspaceFileNoFollow(this.root, target.absolutePath);
      return input.encoding ? content.toString(input.encoding) : content;
    } catch (error) {
      throw new WorkspaceServiceError("invalid_reference", error instanceof Error ? error.message : "safe source open failed");
    }
  }

  async addResource(input: { request: unknown; requestCorrelationId: string; workspaceId: string; resource: WorkspaceResource }): Promise<WorkspaceManifest> {
    const actor = await this.requireActor(input.request, input.requestCorrelationId);
    await this.requireStrict("write");
    await this.validateResource(input.resource);
    // A reference with no revision cannot tell later that its target was
    // swapped for something else at the same path, so one is captured now, from
    // the bytes the caller is actually pointing at. Same content-digest pinning
    // `proposal-lifecycle.ts` uses for owner-write evidence (`hash(content)`
    // compared in `isEvidenceFresh`), and the same digest `fwk-service.ts`
    // already recomputes to decide `fresh` vs `stale` — not a second mechanism.
    const resource = await this.pinResource(input.resource);
    const initial = await this.readManifest(input.workspaceId);
    const authorization = await this.requireAuthorization(actor, initial.id, "write");
    let result: WorkspaceManifest | undefined;
    await withFileLock(this.lockPath(input.workspaceId), async () => {
      const manifest = await this.readManifest(input.workspaceId);
      const atUse = await authorization.authorizeAtUse(async () => currentRoleOrRevoked(manifest, actor.subject));
      if (!atUse.allowed) throw new WorkspaceServiceError("access_denied", atUse.code);
      // KNOWN RISK: this archived-status guard is deliberately NOT part of
      // `withAuthorizedActor`/`requireAuthorization` — `review()` in
      // proposal-lifecycle.ts must stay ungated on archived status (frozen by
      // spec: docs/requirements/sac-workspace-lifecycle/specification.md
      // WSL-1), and `rename`/`removeResource` also route through
      // `withAuthorizedActor` without this check today. Centralizing risks
      // silently gating one of those. The identical inline check lives in
      // proposal-lifecycle.ts's `create()` — any new write operation that
      // should reject on an archived workspace must add this check itself.
      if (manifest.status === "archived") throw new WorkspaceServiceError("guard_denied", "workspace is archived");
      if (manifest.resources.some((candidate) => candidate.uri === input.resource.uri)) throw new WorkspaceServiceError("conflict", "resource already exists");
      const next: WorkspaceManifest = { ...manifest, resources: [...manifest.resources, resource], updatedAt: this.timestamp() };
      await this.validateManifest(next);
      await writeFileAtomic(this.manifestPath(input.workspaceId), `${JSON.stringify(next, null, 2)}\n`);
      result = next;
    });
    return result!;
  }

  /**
   * Owner-only: sets status to "archived". Archive changes discovery (list),
   * never direct read (show).
   *
   * Deliberately idempotent: archiving an already-archived workspace succeeds
   * again rather than raising `conflict`. This is the literal implementation
   * `docs/requirements/sac-workspace-lifecycle/specification.md` (WSL-1)
   * prescribes — `{...manifest, status: "archived", updatedAt: ...}` with no
   * precondition on the prior status — and it matches archive's one-way
   * `active -> archived` lifecycle (no delete, no un-archive): re-issuing the
   * same terminal state is a no-op in effect, unlike `addResource`'s
   * `conflict` on a duplicate URI, where a second call would silently discard
   * the caller's `revision` field. `updatedAt` moving on a repeat call is an
   * accepted, intentional side effect of that same "just set the field"
   * design — the operation is idempotent in *outcome* (workspace ends up
   * archived), not byte-identical on repeat.
   */
  async archive(input: { request: unknown; requestCorrelationId: string; workspaceId: string }): Promise<WorkspaceManifest> {
    const actor = await this.requireActor(input.request, input.requestCorrelationId);
    return this.withAuthorizedActor({
      actorContext: actor,
      workspaceId: input.workspaceId,
      action: "write",
      execute: async (manifest) => {
        this.requireOwner(manifest, actor);
        const next: WorkspaceManifest = { ...manifest, status: "archived", updatedAt: this.timestamp() };
        await this.validateManifest(next);
        await writeFileAtomic(this.manifestPath(input.workspaceId), `${JSON.stringify(next, null, 2)}\n`);
        return next;
      },
    });
  }

  /** Owner-only: sets title. No other field is touched besides updatedAt. */
  async rename(input: { request: unknown; requestCorrelationId: string; workspaceId: string; title: string }): Promise<WorkspaceManifest> {
    const actor = await this.requireActor(input.request, input.requestCorrelationId);
    return this.withAuthorizedActor({
      actorContext: actor,
      workspaceId: input.workspaceId,
      action: "write",
      execute: async (manifest) => {
        this.requireOwner(manifest, actor);
        const next: WorkspaceManifest = { ...manifest, title: input.title, updatedAt: this.timestamp() };
        await this.validateManifest(next);
        await writeFileAtomic(this.manifestPath(input.workspaceId), `${JSON.stringify(next, null, 2)}\n`);
        return next;
      },
    });
  }

  /** Owner-only mirror of addResource's write mechanics: not_found if the uri is absent, otherwise filters it out of resources[]. */
  async removeResource(input: { request: unknown; requestCorrelationId: string; workspaceId: string; uri: string }): Promise<WorkspaceManifest> {
    const actor = await this.requireActor(input.request, input.requestCorrelationId);
    return this.withAuthorizedActor({
      actorContext: actor,
      workspaceId: input.workspaceId,
      action: "write",
      execute: async (manifest) => {
        this.requireOwner(manifest, actor);
        const resource = manifest.resources.find((candidate) => candidate.uri === input.uri);
        if (!resource) throw new WorkspaceServiceError("not_found", "workspace resource not found");
        const next: WorkspaceManifest = { ...manifest, resources: manifest.resources.filter((candidate) => candidate.uri !== input.uri), updatedAt: this.timestamp() };
        await this.validateManifest(next);
        await writeFileAtomic(this.manifestPath(input.workspaceId), `${JSON.stringify(next, null, 2)}\n`);
        return next;
      },
    });
  }

  /** Local owner-only gate — shares `isWorkspaceOwner` with collaboration-service.ts's record(). Not a change to authorizeSacUse. */
  private requireOwner(manifest: WorkspaceManifest, actor: TrustedActorContext): void {
    if (!isWorkspaceOwner(manifest.members, actor.subject)) {
      throw new WorkspaceServiceError("access_denied", "owner authority is required");
    }
  }

  private async requireActor(request: unknown, correlationId: string): Promise<TrustedActorContext> {
    const actor = await this.options.authorizationServer.actorContextFor(request, correlationId);
    if (!actor) throw new WorkspaceServiceError("access_denied", "trusted ActorContext is required");
    return actor;
  }

  private async requireStrict(operation: "read" | "write"): Promise<void> {
    const decision = await evaluateStrictSacGuard({ guard: this.options.strictGuard, operation });
    if (!decision.allowed) throw new WorkspaceServiceError("guard_denied", "strict SAC guard denied operation");
  }

  private async requireAuthorization(actor: TrustedActorContext, workspaceId: string, action: "read" | "write" | "review") {
    const authorization = await authorizeSacUse({ actorContext: actor, workspaceId, action, resolveCurrentRole: async (subject, id) => currentRoleOrRevoked(await this.readManifest(id), subject) });
    if (!authorization.allowed) throw new WorkspaceServiceError("access_denied", authorization.code);
    return authorization;
  }

  /**
   * The current answer of every declared reference, reported NEXT TO the
   * manifest rather than deciding whether the manifest is disclosed at all.
   *
   * Takes an already-obtained manifest on purpose: every path that can hand a
   * caller one (`show`/`showForActor`/`list`/`listForActor`) has already run
   * the ACL gate, so this adds no new disclosure — it only names, for a record
   * the caller may already see, which of its references still answer.
   */
  async describeReferences(manifest: WorkspaceManifest): Promise<WorkspaceReferenceReport> {
    const resources: WorkspaceReferenceStatus[] = [];
    for (const resource of manifest.resources) resources.push(await this.describeReference(resource));
    const withState = (state: WorkspaceReferenceState): string[] => resources.filter((entry) => entry.state === state).map((entry) => entry.uri);
    const unresolvable = withState("unresolvable");
    const changed = withState("changed");
    return Object.freeze({
      ok: unresolvable.length === 0 && changed.length === 0,
      resources: Object.freeze(resources),
      unresolvable: Object.freeze(unresolvable),
      changed: Object.freeze(changed),
      // Never folded into `ok`'s two lists: "I cannot tell" is its own answer.
      unverifiable: Object.freeze(withState("unverifiable")),
    });
  }

  private async describeReference(resource: WorkspaceResource): Promise<WorkspaceReferenceStatus> {
    const base = { kind: resource.kind, uri: resource.uri, ...(resource.revision === undefined ? {} : { pinnedRevision: resource.revision }) };
    let absolutePath: string;
    try { absolutePath = await resolveWorkspaceReference({ workspaceRoot: this.root, kind: resource.kind, uri: resource.uri }); }
    catch (error) { return Object.freeze({ ...base, state: "unresolvable" as const, detail: error instanceof Error ? error.message : "workspace reference is not resolvable" }); }
    const observedRevision = this.contentDigest(absolutePath);
    if (observedRevision === undefined) return Object.freeze({ ...base, state: "unverifiable" as const, detail: "target resolves but its bytes cannot be read, so its content cannot be checked" });
    if (resource.revision === undefined) return Object.freeze({ ...base, state: "unverifiable" as const, observedRevision, detail: "reference carries no pinned revision, so a substituted target cannot be detected" });
    if (!CONTENT_DIGEST_PATTERN.test(resource.revision)) return Object.freeze({ ...base, state: "unverifiable" as const, observedRevision, detail: "pinned revision is a caller-supplied label, not a content digest, so it cannot prove the target is unchanged" });
    if (resource.revision !== observedRevision) return Object.freeze({ ...base, state: "changed" as const, observedRevision, detail: "target content no longer matches the revision pinned when this reference was added" });
    return Object.freeze({ ...base, state: "resolved" as const, observedRevision, detail: "target resolves and still matches its pinned revision" });
  }

  /** sha256 over the target's current bytes, or undefined when they cannot be read at all. */
  private contentDigest(absolutePath: string): string | undefined {
    try { return createHash("sha256").update(readWorkspaceFileNoFollow(this.root, absolutePath)).digest("hex"); }
    catch { return undefined; }
  }

  /** Attaches a content digest to a reference that carries no revision of its own. */
  private async pinResource(resource: WorkspaceResource): Promise<WorkspaceResource> {
    if (resource.revision !== undefined) return resource;
    let absolutePath: string;
    try { absolutePath = await resolveWorkspaceReference({ workspaceRoot: this.root, kind: resource.kind, uri: resource.uri }); }
    catch { return resource; }
    const revision = this.contentDigest(absolutePath);
    // A directory, an oversized file, or anything else unreadable stays
    // unpinned rather than being pinned to a made-up value — `describeReferences`
    // then reports it as `unverifiable`, which is the truth.
    return revision === undefined ? resource : { ...resource, revision };
  }

  private async validateManifest(manifest: WorkspaceManifest): Promise<void> {
    const contract = await validateSacContract({ schema: "workspace-manifest", document: manifest });
    if (!contract.valid) throw new WorkspaceServiceError("invalid_manifest", contract.errors.map((entry) => entry.code).join(", "));
  }

  private async validateResource(resource: WorkspaceResource): Promise<void> {
    try { await resolveWorkspaceReference({ workspaceRoot: this.root, kind: resource.kind, uri: resource.uri }); }
    catch (error) { throw new WorkspaceServiceError("invalid_reference", error instanceof Error ? error.message : "unsafe workspace reference"); }
  }

  /**
   * Reads the workspace RECORD. It no longer resolves the record's references.
   *
   * It used to: every read re-resolved every declared resource and threw
   * `invalid_reference` if any target was gone. One deleted wiki page therefore
   * removed the whole workspace from `list()` (swallowed by
   * `enumerateVisible`'s catch) and turned `show()` into an error — a workspace
   * that exists, is `active`, and has other readable resources became
   * indistinguishable from one that never existed, and even
   * `removeResource` could not be used to clear the dangling entry, because
   * this read ran first. Reference resolution is now reported by
   * `describeReferences`, next to the record, instead of deciding whether the
   * record is disclosed at all.
   */
  private async readManifest(id: string): Promise<WorkspaceManifest> {
    if (!/^[a-z][a-z0-9-]{2,63}$/.test(id)) throw new WorkspaceServiceError("not_found", "workspace not found");
    let parsed: unknown;
    try { parsed = JSON.parse(await readFile(this.manifestPath(id), "utf8")); }
    catch (error) { if (isNotFound(error)) throw new WorkspaceServiceError("not_found", "workspace not found"); throw new WorkspaceServiceError("invalid_manifest", "workspace manifest cannot be read"); }
    const contract = await validateSacContract({ schema: "workspace-manifest", document: parsed });
    if (!contract.valid) throw new WorkspaceServiceError("invalid_manifest", contract.errors.map((entry) => entry.code).join(", "));
    return parsed as WorkspaceManifest;
  }

  private workspaceDir(id: string): string { return path.join(this.storageRoot, id); }
  private manifestPath(id: string): string { return path.join(this.workspaceDir(id), "workspace.json"); }
  private lockPath(id: string): string { return path.join(this.storageRoot, `.${id}.lock`); }
  private timestamp(): string { return this.now().toISOString(); }
}

function currentRole(manifest: WorkspaceManifest, subject: string): { role: "owner" | "editor" | "viewer"; revision: string; workspaceId: string } | undefined {
  const member = manifest.members.find((candidate) => candidate.subject === subject);
  return member ? { role: member.role, revision: `${manifest.updatedAt}:${manifest.members.map((entry) => `${entry.subject}:${entry.role}`).join(",")}`, workspaceId: manifest.id } : undefined;
}
function currentRoleOrRevoked(manifest: WorkspaceManifest, subject: string) {
  return currentRole(manifest, subject) ?? { role: "revoked" as const, revision: `${manifest.updatedAt}:absent`, workspaceId: manifest.id };
}
export function localWorkspaceAuthorizationServer(subject = `user:local-${process.getuid?.() ?? process.pid}`): SacAuthorizationServer {
  // This function is intentionally the local CLI composition boundary. It
  // reads no caller-supplied subject/role and exports no client minting path.
  return createSacAuthorizationServer({ authenticateRequest: async () => ({ subject, authenticationMethod: "local-os", roleRevision: "local-os-v1" }) });
}

export function newWorkspaceId(): string { return `workspace-${randomUUID().replace(/-/g, "").slice(0, 16)}`; }

/**
 * The named outcomes of asking one surface for one workspace.
 *
 * `not-found`, `access-denied` and `unreadable` are separate on purpose: "it
 * never existed", "it exists and is not yours", and "it exists and I cannot
 * parse it" are three different answers, and a surface that renders all three
 * as an empty result is the defect this lane exists to close. Note that a
 * DANGLING REFERENCE is not on this list at all — that is a `workspace`
 * outcome whose `references` report names what failed.
 */
export type WorkspaceLookup =
  | (WorkspaceView & { outcome: "workspace" })
  | Readonly<{ outcome: "not-found" | "access-denied" | "unreadable" | "guard-denied"; workspaceId: string; detail: string }>;

const LOOKUP_OUTCOME: Record<WorkspaceServiceError["code"], Exclude<WorkspaceLookup["outcome"], "workspace">> = {
  not_found: "not-found",
  access_denied: "access-denied",
  invalid_manifest: "unreadable",
  invalid_reference: "unreadable",
  guard_denied: "guard-denied",
  write_failed: "unreadable",
  conflict: "unreadable",
};

/**
 * The ONE lookup both `keryx workspace show` and MCP `sac.workspaceShow` run,
 * so the two surfaces cannot answer the same question differently at the same
 * moment. It never throws: a missing workspace is an ordinary named outcome,
 * not an exception whose stack trace (absolute source paths included) becomes
 * the answer a tool caller sees.
 */
export async function lookupWorkspace(service: WorkspaceService, workspaceId: string): Promise<WorkspaceLookup> {
  try {
    const manifest = await service.show({ request: undefined, requestCorrelationId: randomUUID(), workspaceId });
    return Object.freeze({ outcome: "workspace" as const, manifest, references: await service.describeReferences(manifest) });
  } catch (error) {
    if (error instanceof WorkspaceServiceError) return Object.freeze({ outcome: LOOKUP_OUTCOME[error.code], workspaceId, detail: error.message });
    return Object.freeze({ outcome: "unreadable" as const, workspaceId, detail: error instanceof Error ? error.message : "workspace could not be read" });
  }
}

/**
 * The ONE listing both `keryx workspace list` and MCP `sac.workspaceList` run.
 * Each entry carries its own reference report, so a workspace with a dangling
 * reference appears in the list — named as damaged — instead of vanishing from
 * it.
 */
export async function listWorkspaceViews(service: WorkspaceService, includeArchived: boolean): Promise<WorkspaceView[]> {
  const manifests = await service.list({ request: undefined, requestCorrelationId: randomUUID(), includeArchived });
  const views: WorkspaceView[] = [];
  for (const manifest of manifests) views.push(Object.freeze({ manifest, references: await service.describeReferences(manifest) }));
  return views;
}

/**
 * SLATE-15 shared fail-closed `--workspace` validation (AC1): the SAME helper
 * `/goal` (`commands/goal-command.ts`) and `keryx harness run --workspace`
 * (`commands/harness.ts`) both reuse, so a bad/invisible workspace id is
 * rejected identically in both places rather than two independently-drifting
 * checks. Constructs its OWN `WorkspaceService` per call — the exact
 * construction `commands/workspace.ts`'s `service()` factory already uses
 * (`workspaceRoot: cwd`, `localWorkspaceAuthorizationServer()`, the same
 * `strictGuard` literal) — and calls `.show()`, never `.create()`, so this
 * helper can never itself cause AC2's "omitting --workspace never creates a
 * workspace" guarantee to be violated by a caller that always calls it.
 *
 * NEVER throws: every failure (not_found, access_denied, guard_denied, or any
 * other thrown error) is folded into `{ok: false, error}` so a fail-closed
 * caller can check `.ok` without its own try/catch, and — critically for
 * AC1's ordering — before doing anything else, including opening a slate.
 */
export async function resolveWorkspaceForActor(
  cwd: string,
  workspaceId: string,
): Promise<{ ok: true; manifest: WorkspaceManifest } | { ok: false; error: WorkspaceServiceError }> {
  const service = new WorkspaceService({
    workspaceRoot: cwd,
    authorizationServer: localWorkspaceAuthorizationServer(),
    strictGuard: { mode: "strict", availability: "available", decision: "pass", policyRevision: "local-offline-v1" },
  });
  try {
    const manifest = await service.show({ request: undefined, requestCorrelationId: randomUUID(), workspaceId });
    return { ok: true, manifest };
  } catch (error) {
    if (error instanceof WorkspaceServiceError) {
      return { ok: false, error };
    }
    return {
      ok: false,
      error: new WorkspaceServiceError(
        "not_found",
        error instanceof Error ? error.message : "workspace could not be resolved",
      ),
    };
  }
}
