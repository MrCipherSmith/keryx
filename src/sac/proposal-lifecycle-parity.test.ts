import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { buildMcpContext, dispatchCallTool } from "../mcp/dispatch";

const cli = path.join(import.meta.dir, "..", "cli.ts");

async function invoke(cwd: string, args: string[]) {
  const child = Bun.spawn([process.execPath, cli, "workspace", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return { exitCode: await child.exited, stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text() };
}

function normalize(value: unknown): unknown {
  const copy = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  const scrub = (candidate: unknown): void => {
    if (Array.isArray(candidate)) { candidate.forEach(scrub); return; }
    if (!candidate || typeof candidate !== "object") return;
    for (const [key, child] of Object.entries(candidate as Record<string, unknown>)) {
      if (["id", "workspaceId", "proposalId", "correlationId", "createdAt", "observedAt", "eventId", "occurredAt", "decidedAt"].includes(key)) (candidate as Record<string, unknown>)[key] = `${key}-normalized`;
      else scrub(child);
    }
  };
  scrub(copy);
  return copy;
}

async function fixture(): Promise<{ cwd: string; workspaceId: string; evidence: string }> {
  const cwd = await mkdtemp(path.join(tmpdir(), "keryx-sac-proposal-parity-"));
  await mkdir(path.join(cwd, "evidence"), { recursive: true });
  await writeFile(path.join(cwd, "evidence", "wrap-up.md"), "verified wrap-up evidence\n");
  const evidence = "./evidence/wrap-up.md";
  const created = await invoke(cwd, ["create", "--title", "Parity workspace"]);
  expect(created.exitCode).toBe(0);
  const workspaceId = (JSON.parse(created.stdout) as { id: string }).id;
  await writeFile(path.join(cwd, ".metaproject", "metaproject.json"), JSON.stringify({ modules: { mcp: { enabled: true, expose: { tools: true, resources: false, modules: ["sac"] } } } }));
  return { cwd, workspaceId, evidence };
}

test("local CLI and stdio MCP normalize trusted-wrap-up denial", async () => {
  const cliFixture = await fixture();
  const mcpFixture = await fixture();
  const cliProposal = await invoke(cliFixture.cwd, ["propose", cliFixture.workspaceId, "--kind", "wiki-update", "--summary", "explicit minimized wrap-up", "--evidence", cliFixture.evidence, "--revision", "r1"]);
  const mcpProposal = await dispatchCallTool(await buildMcpContext(mcpFixture.cwd, "stdio"), "sac.propose", { workspaceId: mcpFixture.workspaceId, kind: "wiki-update", summary: "explicit minimized wrap-up", evidenceUri: mcpFixture.evidence, revision: "r1" });
  expect(cliProposal.exitCode).toBe(0); expect(mcpProposal.isError).toBe(false);
  expect(normalize(JSON.parse(cliProposal.stdout))).toEqual(normalize(JSON.parse(mcpProposal.text)));
  expect(JSON.parse(cliProposal.stdout)).toEqual({ code: "trusted_wrap_up_required" });
});

test("HTTP MCP cannot create or review local SAC proposals", async () => {
  const { cwd, workspaceId, evidence } = await fixture();
  const response = await dispatchCallTool(await buildMcpContext(cwd, "http"), "sac.propose", { workspaceId, kind: "wiki-update", summary: "explicit minimized wrap-up", evidenceUri: evidence, revision: createHash("sha256").update("verified wrap-up evidence\n").digest("hex") });
  expect(response.isError).toBe(false);
  expect(JSON.parse(response.text)).toEqual({ code: "sac_transport_denied" });
});
