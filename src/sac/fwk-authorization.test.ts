import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSacAuthorizationServer } from "./index";
import { FwkReadService } from "./fwk-service";
import { WorkspaceService } from "./workspace-service";

const guard = { mode: "strict", availability: "available", decision: "pass", policyRevision: "test-policy" } as const;
const correlation = "fwk-authorize-correlation-0001";

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-sac-fwk-auth-"));
  const authorizationServer = createSacAuthorizationServer({ authenticateRequest: async () => ({ subject: "user:owner", authenticationMethod: "local-os" as const, roleRevision: "roles-r1" }) });
  const workspaces = new WorkspaceService({ workspaceRoot: root, authorizationServer, strictGuard: guard });
  await workspaces.create({ request: undefined, requestCorrelationId: "fwk-auth-create-correlation-1", id: "workspace-alpha", title: "Alpha" });
  return { root, authorizationServer, workspaces };
}

function reader(root: string, authorizationServer: ReturnType<typeof createSacAuthorizationServer>, source: ConstructorParameters<typeof FwkReadService>[0]["source"]) {
  return new FwkReadService({ guard, authorizationServer, source, canonical: { workspaceRoot: root, configurationRevision: "context-r1", policyRef: "./security/policy", policyRevision: "policy-r1" } });
}

test("FWK source reads deny cross-workspace, revoked, and TOCTOU role changes with a receipt", async () => {
  const { root, authorizationServer, workspaces } = await setup();
  const manifestPath = path.join(root, ".metaproject", "workspaces", "workspace-alpha", "workspace.json");
  await workspaces.create({ request: undefined, requestCorrelationId: "fwk-auth-create-correlation-2", id: "workspace-beta", title: "Beta" });
  const foreignPath = path.join(root, ".metaproject", "workspaces", "workspace-beta", "workspace.json");
  const foreign = JSON.parse(await readFile(foreignPath, "utf8")) as { members: unknown[] };
  foreign.members = [{ subject: "user:other", role: "owner" }];
  await writeFile(foreignPath, `${JSON.stringify(foreign)}\n`);
  const empty = { facts: [], knowHow: [] };

  const crossWorkspace = await reader(root, authorizationServer, async ({ actorContext }) => {
    await workspaces.showForActor({ actorContext, workspaceId: "workspace-beta" });
    return empty;
  }).overview({ workspaceId: "workspace-beta", request: undefined, requestCorrelationId: correlation, budget: { maxItems: 1, maxTokens: 1 } });
  expect("code" in crossWorkspace).toBe(false); if ("code" in crossWorkspace) return;
  expect(crossWorkspace.receipt.decision).toBe("denied");

  const revoked = await reader(root, authorizationServer, async ({ actorContext }) => {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { members: unknown[] };
    manifest.members = [{ subject: "user:other", role: "owner" }];
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
    await workspaces.showForActor({ actorContext, workspaceId: "workspace-alpha" });
    return empty;
  }).overview({ workspaceId: "workspace-alpha", request: undefined, requestCorrelationId: correlation, budget: { maxItems: 1, maxTokens: 1 } });
  expect("code" in revoked).toBe(false); if ("code" in revoked) return;
  expect(revoked.manifest.freshness).toBe("denied");
  expect(revoked.receipt.decision).toBe("denied");
});

test("denied reads persist a resolvable metadata-only canonical trace", async () => {
  const { root, authorizationServer } = await setup();
  let sourceOpened = false;
  const service = new FwkReadService({
    guard,
    authorizationServer: createSacAuthorizationServer({ authenticateRequest: async () => undefined }),
    source: async () => { sourceOpened = true; return { facts: [], knowHow: [] }; },
    canonical: { workspaceRoot: root, configurationRevision: "context-r1", policyRef: "./security/policy", policyRevision: "policy-r1" },
  });
  const result = await service.overview({ workspaceId: "workspace-alpha", request: undefined, requestCorrelationId: "fwk-denied-trace-correlation-0001", budget: { maxItems: 1, maxTokens: 1 } });
  expect("code" in result).toBe(false); if ("code" in result) return;
  expect(sourceOpened).toBe(false);
  expect(result.receipt.decision).toBe("denied");
  const trace = await readFile(path.join(root, result.receipt.contextAssembly.traceRef.slice(2)), "utf8");
  expect(JSON.parse(trace)).toMatchObject({ outcome: "denied", selected: [], omittedOptional: [] });
  for (const forbidden of ["prompt", "transcript", "hiddenReasoning", "secret", "rawContent"]) expect(trace).not.toContain(forbidden);
  // Keep the setup authorization server in scope so this test cannot
  // accidentally succeed by accepting a client-supplied identity.
  expect(await authorizationServer.actorContextFor(undefined, correlation)).toBeDefined();
});

test("public strict-guard denial also persists a resolvable no-content trace", async () => {
  const { root, authorizationServer } = await setup();
  const service = new FwkReadService({
    guard: { mode: "disabled" }, authorizationServer, source: async () => { throw new Error("must not open source"); },
    canonical: { workspaceRoot: root, configurationRevision: "context-r1", policyRef: "./security/policy", policyRevision: "policy-r1" },
  });
  const result = await service.overview({ workspaceId: "workspace-alpha", request: undefined, requestCorrelationId: "fwk-public-guard-deny-correlation-1", budget: { maxItems: 1, maxTokens: 1 } });
  expect("code" in result).toBe(false); if ("code" in result) return;
  expect(result.receipt.decision).toBe("denied");
  const trace = await readFile(path.join(root, result.receipt.contextAssembly.traceRef.slice(2)), "utf8");
  expect(JSON.parse(trace)).toMatchObject({ outcome: "denied", selected: [] });
});

