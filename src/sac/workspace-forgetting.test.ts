// Flow 242 lane D — what a SAC workspace says about its own references once
// the knowledge behind one of them is gone.
//
// Every test here observes a SYSTEM RESPONSE TO A REFERENCE INTO DELETED (or
// substituted) KNOWLEDGE, never a retention statistic (AC7). The four
// behaviours measured before the change, on a real scratch project with one
// wiki page deleted and a second still readable:
//
//   1. `list` returned `[]` and `show` failed with "workspace reference is not
//      resolvable" — a live, `active` workspace became indistinguishable from
//      one that never existed.
//   2. `overview` returned `partial: false`, `omittedOptional: []`, an empty
//      manifest and `decision: "denied"`, at exit 0, while the other resource
//      was still perfectly readable.
//   3. Recreating a DIFFERENT document at the deleted path made the workspace
//      reappear, now pointing at content that reversed what it referenced.
//      Nothing anywhere noticed.
//   4. The dangling entry could not even be removed: `removeResource` reads the
//      manifest first, and that read was the thing that threw.
import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSacAuthorizationServer } from "./index";
import {
  listWorkspaceViews,
  lookupWorkspace,
  WorkspaceService,
  type WorkspaceReferenceStatus,
} from "./workspace-service";
import { createLocalFwkReadService } from "./fwk-service";
import { formatFwkExplain } from "./fwk-explain";
import { localWorkspaceAuthorizationServer } from "./workspace-service";

const strict = { mode: "strict", availability: "available", decision: "pass", policyRevision: "test-policy" } as const;
const request = { transport: "local" };

function server(subject: string) {
  return createSacAuthorizationServer({ authenticateRequest: async () => ({ subject, authenticationMethod: "local-os", roleRevision: "roles-v1" }) });
}

/**
 * A project holding two real wiki pages, both referenced by one workspace.
 * `page-a` is the one later deleted or substituted; `page-b` exists purely so
 * every assertion below can distinguish "this workspace is unreadable" from
 * "one reference in this workspace is unreadable".
 */
async function project(): Promise<{ root: string; owner: WorkspaceService; workspaceId: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-sac-forgetting-"));
  await mkdir(path.join(root, "wiki"), { recursive: true });
  await writeFile(path.join(root, "wiki", "page-a.md"), "Status: accepted\n\nThe retry limit is 3.\n");
  await writeFile(path.join(root, "wiki", "page-b.md"), "Status: accepted\n\nThe second page stays.\n");
  const owner = new WorkspaceService({ workspaceRoot: root, authorizationServer: server("user:owner"), strictGuard: strict });
  await owner.create({ request, requestCorrelationId: "forgetting-create-0001", id: "workspace-forgetting", title: "Forgetting" });
  await owner.addResource({ request, requestCorrelationId: "forgetting-add-a-0001", workspaceId: "workspace-forgetting", resource: { kind: "wiki", uri: "./wiki/page-a.md" } });
  await owner.addResource({ request, requestCorrelationId: "forgetting-add-b-0001", workspaceId: "workspace-forgetting", resource: { kind: "wiki", uri: "./wiki/page-b.md" } });
  return { root, owner, workspaceId: "workspace-forgetting" };
}

const statusFor = (resources: readonly WorkspaceReferenceStatus[], uri: string): WorkspaceReferenceStatus => {
  const found = resources.find((entry) => entry.uri === uri);
  if (!found) throw new Error(`no reference status reported for ${uri}`);
  return found;
};

