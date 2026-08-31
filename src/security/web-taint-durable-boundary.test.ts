import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runAgentTurn, type AgentDeps, type AgentIO } from "../commands/agent";
import type { InteractiveTool } from "../harness/tool/builtin/interactive-tools";
import type {
  NormalizedEvent,
  NormalizedMessage,
  NormalizedRequest,
  ProviderDescription,
  ProviderPort,
  StreamOptions,
} from "../harness/provider/types";
import { workspaceCreateTool, workspaceProposeTool } from "../harness/tool/builtin/workspace-lifecycle-tool";
import { slateWriteSeedTool } from "../harness/tool/builtin/slate-tool";
import { createSession, persistHistory } from "../session/store";
import { openSlate } from "../session/slate-lifecycle";
import { CONFIRM_TOKEN_TTL_MS, consumeConfirmToken, mintConfirmToken } from "../sac/review-confirm-token";
import { wikiEnrich, type ProviderFactory } from "../wiki/enrich";

const RAW_SENTINEL = "AKIAIOSFODNN7EXAMPLE";
const TEST_TIMEOUT_MS = 30_000;
const roots = new Set<string>();
let originalDataDir: string | undefined;

afterEach(async () => {
  if (originalDataDir !== undefined) process.env.KERYX_DATA_DIR = originalDataDir;
  else delete process.env.KERYX_DATA_DIR;
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

function scriptedProvider(scripts: Partial<NormalizedEvent>[][]): ProviderPort {
  let call = 0;
  const description: ProviderDescription = {
    capabilities: {
      streaming: true,
      toolCalls: true,
      parallelToolCalls: false,
      structuredOutput: false,
      reasoningMetadata: false,
      promptCaching: false,
      vision: false,
      tokenCounting: false,
      modelListing: false,
    },
    descriptor: { providerId: "scripted" },
  };
  return {
    describe: () => description,
    stream: (_request: NormalizedRequest, opts: StreamOptions) => {
      const events = scripts[call++] ?? [];
      return (async function* (): AsyncGenerator<NormalizedEvent> {
        let sequence = 0;
        for (const partial of events) {
          yield { sequence: sequence++, attemptId: opts.attemptId, kind: "model_end", ...partial } as NormalizedEvent;
        }
      })();
    },
  };
}

function collectingIo(): { io: AgentIO; results: string[] } {
  const results: string[] = [];
  return {
    results,
    io: {
      write: () => {},
      onToolResult: (name, result) => results.push(`${name}:${result.isError ? "err" : "ok"}`),
    },
  };
}

async function runTaintedToolTurn(toolName: string, durableRisk: "read" | "write" = "read"): Promise<{
  invoked: boolean;
  results: string[];
}> {
  let invoked = false;
  const tools: InteractiveTool[] = [
    {
      definition: { name: "web_fetch", description: "", inputSchema: { type: "object", properties: {} }, risk: "read" },
      invoke: async () => ({ output: `untrusted ${RAW_SENTINEL}`, isError: false, untrusted: true }),
    },
    {
      definition: { name: toolName, description: "", inputSchema: { type: "object", properties: {} }, risk: durableRisk },
      invoke: async () => {
        invoked = true;
        return { output: "invoked", isError: false };
      },
    },
  ];
  const provider = scriptedProvider([
    [
      { kind: "tool_call_start", toolCallId: "web-1", toolName: "web_fetch" },
      { kind: "tool_call_end", toolCallId: "web-1", input: "{}" },
      { kind: "model_end" },
    ],
    [
      { kind: "tool_call_start", toolCallId: "durable-1", toolName },
      { kind: "tool_call_end", toolCallId: "durable-1", input: "{}" },
      { kind: "model_end" },
    ],
    [{ kind: "text_delta", text: "done" }, { kind: "model_end" }],
  ]);
  const { io, results } = collectingIo();
  const deps: AgentDeps = {
    provider,
    providerId: "scripted",
    modelId: "test",
    tools,
    systemInstruction: "test",
    idSeq: (() => {
      let id = 0;
      return () => `id-${id++}`;
    })(),
  };
  const history: NormalizedMessage[] = [];
  await runAgentTurn(io, deps, history, "fetch then act");
  return { invoked, results };
}

async function makeSecurityRoot(action: "redact" | "block", prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  roots.add(root);
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  await writeFile(
    path.join(root, ".metaproject", "metaproject.json"),
    JSON.stringify({ modules: { security: { enabled: true } } }),
    "utf8",
  );
  await writeFile(
    path.join(root, ".metaproject", "security.config.json"),
    JSON.stringify({
      mode: action === "block" ? "enforced" : "advisory",
      policies: { secrets: { enabled: true, action } },
    }),
    "utf8",
  );
  return root;
}

async function readTree(root: string): Promise<string> {
  const chunks: string[] = [];
  async function visit(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) {
        try {
          chunks.push(await readFile(absolute, "utf8"));
        } catch {
          // Binary/non-text artifact: irrelevant to the raw text sentinel contract.
        }
      }
    }
  }
  await visit(root);
  return chunks.join("\n");
}

