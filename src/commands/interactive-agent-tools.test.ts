import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultSearchProviderController } from "../harness/search";
import { createMetaprojectAdapter } from "../harness/tool/metaproject-adapter";
import type { InteractiveTool } from "../harness/tool/builtin/interactive-tools";
import { buildInteractiveAgentTools, interactiveAgentToolNames } from "./interactive-agent-tools";

const stubSpawn: InteractiveTool = {
  definition: {
    name: "spawn_subagent",
    description: "stub",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    risk: "read",
  },
  invoke: async () => ({ output: "ok", isError: false }),
};

test("TUI and readline share one factory that includes web_fetch", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "keryx-tools-"));
  const tools = buildInteractiveAgentTools({
    cwd,
    metaprojectPort: createMetaprojectAdapter(cwd),
    searchController: createDefaultSearchProviderController(),
    spawnTool: stubSpawn,
  });
  const names = interactiveAgentToolNames(tools);
  expect(names).toContain("web_fetch");
  expect(names).toContain("web_search");
  expect(names).toContain("shell_exec");
  expect(names).toContain("workspace_overview");
  expect(names).toContain("spawn_subagent");
  expect(names.filter((name) => name === "web_fetch")).toHaveLength(1);
});