test("a workspace whose referenced wiki page was deleted is still listed and still shown, with the failing reference named — it does not vanish into the same answer as a workspace that never existed", async () => {
  const { root, owner, workspaceId } = await project();
  await rm(path.join(root, "wiki", "page-a.md"));

  const listed = await owner.list({ request, requestCorrelationId: "forgetting-list-0001" });
  expect(listed.map((workspace) => workspace.id)).toEqual([workspaceId]);

  const shown = await owner.show({ request, requestCorrelationId: "forgetting-show-0001", workspaceId });
  expect(shown.status).toBe("active");
  expect(shown.resources.map((resource) => resource.uri)).toEqual(["./wiki/page-a.md", "./wiki/page-b.md"]);

  // The failing reference is NAMED, not merely counted, and the surviving one
  // is still reported as resolved — "one of these two is gone" is the answer,
  // not "this workspace is broken" and not silence.
  const references = await owner.describeReferences(shown);
  expect(references.ok).toBe(false);
  expect(references.unresolvable).toEqual(["./wiki/page-a.md"]);
  expect(statusFor(references.resources, "./wiki/page-a.md").state).toBe("unresolvable");
  expect(statusFor(references.resources, "./wiki/page-a.md").detail).toContain("not resolvable");
  expect(statusFor(references.resources, "./wiki/page-b.md").state).toBe("resolved");

  // A workspace that genuinely never existed is a different answer entirely.
  expect(await lookupWorkspace(owner, "workspace-never-existed")).toMatchObject({ outcome: "not-found" });
});

test("the dangling reference can actually be removed — the manifest read that used to throw was the thing standing between an operator and cleaning it up", async () => {
  const { root, owner, workspaceId } = await project();
  await rm(path.join(root, "wiki", "page-a.md"));

  const cleaned = await owner.removeResource({ request, requestCorrelationId: "forgetting-remove-0001", workspaceId, uri: "./wiki/page-a.md" });
  expect(cleaned.resources.map((resource) => resource.uri)).toEqual(["./wiki/page-b.md"]);
  expect((await owner.describeReferences(cleaned)).ok).toBe(true);
});

test("overview over a workspace with one deleted target reports partial: true and names the omission, instead of an empty manifest at partial: false", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-sac-forgetting-overview-"));
  await mkdir(path.join(root, "wiki"), { recursive: true });
  await writeFile(path.join(root, "wiki", "page-a.md"), "Status: accepted\n\nThe retry limit is 3.\n");
  await writeFile(path.join(root, "wiki", "page-b.md"), "Status: accepted\n\nThe second page stays.\n");
  // The local composition (`localWorkspaceAuthorizationServer`) is what the CLI
  // and MCP both use, and what `createLocalFwkReadService` authenticates as.
  const owner = new WorkspaceService({ workspaceRoot: root, authorizationServer: localWorkspaceAuthorizationServer(), strictGuard: strict });
  await owner.create({ request: undefined, requestCorrelationId: "forgetting-overview-create-0001", id: "workspace-overview", title: "Overview" });
  await owner.addResource({ request: undefined, requestCorrelationId: "forgetting-overview-add-a-0001", workspaceId: "workspace-overview", resource: { kind: "wiki", uri: "./wiki/page-a.md" } });
  await owner.addResource({ request: undefined, requestCorrelationId: "forgetting-overview-add-b-0001", workspaceId: "workspace-overview", resource: { kind: "wiki", uri: "./wiki/page-b.md" } });
  await rm(path.join(root, "wiki", "page-a.md"));

  const result = await createLocalFwkReadService(root).overview({ workspaceId: "workspace-overview", request: undefined, requestCorrelationId: "forgetting-overview-read-0001", budget: { maxItems: 32, maxTokens: 4096 } });
  expect("code" in result).toBe(false); if ("code" in result) return;

  // The two fields that exist to report incompleteness now report it.
  expect(result.partial).toBe(true);
  expect(result.omittedOptional).toEqual(["knowhow-0"]);
  // And what survived is still disclosed: this is a partial read, not a denial.
  expect(result.receipt.decision).not.toBe("denied");
  expect(result.manifest.freshness).not.toBe("denied");
  expect((result.manifest.knowHow as Array<{ uri: string }>).map((entry) => entry.uri)).toEqual(["./wiki/page-b.md"]);
  expect(result.receipt.contextAssembly.omittedOptional).toEqual(["./ids/knowhow-0"]);

  // `knowhow-0` on its own names nothing an operator can look at: an omitted
  // item is by construction absent from `manifest`, so the id resolves to
  // emptiness. AC1 asks for the list of what was NOT touched WITH a reason for
  // each, so every omitted id resolves to the reference it came from and why.
  expect(result.withheld).toEqual([
    { id: "knowhow-0", uri: "./wiki/page-a.md", kind: "wiki", reason: "know-how reference could not be read at this workspace's declared path" },
  ]);
  expect(result.withheld).toHaveLength(result.omittedOptional.length);
});