async function assertProjectionPolicy(action: "redact" | "block"): Promise<void> {
  const root = await makeSecurityRoot(action, `keryx-web-taint-projections-${action}-`);
  const dataDir = await mkdtemp(path.join(tmpdir(), `keryx-web-taint-session-data-${action}-`));
  roots.add(dataDir);
  originalDataDir = process.env.KERYX_DATA_DIR;
  process.env.KERYX_DATA_DIR = dataDir;

  const handle = createSession({ cwd: root, title: "Security projection" });
  persistHistory(handle, [
    { role: "user", content: "Inspect external output", provenance: "project" },
    { role: "assistant", content: `Observed ${RAW_SENTINEL}`, provenance: "model" },
  ]);
  const archivePath = path.join(handle.dir, "archive.jsonl");
  const archive = await readFile(archivePath, "utf8");
  expect(archive).not.toContain(RAW_SENTINEL);
  if (action === "redact") expect(archive).toContain("[REDACTED:");

  await openSlate({ dir: handle.dir, cwd: root, mintAttemptId: () => "attempt-security" });
  const slateResult = await slateWriteSeedTool(
    () => handle.dir,
    () => "seed-security",
    () => "2026-08-26T00:00:00.000Z",
  ).invoke({ text: `candidate ${RAW_SENTINEL}` });
  expect(slateResult.isError).toBe(false);
  const slate = await readFile(path.join(handle.dir, "slate.json"), "utf8");
  expect(slate).not.toContain(RAW_SENTINEL);

  // Reintroduce a raw legacy archive only after verifying the session-store
  // boundary, proving session wrap-up independently materializes before write.
  await writeFile(
    archivePath,
    [
      JSON.stringify({ role: "user", content: "Inspect external output", ts: "2026-08-26T00:00:00.000Z", kind: "message" }),
      JSON.stringify({ role: "assistant", content: `Observed ${RAW_SENTINEL}`, ts: "2026-08-26T00:00:01.000Z", kind: "message" }),
    ].join("\n") + "\n",
    "utf8",
  );

  const created = await workspaceCreateTool(root).invoke({ title: "Security workspace" });
  expect(created.isError).toBe(false);
  const { id: workspaceId } = JSON.parse(created.output) as { id: string };
  const proposed = await workspaceProposeTool(root, () => handle.dir).invoke({
    workspaceId,
    kind: "memory-entry",
    note: `review note ${RAW_SENTINEL}`,
  });
  expect(proposed.isError).toBe(action === "block");

  const workspaceTree = await readTree(path.join(root, ".metaproject", "workspaces"));
  expect(workspaceTree).not.toContain(RAW_SENTINEL);
  if (action === "redact") expect(workspaceTree).toContain("[REDACTED:");
}

const WIKI_PAGE = `---
Title: Alpha
Version: 1.0.0
Type: component
Status: draft
Summary: Alpha page
---

# Alpha

Clean original content.
`;

