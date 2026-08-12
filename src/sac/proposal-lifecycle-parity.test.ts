import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildMcpContext } from "../mcp/dispatch";
import { createMcpServer } from "../mcp/server";
import { createWikiGuardedTargetWriter, ProposalLifecycleService } from "./proposal-lifecycle";
import { localWorkspaceAuthorizationServer, WorkspaceService } from "./workspace-service";
import { createTrustedWrapUpAuthority } from "./trusted-wrap-up";

const cli = path.join(import.meta.dir, "..", "cli.ts");
const now = "2026-08-12T00:00:00.000Z";

async function runCli(cwd: string, args: string[]) {
  const child = Bun.spawn([process.execPath, cli, "workspace", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return { exitCode: await child.exited, stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text() };
}

/** Server-owned setup only; production local propose remains fail-closed. */
async function seedTrustedProposal(root: string) {
  await mkdir(path.join(root, "evidence"), { recursive: true }); await mkdir(path.join(root, "wiki"), { recursive: true });
  await writeFile(path.join(root, "evidence", "e.md"), "evidence"); await writeFile(path.join(root, "wiki", "accepted.md"), "accepted");
  const authorizationServer = localWorkspaceAuthorizationServer();
  const workspaces = new WorkspaceService({ workspaceRoot: root, authorizationServer, strictGuard: { mode: "strict", availability: "available", decision: "pass", policyRevision: "policy-r1" }, now: () => new Date(now) });
  await workspaces.create({ request: undefined, requestCorrelationId: "proposal-create-correlation-0001", id: "workspace-a", title: "Parity" });
  const wrapUpAuthority = createTrustedWrapUpAuthority({ now: () => new Date(now), resolveExplicitWrapUp: async () => ({ workspaceId: "workspace-a", sourceRevision: "wrapup-r1", summary: "explicit session wrap-up", evidence: [{ kind: "evidence", uri: "./evidence/e.md", revision: createHash("sha256").update("evidence").digest("hex"), observedAt: now }], expiresAt: "2026-08-12T01:00:00.000Z" }) });
  const service = new ProposalLifecycleService({ workspaceRoot: root, workspaces, authorizationServer, guard: { mode: "strict", availability: "available", decision: "pass", policyRevision: "policy-r1" }, policyRef: "./security/policy", policyRevision: "policy-r1", targetWriters: { wiki: createWikiGuardedTargetWriter({ authorize: async () => true, recover: async () => undefined, persist: async () => ({ receiptRef: "./receipts/a", targetRef: "./wiki/accepted.md", completedAt: now }) }) }, wrapUpAuthority, now: () => new Date(now) });
  const actor = await authorizationServer.actorContextFor(undefined, "proposal-create-correlation-0001");
  if (!actor) throw new Error("local server did not issue test actor");
  const wrapUp = await wrapUpAuthority.issue({ actor, source: "session", sourceRef: "./evidence/e.md" });
  await service.create({ request: undefined, requestCorrelationId: "proposal-create-correlation-0001", workspaceId: "workspace-a", id: "proposal-a", proposalRevision: "r1", kind: "wiki-update", wrapUp });
}

test("actual CLI and real stdio MCP SDK preserve terminal review and replay parity", async () => {
  let sdk: { Client: new (info: unknown, options: unknown) => { connect(t: unknown): Promise<void>; callTool(args: { name: string; arguments: Record<string, unknown> }): Promise<{ content: Array<{ text: string }>; isError?: boolean }>; close(): Promise<void> }; InMemoryTransport: { createLinkedPair(): [unknown, unknown] } };
  try {
    const client = await import("@modelcontextprotocol/sdk/client/index.js"); const transport = await import("@modelcontextprotocol/sdk/inMemory.js");
    sdk = { Client: client.Client as never, InMemoryTransport: transport.InMemoryTransport as never };
  } catch { return; }
  const root = await mkdtemp(path.join(tmpdir(), "keryx-sac-parity-"));
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  await writeFile(path.join(root, ".metaproject", "metaproject.json"), JSON.stringify({ schemaVersion: 1, standardVersion: "0.1.0", name: "parity", createdBy: "test", paths: {}, modules: { mcp: { enabled: true, expose: { tools: true, resources: true, modules: ["sac"] } }, sac: { enabled: true } } }));
  await seedTrustedProposal(root);
  const key = "proposal-review-idempotency-0001";
  const cliResult = await runCli(root, ["review", "workspace-a", "proposal-a", "--decision", "rejected", "--reason", "not-applicable", "--idempotency-key", key]);
  expect(cliResult.exitCode).toBe(0);
  const ctx = await buildMcpContext(root, "stdio"); const server = await createMcpServer(ctx); const [clientTransport, serverTransport] = sdk.InMemoryTransport.createLinkedPair(); await server.connect(serverTransport);
  const client = new sdk.Client({ name: "proposal-parity", version: "0" }, { capabilities: {} }); await client.connect(clientTransport);
  const replay = await client.callTool({ name: "sac.review", arguments: { workspaceId: "workspace-a", proposalId: "proposal-a", decision: "rejected", reason: "not-applicable", idempotencyKey: key } });
  expect(replay.isError).not.toBe(true); expect(JSON.parse(replay.content[0]!.text)).toEqual(JSON.parse(cliResult.stdout));
  const cliConflict = await runCli(root, ["review", "workspace-a", "proposal-a", "--decision", "rejected", "--reason", "again", "--idempotency-key", "proposal-review-idempotency-0002"]);
  const conflict = await client.callTool({ name: "sac.review", arguments: { workspaceId: "workspace-a", proposalId: "proposal-a", decision: "rejected", reason: "again", idempotencyKey: "proposal-review-idempotency-0002" } });
  expect(cliConflict.exitCode).toBe(1); expect(conflict.isError).toBe(true); expect(conflict.content[0]!.text).toContain("proposal already has a terminal transition");
  await client.close(); await server.close();
});