test("target access re-authorizes and re-resolves changed resources before disclosure", async () => {
  const { root, authorizationServer, workspaces } = await setup();
  await mkdir(path.join(root, "evidence"));
  await writeFile(path.join(root, "evidence", "fact.md"), "safe evidence");
  await workspaces.addResource({ request: undefined, requestCorrelationId: "fwk-target-add-correlation-0001", workspaceId: "workspace-alpha", resource: { kind: "evidence", uri: "./evidence/fact.md" } });
  const actorContext = await authorizationServer.actorContextFor(undefined, "fwk-target-actor-correlation-0001");
  if (!actorContext) throw new Error("expected trusted actor");
  const before = await workspaces.showForActor({ actorContext, workspaceId: "workspace-alpha" });
  const evidence = before.resources.find((resource) => resource.kind === "evidence");
  if (!evidence) throw new Error("expected evidence resource");
  const manifestPath = path.join(root, ".metaproject", "workspaces", "workspace-alpha", "workspace.json");
  const revoked = JSON.parse(await readFile(manifestPath, "utf8")) as { members: unknown[] };
  revoked.members = [{ subject: "user:other", role: "owner" }];
  await writeFile(manifestPath, `${JSON.stringify(revoked)}\n`);
  await expect(workspaces.resolveResourceForActor({ actorContext, workspaceId: "workspace-alpha", resource: evidence })).rejects.toMatchObject({ code: "access_denied" });
  revoked.members = [{ subject: "user:owner", role: "owner" }];
  await writeFile(manifestPath, `${JSON.stringify(revoked)}\n`);
  const outside = await mkdtemp(path.join(tmpdir(), "keryx-sac-fwk-outside-"));
  await writeFile(path.join(outside, "secret.md"), "outside secret");
  await writeFile(path.join(root, "evidence", "fact.md"), "replaced before target access");
  await symlink(path.join(outside, "secret.md"), path.join(root, "evidence", "escape"));
  const changed = JSON.parse(await readFile(manifestPath, "utf8")) as { resources: Array<{ kind: string; uri: string }> };
  changed.resources = [{ kind: "evidence", uri: "./evidence/escape" }];
  await writeFile(manifestPath, `${JSON.stringify(changed)}\n`);
  await expect(workspaces.resolveResourceForActor({ actorContext, workspaceId: "workspace-alpha", resource: evidence })).rejects.toMatchObject({ code: "invalid_reference" });

  const service = new FwkReadService({
    guard, authorizationServer,
    source: async ({ actorContext: trusted }) => {
      const current = await workspaces.showForActor({ actorContext: trusted, workspaceId: "workspace-alpha" });
      const changedResource = current.resources[0]!;
      await workspaces.resolveResourceForActor({ actorContext: trusted, workspaceId: "workspace-alpha", resource: changedResource });
      return { facts: [], knowHow: [] };
    },
    canonical: { workspaceRoot: root, configurationRevision: "context-r1", policyRef: "./security/policy", policyRevision: "policy-r1" },
  });
  const result = await service.overview({ workspaceId: "workspace-alpha", request: undefined, requestCorrelationId: "fwk-target-denied-correlation-0001", budget: { maxItems: 1, maxTokens: 1 } });
  expect("code" in result).toBe(false); if ("code" in result) return;
  expect(result.manifest.freshness).toBe("denied");
  expect(result.receipt.decision).toBe("denied");
  await expect(readFile(path.join(root, result.receipt.contextAssembly.traceRef.slice(2)), "utf8")).resolves.toContain("\"outcome\":\"denied\"");
});

test("safe descriptor source open rejects a symlink swapped after containment and before open", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-sac-fwk-fd-race-"));
  const outside = await mkdtemp(path.join(tmpdir(), "keryx-sac-fwk-fd-outside-"));
  const targetPath = path.join(root, "evidence", "fact.md");
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, "safe evidence");
  await writeFile(path.join(outside, "secret.md"), "outside secret");
  let swap = false;
  const authorizationServer = createSacAuthorizationServer({ authenticateRequest: async () => ({ subject: "user:owner", authenticationMethod: "local-os" as const, roleRevision: "roles-r1" }) });
  const workspaces = new WorkspaceService({
    workspaceRoot: root, authorizationServer, strictGuard: guard,
    beforeResourceOpen: async () => {
      if (!swap) return;
      await rm(targetPath);
      await symlink(path.join(outside, "secret.md"), targetPath);
    },
  });
  await workspaces.create({ request: undefined, requestCorrelationId: "fwk-fd-race-create-correlation-1", id: "workspace-alpha", title: "Alpha" });
  await workspaces.addResource({ request: undefined, requestCorrelationId: "fwk-fd-race-add-correlation-1", workspaceId: "workspace-alpha", resource: { kind: "evidence", uri: "./evidence/fact.md" } });
  const actorContext = await authorizationServer.actorContextFor(undefined, "fwk-fd-race-actor-correlation-1");
  if (!actorContext) throw new Error("expected trusted actor");
  const resource = (await workspaces.showForActor({ actorContext, workspaceId: "workspace-alpha" })).resources[0]!;
  swap = true;
  await expect(workspaces.readResourceForActor({ actorContext, workspaceId: "workspace-alpha", resource, encoding: "utf8" })).rejects.toMatchObject({ code: "invalid_reference" });
  expect(await readFile(path.join(outside, "secret.md"), "utf8")).toBe("outside secret");
});