test("--explain prints the omitted reference and its reason, not just an opaque assembly id", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-sac-forgetting-explain-"));
  await mkdir(path.join(root, "wiki"), { recursive: true });
  await writeFile(path.join(root, "wiki", "page-a.md"), "Status: accepted\n\nThe retry limit is 3.\n");
  await writeFile(path.join(root, "wiki", "page-b.md"), "Status: accepted\n\nThe second page stays.\n");
  const owner = new WorkspaceService({ workspaceRoot: root, authorizationServer: localWorkspaceAuthorizationServer(), strictGuard: strict });
  await owner.create({ request: undefined, requestCorrelationId: "forgetting-explain-create-0001", id: "workspace-explain", title: "Explain" });
  await owner.addResource({ request: undefined, requestCorrelationId: "forgetting-explain-add-a-0001", workspaceId: "workspace-explain", resource: { kind: "wiki", uri: "./wiki/page-a.md" } });
  await owner.addResource({ request: undefined, requestCorrelationId: "forgetting-explain-add-b-0001", workspaceId: "workspace-explain", resource: { kind: "wiki", uri: "./wiki/page-b.md" } });
  await rm(path.join(root, "wiki", "page-a.md"));

  const result = await createLocalFwkReadService(root).overview({ workspaceId: "workspace-explain", request: undefined, requestCorrelationId: "forgetting-explain-read-0001", budget: { maxItems: 32, maxTokens: 4096 } });
  const text = formatFwkExplain(result);
  expect(text).toContain("./wiki/page-a.md");
  expect(text).toContain("could not be read");
});

test("a reference detects that a DIFFERENT document was substituted at its path — the pin is a content digest captured when the reference was added", async () => {
  const { root, owner, workspaceId } = await project();
  const pinned = await owner.show({ request, requestCorrelationId: "forgetting-pin-show-0001", workspaceId });
  // The pin is taken from the bytes, at add time, with no caller involvement.
  expect(pinned.resources[0]!.revision).toMatch(/^[a-f0-9]{64}$/);
  expect((await owner.describeReferences(pinned)).ok).toBe(true);

  // Delete, then recreate a document at the same path that reverses the claim.
  await rm(path.join(root, "wiki", "page-a.md"));
  await writeFile(path.join(root, "wiki", "page-a.md"), "Status: accepted\n\nThe retry limit is 99.\n");

  const references = await owner.describeReferences(await owner.show({ request, requestCorrelationId: "forgetting-pin-show-0002", workspaceId }));
  expect(references.ok).toBe(false);
  expect(references.changed).toEqual(["./wiki/page-a.md"]);
  const status = statusFor(references.resources, "./wiki/page-a.md");
  expect(status.state).toBe("changed");
  expect(status.pinnedRevision).not.toBe(status.observedRevision);
});

test("a caller-supplied revision that is not a content digest is reported as unverifiable, never quietly as resolved — \"I cannot tell\" stays its own answer", async () => {
  const { owner, workspaceId, root } = await project();
  await writeFile(path.join(root, "wiki", "page-c.md"), "Status: accepted\n\nA labelled page.\n");
  const withLabel = await owner.addResource({ request, requestCorrelationId: "forgetting-label-add-0001", workspaceId, resource: { kind: "wiki", uri: "./wiki/page-c.md", revision: "v1" } });
  expect(withLabel.resources.find((resource) => resource.uri === "./wiki/page-c.md")!.revision).toBe("v1");

  const references = await owner.describeReferences(withLabel);
  const status = statusFor(references.resources, "./wiki/page-c.md");
  expect(status.state).toBe("unverifiable");
  expect(status.detail).toContain("not a content digest");
  // Unverifiable is deliberately NOT folded into `ok`'s failure set — it is a
  // third answer, and it is still named.
  expect(references.unverifiable).toEqual(["./wiki/page-c.md"]);
  expect(references.ok).toBe(true);
});

