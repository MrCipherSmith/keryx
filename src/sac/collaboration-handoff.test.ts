// Flow 237 — the handoff writer that did not exist.
//
// `CollaborationActivity` has carried a `handoff-recorded` kind, and
// `CollaborationService.record()` has been able to write one, since the module
// was added. Nothing called `record()`. Its only caller in the entire repository
// was `collaboration-service.test.ts`, so the capability was written, tested,
// and unreachable — the first of this programme's two recurring defect classes,
// verbatim.
//
// The consequence was the second class. `keryx workspace collaboration <id>` is
// described in the sac skill file as showing "cross-session collaboration
// state", and it returned `activity: []` for every workspace that had ever
// existed, because no code path could put anything there. An empty list reads as
// "no handoffs happened". What was true was "no handoff can be recorded".
//
// So the assertions below go through the CLI process, not through the service:
// a test that called `record()` directly would have passed unchanged in every
// release where the verb did not exist.

import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CollaborationService, CollaborationServiceError } from "./collaboration-service";
import { WorkspaceService, localWorkspaceAuthorizationServer } from "./workspace-service";

const CLI = path.join(import.meta.dir, "..", "cli.ts");
const ROOTS: string[] = [];

afterEach(async () => {
  while (ROOTS.length > 0) {
    const root = ROOTS.pop();
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
  }
});

async function keryx(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, CLI, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NO_COLOR: "1" },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code: await child.exited, stdout, stderr };
}

async function workspace(): Promise<{ root: string; id: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-handoff-"));
  ROOTS.push(root);
  await mkdir(path.join(root, "worktree"), { recursive: true });
  const created = await keryx(root, ["workspace", "create", "--title", "Handoff"]);
  expect(created.code).toBe(0);
  return { root, id: (JSON.parse(created.stdout) as { id: string }).id };
}

test("a handoff recorded through the CLI is visible to the CLI that reads collaboration state", async () => {
  const { root, id } = await workspace();

  // The state the whole repository was permanently in before this verb existed.
  const before = JSON.parse((await keryx(root, ["workspace", "collaboration", id])).stdout) as {
    activity: unknown[];
  };
  expect(before.activity).toEqual([]);

  const recorded = await keryx(root, [
    "workspace", "handoff", id,
    "--to", "agent:reviewer",
    "--artifact", ".metaproject/flows/237/plan.md",
  ]);
  expect(recorded.code).toBe(0);

  const after = JSON.parse((await keryx(root, ["workspace", "collaboration", id])).stdout) as {
    activity: Array<{ kind: string; actorSubject: string; handoff: { from: string; to: string; artifactRef: string } }>;
  };
  expect(after.activity).toHaveLength(1);
  const entry = after.activity[0];
  expect(entry?.kind).toBe("handoff-recorded");
  expect(entry?.handoff.to).toBe("agent:reviewer");
  expect(entry?.handoff.artifactRef).toBe(".metaproject/flows/237/plan.md");
  // Attributed without the caller saying so: `--from` was not passed, and the
  // recorded `from` is the actor the authorization server resolved.
  expect(entry?.handoff.from).toBe(entry?.actorSubject);
  expect(entry?.handoff.from).toBeTruthy();
});

test("the CLI refuses a handoff that names nobody, rather than writing an empty one", async () => {
  const { root, id } = await workspace();

  const noTarget = await keryx(root, ["workspace", "handoff", id, "--artifact", "./plan.md"]);
  expect(noTarget.code).not.toBe(0);
  expect(noTarget.stderr).toContain("Usage: keryx workspace handoff");

  const blankTarget = await keryx(root, ["workspace", "handoff", id, "--to", "   ", "--artifact", "./plan.md"]);
  expect(blankTarget.code).not.toBe(0);

  // Nothing was written by either refusal: a rejected handoff must not leave a
  // row that a later reader counts.
  const overview = JSON.parse((await keryx(root, ["workspace", "collaboration", id])).stdout) as {
    activity: unknown[];
  };
  expect(overview.activity).toEqual([]);
});

// The payload rules, at the service, where the error codes are observable.
async function localService(): Promise<{ service: CollaborationService; id: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-handoff-unit-"));
  ROOTS.push(root);
  await mkdir(path.join(root, "worktree"), { recursive: true });
  const server = localWorkspaceAuthorizationServer("user:owner");
  const workspaces = new WorkspaceService({
    workspaceRoot: root,
    authorizationServer: server,
    strictGuard: { mode: "strict", availability: "available", decision: "pass", policyRevision: "p1" },
  });
  await workspaces.create({
    request: undefined, requestCorrelationId: "handoff-create-0001",
    id: "workspace-a", title: "A", component: { kind: "worktree", uri: "./worktree" },
  });
  return {
    service: new CollaborationService({ workspaceRoot: root, workspaces, authorizationServer: server }),
    id: "workspace-a",
  };
}

test("a handoff payload must actually say who, to whom, and about what", async () => {
  const { service, id } = await localService();
  const record = (handoff: unknown) =>
    service.record({
      request: undefined,
      requestCorrelationId: `handoff-${Math.random()}`,
      workspaceId: id,
      activity: { kind: "handoff-recorded", handoff } as never,
    });

  await expect(record(undefined)).rejects.toThrow("requires a handoff");
  await expect(record({ to: "agent:b" })).rejects.toThrow("artifactRef");
  await expect(record({ to: "", artifactRef: "./x" })).rejects.toThrow("non-empty");
  await expect(record({ to: "agent:b", artifactRef: "x".repeat(600) })).rejects.toThrow("exceeds");
  // A control character would survive JSON encoding into a line-oriented store
  // and render as nothing. Built from a code point, so this source file stays
  // greppable (see src/lib/searchable-sources.test.ts).
  await expect(record({ to: `agent${String.fromCharCode(7)}b`, artifactRef: "./x" })).rejects.toThrow("control characters");
  await expect(record({ to: "agent:b", artifactRef: "./x", note: "extra" })).rejects.toThrow(
    "handoff accepts only",
  );

  // The control: a well-formed one is accepted, so the rules above are refusing
  // bad payloads rather than refusing everything.
  const ok = await record({ to: "agent:b", artifactRef: "./plan.md" });
  expect(ok.handoff?.from).toBe("user:owner");
  await expect(record({ to: "agent:b", artifactRef: "./x" })).resolves.toBeDefined();
});

test("a rejected handoff writes no line at all", async () => {
  const { service, id } = await localService();
  await expect(
    service.record({
      request: undefined, requestCorrelationId: "handoff-bad-0001", workspaceId: id,
      activity: { kind: "handoff-recorded", handoff: { to: "agent:b" } } as never,
    }),
  ).rejects.toBeInstanceOf(CollaborationServiceError);
  expect(
    await service.activity({ request: undefined, requestCorrelationId: "handoff-read-0001", workspaceId: id }),
  ).toEqual([]);
});
