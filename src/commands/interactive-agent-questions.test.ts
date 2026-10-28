import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildInteractiveAgentTools, type InteractiveAgentToolsInput } from "./interactive-agent-tools";
import { createDefaultSearchProviderController } from "../harness/search";
import { createMetaprojectAdapter } from "../harness/tool/metaproject-adapter";
import type { AskUserFn } from "../harness/tool/builtin/ask-user-tool";

test("separate headless tool rosters deliver questions to their own session, without a TUI global host", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "keryx-headless-questions-"));
  const seen: string[] = [];
  const input = (id: string): InteractiveAgentToolsInput & { askUser: AskUserFn } => ({
    cwd, metaprojectPort: createMetaprojectAdapter(cwd), searchController: createDefaultSearchProviderController(),
    spawnTool: { definition: { name: "spawn_subagent", description: "unused", inputSchema: {}, risk: "delegate" }, invoke: async () => ({ output: "unused", isError: true }) },
    askUser: async (question) => { seen.push(`${id}:${question.question}`); return id; },
  });
  try {
    const a = buildInteractiveAgentTools(input("alpha")).find((tool) => tool.definition.name === "ask_user")!;
    const b = buildInteractiveAgentTools(input("beta")).find((tool) => tool.definition.name === "ask_user")!;
    const question = { question: "Which?", options: [{ id: "alpha", label: "A", description: "A" }, { id: "beta", label: "B", description: "B" }] };
    const [one, two] = await Promise.all([a.invoke(question), b.invoke(question)]);
    expect(seen.sort()).toEqual(["alpha:Which?", "beta:Which?"]);
    expect(one.output).toContain("alpha");
    expect(two.output).toContain("beta");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