function wikiProvider(reply: string): ProviderFactory {
  return () => ({
    describe: () => ({
      capabilities: {
        streaming: true,
        toolCalls: false,
        parallelToolCalls: false,
        structuredOutput: false,
        reasoningMetadata: false,
        promptCaching: false,
        vision: false,
        tokenCounting: false,
        modelListing: false,
      },
      descriptor: { providerId: "stub" },
    }),
    async *stream(_request: NormalizedRequest, opts: StreamOptions): AsyncIterable<NormalizedEvent> {
      yield { kind: "text_delta", sequence: 0, attemptId: opts.attemptId, text: reply };
      yield { kind: "model_end", sequence: 1, attemptId: opts.attemptId };
    },
  });
}

async function assertWikiPolicy(action: "redact" | "block", rlm: boolean): Promise<void> {
  const root = await makeSecurityRoot(action, `keryx-web-taint-wiki-${action}-${rlm ? "rlm" : "normal"}-`);
  const wikiDir = path.join(root, ".metaproject", "wiki", "components");
  const graphDir = path.join(root, ".metaproject", "data", "gdgraph", "storage");
  await mkdir(wikiDir, { recursive: true });
  await mkdir(graphDir, { recursive: true });
  await mkdir(path.join(root, "src", "alpha"), { recursive: true });
  await writeFile(path.join(wikiDir, "src-alpha.md"), WIKI_PAGE, "utf8");
  await writeFile(path.join(root, "src", "alpha", "a.ts"), "export const alpha = true;\n", "utf8");
  await writeFile(
    path.join(graphDir, "nodes.jsonl"),
    JSON.stringify({ id: "src/alpha/a.ts", kind: "file", path: "src/alpha/a.ts", language: "typescript" }) + "\n",
    "utf8",
  );
  await writeFile(path.join(graphDir, "edges.jsonl"), "", "utf8");
  await writeFile(
    path.join(root, ".metaproject", "wiki.config.json"),
    JSON.stringify({
      rlm: {
        enabled: rlm,
        classify: { skipMaxBytes: 0, deepMinPageRank: 999, deepMinFanIn: 999 },
        batch: { enabled: false },
      },
    }),
    "utf8",
  );
  const reply = WIKI_PAGE.replace("Clean original content.", `Generated content contains ${RAW_SENTINEL} and enough prose for a deterministic write.`);
  const result = await wikiEnrich({
    cwd: root,
    page: "components/src-alpha.md",
    providerFactory: wikiProvider(reply),
    validate: false,
  });
  const persisted = await readFile(path.join(wikiDir, "src-alpha.md"), "utf8");
  expect(persisted).not.toContain(RAW_SENTINEL);
  if (action === "redact") {
    expect(result.enriched).toBe(1);
    expect(persisted).toContain("[REDACTED:");
  } else {
    expect(result.failed).toBe(1);
    expect(persisted).toBe(WIKI_PAGE);
  }
}

describe("untrusted web output cannot authorize a durable read-risk tool", () => {
  test("workspace_create is denied before persistence while its raw sentinel is absent", async () => {
    const result = await runTaintedToolTurn("workspace_create");
    expect(result.invoked).toBe(false);
    expect(result.results).toContain("workspace_create:err");
  }, TEST_TIMEOUT_MS);

  test("workspace_propose is denied before persistence while its raw sentinel is absent", async () => {
    const result = await runTaintedToolTurn("workspace_propose");
    expect(result.invoked).toBe(false);
    expect(result.results).toContain("workspace_propose:err");
  }, TEST_TIMEOUT_MS);

  test("slate_write_seed is denied before persistence while its raw sentinel is absent", async () => {
    const result = await runTaintedToolTurn("slate_write_seed");
    expect(result.invoked).toBe(false);
    expect(result.results).toContain("slate_write_seed:err");
  }, TEST_TIMEOUT_MS);

  test("read_file remains permitted after untrusted web output", async () => {
    const result = await runTaintedToolTurn("read_file");
    expect(result.invoked).toBe(true);
    expect(result.results).toContain("read_file:ok");
  }, TEST_TIMEOUT_MS);
});

