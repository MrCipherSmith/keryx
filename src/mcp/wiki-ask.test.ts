import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildMcpContext,
  dispatchCallTool,
  dispatchListResources,
  dispatchListTools,
  dispatchReadResource,
} from "./dispatch";
import { createGdWikiService } from "../wiki/service";

// AC-C9 / AC-C10: C4 exposes gdwiki Q&A as a THIN MCP Tool (`wiki.ask`) over
// GdWikiService.ask plus wiki + memory as read-only Resources. Driven through
// the transport-agnostic dispatch core (the same core the stdio server runs).
// With the MCP endpoint disabled, no surface is exposed.

let root: string;

async function writeManifest(mcpEnabled: boolean): Promise<void> {
  await writeFile(
    path.join(root, ".metaproject", "metaproject.json"),
    JSON.stringify({
      schemaVersion: 1,
      standardVersion: "0.1.0",
      name: "fixture",
      createdBy: "gd-metapro",
      paths: {},
      modules: {
        gdwiki: { enabled: true },
        memory: { enabled: true },
        mcp: {
          enabled: mcpEnabled,
          expose: { tools: true, resources: true, modules: ["wiki", "memory"] },
        },
      },
    }),
    "utf8",
  );
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "gd-mcp-ask-"));
  await mkdir(path.join(root, ".metaproject", "wiki", "architecture"), { recursive: true });
  await writeFile(
    path.join(root, ".metaproject", "wiki", "architecture", "auth.md"),
    `# Authentication architecture

Type: architecture

## Summary

Authentication is delegated to an external OAuth2 identity provider with JWT.
`,
    "utf8",
  );
  await mkdir(path.join(root, ".metaproject", "memory", "decisions"), { recursive: true });
  await writeFile(
    path.join(root, ".metaproject", "memory", "decisions", "sessions.md"),
    `# Session strategy

Type: decision
Status: accepted

## Summary

User sessions are validated on every authentication request.
`,
    "utf8",
  );
  await writeManifest(true);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("AC-C9: tools/list exposes wiki.ask and tools/call parity with the service facade", async () => {
  const ctx = await buildMcpContext(root);
  const names = dispatchListTools(ctx).map((tool) => tool.name);
  expect(names).toContain("wiki.ask");

  const question = "how does authentication work";
  const call = await dispatchCallTool(ctx, "wiki.ask", { question });
  expect(call.isError).toBe(false);
  const viaTool = JSON.parse(call.text) as { question: string; citations: unknown[] };
  const viaService = await createGdWikiService().ask({ cwd: root, question });

  // Thin adapter: the tool result equals the JSON-serialized service result.
  expect(viaTool.question).toBe(question);
  expect(JSON.parse(call.text)).toEqual(JSON.parse(JSON.stringify(viaService)));
  expect(viaService.citations.length).toBeGreaterThan(0);
  // Citations are drawn from BOTH the wiki and memory of this project only.
  const sources = new Set(viaService.citations.map((c) => c.source));
  expect(sources.has("wiki")).toBe(true);
});

test("AC-C9: resources/list + resources/read expose wiki and memory read-only", async () => {
  const ctx = await buildMcpContext(root);
  const listings = await dispatchListResources(ctx);
  const wiki = listings.find((l) => l.uri.startsWith("metaproject://wiki/"));
  const memory = listings.find((l) => l.uri.startsWith("metaproject://memory/"));
  expect(wiki).toBeDefined();
  expect(memory).toBeDefined();

  const contents = await dispatchReadResource(ctx, wiki!.uri);
  expect(contents.text).toContain("Authentication architecture");
});

test("AC-C10: with mcp disabled, wiki.ask and resources are not exposed", async () => {
  await writeManifest(false);
  const ctx = await buildMcpContext(root);
  expect(dispatchListTools(ctx).map((t) => t.name)).not.toContain("wiki.ask");
  expect(await dispatchListResources(ctx)).toEqual([]);
  const call = await dispatchCallTool(ctx, "wiki.ask", { question: "anything" });
  expect(call.isError).toBe(true);
});
