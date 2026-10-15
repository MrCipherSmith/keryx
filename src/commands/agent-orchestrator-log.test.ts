// Flow 454 AC5: in a scripted agent session with a review package active, the parent's `keryx memory search`
// shell command and its built-in `memory_search` are recorded as the orchestrator, the same call by a
// `spawn_subagent` child is recorded under the child's reviewer id, and `KERYX_REVIEW_CALLER` is in the child's
// command environment and not in the parent's.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDefaultSearchProviderController } from "../harness/search";
import { createMetaprojectAdapter } from "../harness/tool/metaproject-adapter";
import { builtinMetaprojectTools, makeKeryxRunner } from "../harness/tool/builtin/metaproject-tools";
import { createSpawnSubagentTool } from "../harness/tool/builtin/spawn-subagent-tool";
import { memoryCalls } from "../review/layers-usage";
import { createManagedReviewPackage } from "../review/managed";
import { ENV_REVIEW_CALLER, ENV_REVIEW_RECORDED, orchestratorLogPath, startOrchestratorLog, withOrchestratorLog } from "../review/orchestrator-log";
import { callRound, collectingIo, makeDeps, okReply, scriptedProvider } from "./agent.test-helpers";
import { runAgentTurn } from "./agent";
import { buildInteractiveAgentTools } from "./interactive-agent-tools";

const SCHEMA = path.resolve(import.meta.dir, "..", "..", "docs", "requirements", "managed-review-feedback-loop", "schemas", "managed-review-package.schema.json");
const QUERY = "canary deploys";

let root = "";
let stubDir = "";
let stubLog = "";
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "keryx-agent-orch-log-"));
  stubDir = mkdtempSync(path.join(tmpdir(), "keryx-agent-orch-bin-"));
  stubLog = path.join(stubDir, "calls.log");
  mkdirSync(path.join(root, ".metaproject"), { recursive: true });
  writeFileSync(path.join(root, ".metaproject", "metaproject.json"), "{}");
  const schemas = path.join(root, "docs", "requirements", "managed-review-feedback-loop", "schemas");
  mkdirSync(schemas, { recursive: true });
  writeFileSync(path.join(schemas, "managed-review-package.schema.json"), readFileSync(SCHEMA, "utf8"));

  // A `keryx` that only reports the environment it was started with: what a memory command would have seen.
  const stub = path.join(stubDir, "keryx");
  writeFileSync(stub, `#!/bin/sh\nprintf '%s|%s|%s\\n' "\${${ENV_REVIEW_CALLER}-unset}" "\${${ENV_REVIEW_RECORDED}-unset}" "$*" >> '${stubLog}'\necho stub\n`);
  chmodSync(stub, 0o755);

  for (const key of [ENV_REVIEW_CALLER, ENV_REVIEW_RECORDED, "PATH"]) saved[key] = process.env[key];
  delete process.env[ENV_REVIEW_CALLER];
  delete process.env[ENV_REVIEW_RECORDED];
  process.env.PATH = `${stubDir}${path.delimiter}${saved.PATH ?? ""}`;
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
  rmSync(stubDir, { recursive: true, force: true });
});

async function startReview(): Promise<string> {
  const created = await createManagedReviewPackage({
    cwd: root,
    mode: "review-flow",
    reviewId: "r-agent",
    target: { kind: "branch", ref: "feat/x" },
    coverage: [{ reviewer: "review-style", status: "skipped", reason: "not selected for the fixture" }],
  });
  await startOrchestratorLog(root, created.reviewId, created.path);
  return path.resolve(root, created.path);
}

function session(childRequestTools: string[][]) {
  const child = scriptedProvider([callRound("child-1", "memory_search", JSON.stringify({ query: QUERY })), okReply]);
  const spawnTool = createSpawnSubagentTool({
    cwd: root,
    getParentModel: () => ({ providerId: "ollama", modelId: "fake" }),
    makeProvider: () => ({
      ...child.provider,
      stream: (request, options) => {
        childRequestTools.push((request.tools ?? []).map((tool) => tool.name));
        return child.provider.stream(request, options);
      },
    }),
    getDetectedProviders: () => [{ name: "ollama" }],
    idSeq: (() => {
      let n = 0;
      return () => `id-${n++}`;
    })(),
    clock: () => "2026-10-15T10:00:00.000Z",
  });
  return buildInteractiveAgentTools({
    cwd: root,
    metaprojectPort: createMetaprojectAdapter(root),
    searchController: createDefaultSearchProviderController(),
    spawnTool,
  });
}

