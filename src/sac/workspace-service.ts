import { mkdir, readdir, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { withFileLock, writeFileAtomic } from "../lib/fs";
import { readWorkspaceFileNoFollow } from "./secure-resource-read";
import {
  authorizeSacUse,
  createSacAuthorizationServer,
  evaluateStrictSacGuard,
  resolveWorkspaceReference,
  validateSacContract,
  type SacAuthorizationServer,
  type StrictSacGuard,
  type TrustedActorContext,
  type WorkspaceReferenceKind,
} from "./index";

export type WorkspaceMember = { subject: string; role: "owner" | "editor" | "viewer" };
export type WorkspaceResource = { kind: Extract<WorkspaceReferenceKind, "component" | "repository" | "flow" | "wiki" | "memory" | "skill" | "evidence" | "worktree">; uri: string; revision?: string };
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
    await this.validateManifest(manifest);
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

  async list(input: { request: unknown; requestCorrelationId: string }): Promise<WorkspaceManifest[]> {
    const actor = await this.requireActor(input.request, input.requestCorrelationId);
    await this.requireStrict("read");
    try { await mkdir(this.storageRoot, { recursive: true, mode: 0o700 }); } catch { return []; }
    const entries = await readdir(this.storageRoot, { withFileTypes: true });
    const visible: WorkspaceManifest[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const manifest = await this.readManifest(entry.name);
        const role = currentRole(manifest, actor.subject);
        if (role) visible.push(manifest);
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
      const atUse = await authorization.authorizeAtUse(async () => currentRoleOrRevoked(await this.readManifest(input.workspaceId), input.actorContext.subject));
      if (!atUse.allowed) throw new WorkspaceServiceError("access_denied", atUse.code);
      return input.execute(manifest);
    });
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
    const initial = await this.readManifest(input.workspaceId);
    const authorization = await this.requireAuthorization(actor, initial.id, "write");
    let result: WorkspaceManifest | undefined;
    await withFileLock(this.lockPath(input.workspaceId), async () => {
      const manifest = await this.readManifest(input.workspaceId);
      const atUse = await authorization.authorizeAtUse(async () => currentRoleOrRevoked(manifest, actor.subject));
      if (!atUse.allowed) throw new WorkspaceServiceError("access_denied", atUse.code);
      if (manifest.resources.some((resource) => resource.uri === input.resource.uri)) throw new WorkspaceServiceError("conflict", "resource already exists");
      const next: WorkspaceManifest = { ...manifest, resources: [...manifest.resources, input.resource], updatedAt: this.timestamp() };
      await this.validateManifest(next);
      await writeFileAtomic(this.manifestPath(input.workspaceId), `${JSON.stringify(next, null, 2)}\n`);
      result = next;
    });
    return result!;
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

  private async validateManifest(manifest: WorkspaceManifest): Promise<void> {
    const contract = await validateSacContract({ schema: "workspace-manifest", document: manifest });
    if (!contract.valid) throw new WorkspaceServiceError("invalid_manifest", contract.errors.map((entry) => entry.code).join(", "));
    for (const resource of manifest.resources) await this.validateResource(resource);
  }

  private async validateResource(resource: WorkspaceResource): Promise<void> {
    try { await resolveWorkspaceReference({ workspaceRoot: this.root, kind: resource.kind, uri: resource.uri }); }
    catch (error) { throw new WorkspaceServiceError("invalid_reference", error instanceof Error ? error.message : "unsafe workspace reference"); }
  }

  private async readManifest(id: string): Promise<WorkspaceManifest> {
    if (!/^[a-z][a-z0-9-]{2,63}$/.test(id)) throw new WorkspaceServiceError("not_found", "workspace not found");
    let parsed: unknown;
    try { parsed = JSON.parse(await readFile(this.manifestPath(id), "utf8")); }
    catch (error) { if (isNotFound(error)) throw new WorkspaceServiceError("not_found", "workspace not found"); throw new WorkspaceServiceError("invalid_manifest", "workspace manifest cannot be read"); }
    const contract = await validateSacContract({ schema: "workspace-manifest", document: parsed });
    if (!contract.valid) throw new WorkspaceServiceError("invalid_manifest", contract.errors.map((entry) => entry.code).join(", "));
    const manifest = parsed as WorkspaceManifest;
    for (const resource of manifest.resources) await this.validateResource(resource);
    return manifest;
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
function isNotFound(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"; }

export function localWorkspaceAuthorizationServer(subject = `user:local-${process.getuid?.() ?? process.pid}`): SacAuthorizationServer {
  // This function is intentionally the local CLI composition boundary. It
  // reads no caller-supplied subject/role and exports no client minting path.
  return createSacAuthorizationServer({ authenticateRequest: async () => ({ subject, authenticationMethod: "local-os", roleRevision: "local-os-v1" }) });
}

export function newWorkspaceId(): string { return `workspace-${randomUUID().replace(/-/g, "").slice(0, 16)}`; }
