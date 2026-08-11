import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { buildMcpContext, dispatchCallTool } from "../mcp/dispatch";

const cli = path.join(import.meta.dir, "..", "cli.ts");

async function invokeCli(cwd: string, args: string[]) {
  const child = Bun.spawn([process.execPath, cli, "workspace", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return { exitCode: await child.exited, stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text() };
}

function normalizeFixture(value: unknown): unknown {
  const copy = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  const manifest = copy.manifest as Record<string, unknown> | undefined;
  if (manifest) manifest.generatedAt = "1970-01-01T00:00:00.000Z";
  const receipt = copy.receipt as Record<string, unknown> | undefined;
  if (receipt) {
    receipt.id = "receipt-normalized";
    receipt.recordedAt = "1970-01-01T00:00:00.000Z";
    const integrity = receipt.integrity as Record<string, unknown>;
    integrity.recordHash = "0".repeat(64);
  }
  return copy;
}

async function fixtureWorkspace(): Promise<{ cwd: string; workspaceId: string }> {
  const cwd = await mkdtemp(path.join(tmpdir(), "keryx-sac-fwk-parity-"));
  await mkdir(path.join(cwd, "evidence"), { recursive: true });
  await writeFile(path.join(cwd, "evidence", "fact.md"), "verified evidence\n");
  const revision = createHash("sha256").update("verified evidence\n").digest("hex");
  const created = await invokeCli(cwd, ["create", "--title", "Parity workspace"]);
  expect(created.exitCode).toBe(0);
  const workspaceId = (JSON.parse(created.stdout) as { id: string }).id;
  const added = await invokeCli(cwd, ["add-resource", workspaceId, "--kind", "evidence", "--uri", "./evidence/fact.md", "--revision", revision]);
  expect(added.exitCode).toBe(0);
  await mkdir(path.join(cwd, ".metaproject"), { recursive: true });
  await writeFile(path.join(cwd, ".metaproject", "metaproject.json"), JSON.stringify({ modules: { mcp: { enabled: true, expose: { tools: true, resources: false, modules: ["sac"] } } } }));
  return { cwd, workspaceId };
}

test("real local CLI and MCP adapter produce matching normalized overview and overflow fixtures", async () => {
  const { cwd, workspaceId } = await fixtureWorkspace();
  const cliOverview = await invokeCli(cwd, ["overview", workspaceId, "--max-items", "2", "--max-tokens", "100"]);
  expect(cliOverview.exitCode).toBe(0);
  const mcp = await dispatchCallTool(await buildMcpContext(cwd), "sac.overview", { workspaceId, maxItems: 2, maxTokens: 100 });
  expect(mcp.isError).toBe(false);
  expect(normalizeFixture(JSON.parse(cliOverview.stdout))).toEqual(normalizeFixture(JSON.parse(mcp.text)));

  const cliOverflow = await invokeCli(cwd, ["overview", workspaceId, "--max-items", "0", "--max-tokens", "0"]);
  expect(cliOverflow.exitCode).toBe(0);
  const mcpOverflow = await dispatchCallTool(await buildMcpContext(cwd), "sac.overview", { workspaceId, maxItems: 0, maxTokens: 0 });
  expect(mcpOverflow.isError).toBe(false);
  expect(JSON.parse(cliOverflow.stdout)).toEqual(JSON.parse(mcpOverflow.text));
});