async function turn(tools: ReturnType<typeof session>, rounds: ReturnType<typeof callRound>[]): Promise<string[]> {
  const { provider } = scriptedProvider([...rounds, okReply]);
  const results: string[] = [];
  const { io } = collectingIo();
  await runAgentTurn(
    { ...io, requestApproval: async () => true, onToolResult: (name, result) => void results.push(`${name}:${result.isError ? "err" : "ok"}`) },
    makeDeps(provider, { tools }),
    [],
    "check what we decided about canary deploys",
  );
  return results;
}

describe("AC5: a scripted agent session records its memory calls under their caller", () => {
  test("the parent is the orchestrator and a spawn_subagent child is recorded under its own id", async () => {
    const dir = await startReview();
    const childTools: string[][] = [];
    const tools = session(childTools);

    // One turn per actor keeps each under the per-turn round cap.
    await turn(tools, [callRound("p-shell", "shell_exec", JSON.stringify({ command: `keryx memory search "${QUERY}" --status accepted` }))]);
    await turn(tools, [callRound("p-tool", "memory_search", JSON.stringify({ query: QUERY }))]);
    const spawned = await turn(tools, [callRound("p-spawn", "spawn_subagent", JSON.stringify({ task: "look up canary deploys", mode: "read_only", label: "review-logic" }))]);
    expect(spawned.some((line) => line.startsWith("spawn_subagent:"))).toBe(true);

    const calls = memoryCalls(readFileSync(orchestratorLogPath(dir), "utf8"));
    expect(calls.map((call) => call.caller)).toEqual(["orchestrator", "orchestrator", "review-logic"]);
    expect(calls.every((call) => call.search)).toBe(true);
    expect(calls.map((call) => call.query)).toEqual([QUERY, QUERY, QUERY]);
    expect(calls[0]?.accepted).toBe(true);
  });

  test("the parent's shell command carries no caller marker and its in-process memory_search starts no process", async () => {
    const dir = await startReview();
    const tools = session([]);
    await turn(tools, [callRound("p-shell", "shell_exec", JSON.stringify({ command: `keryx memory search "${QUERY}"` }))]);
    await turn(tools, [callRound("p-tool", "memory_search", JSON.stringify({ query: QUERY }))]);
    await turn(tools, [callRound("p-spawn", "spawn_subagent", JSON.stringify({ task: "look up canary deploys", mode: "read_only", label: "review-logic" }))]);

    // Each `keryx` process: the caller marker it carries, the marker that says a keryx layer recorded it, its argv.
    // Only the shell command starts one; the port answers `memory_search` in-process for the parent and the child.
    expect(readFileSync(stubLog, "utf8").trim().split("\n")).toEqual([`unset|1|memory search ${QUERY}`]);
    expect(memoryCalls(readFileSync(orchestratorLogPath(dir), "utf8"))).toHaveLength(3);
  });

  test("a runner-backed child tool starts its keryx process with the child's id, and the call is still one line", async () => {
    const dir = await startReview();
    const reviewer = "review-logic";
    const [search] = builtinMetaprojectTools(root, makeKeryxRunner(root, undefined, reviewer)).filter((tool) => tool.definition.name === "memory_search");
    expect(search).toBeDefined();
    const wrapped = withOrchestratorLog(search!, { cwd: root, caller: reviewer });
    const result = await wrapped.invoke({ query: QUERY });
    expect(result.isError).toBe(false);
    expect(readFileSync(stubLog, "utf8").trim().split("\n")).toEqual([`${reviewer}|1|memory search ${QUERY}`]);
    expect(memoryCalls(readFileSync(orchestratorLogPath(dir), "utf8")).map((call) => call.caller)).toEqual([reviewer]);
  });

  test("the child has no shell, so its keryx runner is its whole command environment", async () => {
    await startReview();
    const childTools: string[][] = [];
    await turn(session(childTools), [callRound("p-spawn", "spawn_subagent", JSON.stringify({ task: "look up", mode: "read_only", label: "review-logic" }))]);
    expect(childTools[0]).toContain("memory_search");
    expect(childTools[0]).not.toContain("shell_exec");
  });

  test("a caller marker inherited from the process never reaches the orchestrator's runner", async () => {
    process.env[ENV_REVIEW_CALLER] = "leaked";
    const probe = ["sh", "-c", `printf '%s' "\${${ENV_REVIEW_CALLER}-unset}"`, "sh"];
    const parent = await makeKeryxRunner(root, probe)([]);
    const child = await makeKeryxRunner(root, probe, "review-logic")([]);
    expect(parent.output).toBe("unset");
    expect(child.output).toBe("review-logic");
  });
});