test("a genuinely denied overview reports partial: true — an empty manifest at partial: false was the claim \"this is the whole workspace\"", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-sac-forgetting-denied-"));
  const foreign = new WorkspaceService({ workspaceRoot: root, authorizationServer: server("user:someone-else"), strictGuard: strict });
  await foreign.create({ request, requestCorrelationId: "forgetting-denied-create-0001", id: "workspace-denied", title: "Denied" });

  // Read as the LOCAL actor, which holds no role in a workspace another
  // subject owns.
  const result = await createLocalFwkReadService(root).overview({ workspaceId: "workspace-denied", request: undefined, requestCorrelationId: "forgetting-denied-read-0001", budget: { maxItems: 32, maxTokens: 4096 } });
  expect("code" in result).toBe(false); if ("code" in result) return;
  expect(result.receipt.decision).toBe("denied");
  expect(result.manifest.freshness).toBe("denied");
  expect(result.partial).toBe(true);

  // The DURABLE trace an auditor reads later must say the same thing the caller
  // was told at the time. It recorded `partial: false` — so the answer given
  // and the record kept of it disagreed, and the record was the optimistic one.
  const traceRef = result.receipt.contextAssembly.traceRef;
  const trace = JSON.parse(await readFile(path.join(root, traceRef.replace(/^\.\//, "")), "utf8")) as { outcome: string; partial: boolean };
  expect(trace.outcome).toBe("denied");
  expect(trace.partial).toBe(true);
});

test("listWorkspaceViews and lookupWorkspace — the one pair of calls the CLI and MCP share — agree on the damaged workspace and on an id that never existed", async () => {
  const { root, workspaceId } = await project();
  await rm(path.join(root, "wiki", "page-a.md"));
  const local = new WorkspaceService({ workspaceRoot: root, authorizationServer: localWorkspaceAuthorizationServer(), strictGuard: strict });
  // Re-created by the local actor so the shared helpers can see it at all.
  await rm(path.join(root, ".metaproject", "workspaces"), { recursive: true, force: true });
  await local.create({ request: undefined, requestCorrelationId: "forgetting-shared-create-0001", id: workspaceId, title: "Forgetting" });
  await local.addResource({ request: undefined, requestCorrelationId: "forgetting-shared-add-0001", workspaceId, resource: { kind: "wiki", uri: "./wiki/page-b.md" } });
  await rm(path.join(root, "wiki", "page-b.md"));

  const views = await listWorkspaceViews(local, false);
  expect(views.map((view) => view.manifest.id)).toEqual([workspaceId]);
  expect(views[0]!.references.unresolvable).toEqual(["./wiki/page-b.md"]);

  const found = await lookupWorkspace(local, workspaceId);
  expect(found.outcome).toBe("workspace");
  if (found.outcome !== "workspace") return;
  expect(found.references.unresolvable).toEqual(views[0]!.references.unresolvable);

  const missing = await lookupWorkspace(local, "workspace-never-existed");
  expect(missing).toMatchObject({ outcome: "not-found", workspaceId: "workspace-never-existed" });
});

test("adding a reference to a target that does not exist is still refused at add time — the read-time relaxation did not remove the write-time guard", async () => {
  const { owner, workspaceId, root } = await project();
  await expect(owner.addResource({ request, requestCorrelationId: "forgetting-addguard-0001", workspaceId, resource: { kind: "wiki", uri: "./wiki/never-written.md" } })).rejects.toMatchObject({ code: "invalid_reference" });
  const manifest = JSON.parse(await readFile(path.join(root, ".metaproject", "workspaces", workspaceId, "workspace.json"), "utf8")) as { resources: Array<{ uri: string }> };
  expect(manifest.resources.map((resource) => resource.uri)).toEqual(["./wiki/page-a.md", "./wiki/page-b.md"]);
});
