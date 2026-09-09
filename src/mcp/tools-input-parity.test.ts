// Input parity for the bespoke MCP tools in `./tools.ts` (flow 235 T8).
//
// The unified metaproject operations gained the filters their backing already
// accepted; `memory.search` is the bespoke MCP tool over the SAME adapter
// method (`createMetaprojectAdapter(cwd).memorySearch`, measured byte-identical
// to the unified `memory_search` result), so withholding those filters here
// would leave the identical capability half-reachable depending only on which
// of the two names a client happened to call.

import { expect, test } from "bun:test";
import { buildToolRegistry } from "./tools";

function schemaProperties(name: string): Record<string, unknown> {
  const tool = buildToolRegistry().find((entry) => entry.name === name);
  if (!tool) throw new Error(`no such tool: ${name}`);
  return (tool.inputSchema.properties ?? {}) as Record<string, unknown>;
}

test("memory.search exposes the module / class / limit narrowing its backing accepts", () => {
  const props = schemaProperties("memory.search");
  expect(props).toHaveProperty("query");
  expect(props).toHaveProperty("module");
  expect(props).toHaveProperty("class");
  expect(props).toHaveProperty("limit");
});

test("memory.search rejects an invalid class through the same structured-error contract", async () => {
  const tool = buildToolRegistry().find((entry) => entry.name === "memory.search")!;
  const result = (await tool.invoke(
    process.cwd(),
    { query: "worktree", class: "not-a-class" },
    undefined as never,
  )) as { hits: unknown[]; error?: string };
  // The adapter's documented contract: invalid input is an `error` field on a
  // normal result with empty `hits`, never a throw.
  expect(result.error).toBe("memory class is invalid");
  expect(result.hits).toEqual([]);
});