describe("raw web-taint never survives session and SAC projections", () => {
  test("redact: session archive, evidence, Slate, proposal record/note contain no raw sentinel", async () => {
    await assertProjectionPolicy("redact");
  }, TEST_TIMEOUT_MS);

  test("block: session archive, evidence, Slate, proposal record/note contain no raw sentinel", async () => {
    await assertProjectionPolicy("block");
  }, TEST_TIMEOUT_MS);
});

describe("normal and RLM wiki enrichment guard before the first write", () => {
  test("normal enrich obeys redact and persists no raw sentinel", async () => {
    await assertWikiPolicy("redact", false);
  }, TEST_TIMEOUT_MS);

  test("normal enrich obeys block and preserves the original page", async () => {
    await assertWikiPolicy("block", false);
  }, TEST_TIMEOUT_MS);

  test("RLM enrich obeys redact and persists no raw sentinel", async () => {
    await assertWikiPolicy("redact", true);
  }, TEST_TIMEOUT_MS);

  test("RLM enrich obeys block and preserves the original page", async () => {
    await assertWikiPolicy("block", true);
  }, TEST_TIMEOUT_MS);
});

describe("needs-approval acceptance requires an explicit human security acknowledgement", () => {
  test("a normal confirm token alone cannot confirm a needs-approval proposal", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "keryx-security-ack-required-"));
    roots.add(root);
    const { token } = await mintConfirmToken(root, "workspace-a", "proposal-a", {
      securityGate: "needs-approval",
      securityAcknowledged: false,
    });
    const result = await consumeConfirmToken(root, "workspace-a", "proposal-a", "idem-a", token, {
      securityGate: "needs-approval",
    });
    expect(result).toEqual({ ok: false, reason: "security_acknowledgement_required" });
  }, TEST_TIMEOUT_MS);

  test("acknowledgement stays bound, single-use and expiring while safe confirmation remains unchanged", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "keryx-security-ack-properties-"));
    roots.add(root);
    let now = new Date("2026-08-26T00:00:00.000Z");
    const acknowledged = await mintConfirmToken(root, "workspace-a", "proposal-a", {
      now: () => now,
      randomToken: () => "acknowledged-token",
      securityGate: "needs-approval",
      securityAcknowledged: true,
    });
    expect(await consumeConfirmToken(root, "workspace-other", "proposal-a", "idem-wrong", acknowledged.token, {
      now: () => now,
      securityGate: "needs-approval",
    })).toEqual({ ok: false, reason: "token_required" });
    expect(await consumeConfirmToken(root, "workspace-a", "proposal-a", "idem-a", acknowledged.token, {
      now: () => now,
      securityGate: "needs-approval",
    })).toEqual({ ok: true });
    expect(await consumeConfirmToken(root, "workspace-a", "proposal-a", "idem-b", acknowledged.token, {
      now: () => now,
      securityGate: "needs-approval",
    })).toEqual({ ok: false, reason: "token_invalid" });

    const expiring = await mintConfirmToken(root, "workspace-a", "proposal-expiring", {
      now: () => now,
      randomToken: () => "expiring-token",
      securityAcknowledged: true,
    });
    now = new Date(now.getTime() + CONFIRM_TOKEN_TTL_MS + 1);
    expect(await consumeConfirmToken(root, "workspace-a", "proposal-expiring", "idem-expired", expiring.token, {
      now: () => now,
      securityGate: "needs-approval",
    })).toEqual({ ok: false, reason: "token_invalid" });

    const safe = await mintConfirmToken(root, "workspace-safe", "proposal-safe", {
      now: () => now,
      randomToken: () => "safe-token",
    });
    expect(await consumeConfirmToken(root, "workspace-safe", "proposal-safe", "idem-safe", safe.token, {
      now: () => now,
      securityGate: "pass",
    })).toEqual({ ok: true });
  }, TEST_TIMEOUT_MS);
});
