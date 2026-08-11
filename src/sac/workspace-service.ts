import { mkdir, readdir, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { withFileLock, writeFileAtomic } from "../lib/fs";
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
    await this.requireStrict("read");
    const manifest = await this.readManifest(input.workspaceId);
    await this.requireAuthorization(actor, manifest.id, "read");
    return manifest;
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

  private async requireAuthorization(actor: TrustedActorContext, workspaceId: string, action: "read" | "write") {
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
