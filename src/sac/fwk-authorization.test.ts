import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSacAuthorizationServer } from "./index";
import { FwkReadService } from "./fwk-service";
import { WorkspaceService } from "./workspace-service";

const guard = { mode: "strict", availability: "available", decision: "pass", policyRevision: "test-policy" } as const;
const canonical = { traceRef: "./context/traces/1", configurationRevision: "context-r1", policyRef: "./security/policy", policyRevision: "policy-r1" } as const;
const correlation = "fwk-authorize-correlation-0001";

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-sac-fwk-auth-"));
  const authorizationServer = createSacAuthorizationServer({ authenticateRequest: async () => ({ subject: "user:owner", authenticationMethod: "local-os" as const, roleRevision: "roles-r1" }) });
  const workspaces = new WorkspaceService({ workspaceRoot: root, authorizationServer, strictGuard: guard });
  await workspaces.create({ request: undefined, requestCorrelationId: "fwk-auth-create-correlation-1", id: "workspace-alpha", title: "Alpha" });
  return { root, authorizationServer, workspaces };
}

function reader(authorizationServer: ReturnType<typeof createSacAuthorizationServer>, source: ConstructorParameters<typeof FwkReadService>[0]["source"]) {
  return new FwkReadService({ guard, authorizationServer, source, canonical });
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

  const crossWorkspace = await reader(authorizationServer, async ({ actorContext }) => {
    await workspaces.showForActor({ actorContext, workspaceId: "workspace-beta" });
    return empty;
  }).overview({ workspaceId: "workspace-beta", request: undefined, requestCorrelationId: correlation, budget: { maxItems: 1, maxTokens: 1 } });
  expect("code" in crossWorkspace).toBe(false); if ("code" in crossWorkspace) return;
  expect(crossWorkspace.receipt.decision).toBe("denied");

  const revoked = await reader(authorizationServer, async ({ actorContext }) => {
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
