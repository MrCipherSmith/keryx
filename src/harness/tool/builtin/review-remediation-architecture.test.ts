import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  createSpawnSubagentTool,
  type SpawnSubagentFleetEvent,
} from "./spawn-subagent-tool";
import type { NormalizedEvent, ProviderPort, StreamOptions } from "../../provider/types";

const source = (relativePath: string): Promise<string> => readFile(new URL(relativePath, import.meta.url), "utf8");

/**
 * Extracts runtime ES-module dependencies from source text. `import type` is
 * intentionally excluded: it is erased by TypeScript and cannot form a
 * runtime SCC.
 */
function runtimeImports(text: string): string[] {
  const result: string[] = [];
  const expression = /^\s*import\s+(type\s+)?(?:(?:[\s\S]*?)\s+from\s+)?["']([^"']+)["'];?/gm;
  for (const match of text.matchAll(expression)) {
    const specifier = match[2];
    if (match[1] === undefined && specifier !== undefined) result.push(specifier);
  }
  return result;
}

function hasRuntimeCycle(graph: ReadonlyMap<string, readonly string[]>): boolean {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (node: string): boolean => {
    if (visiting.has(node)) return true;
    if (visited.has(node)) return false;
    visiting.add(node);
    for (const dependency of graph.get(node) ?? []) {
      if (visit(dependency)) return true;
    }
    visiting.delete(node);
    visited.add(node);
    return false;
  };
  return [...graph.keys()].some(visit);
}

test("review remediation keeps shell and SAC runtime boundaries acyclic", async () => {
  const [backgroundRegistry, shellSpawn, spawnSubagent, machineWrapUp, proposalLifecycle, sessionWrapUp] = await Promise.all([
    source("./background-job-registry.ts"),
    source("../../process/shell-spawn.ts"),
    source("./spawn-subagent-tool.ts"),
    source("../../../sac/machine-wrap-up.ts"),
    source("../../../sac/proposal-lifecycle.ts"),
    source("../../../sac/session-wrap-up.ts"),
  ]);

  const backgroundImports = runtimeImports(backgroundRegistry);
  expect(backgroundImports).toContain("../../process/shell-spawn");
  expect(backgroundImports).not.toContain("./shell-exec-tool");
  expect(runtimeImports(shellSpawn)).not.toContain("../tool/builtin/shell-exec-tool");

  const spawnImports = runtimeImports(spawnSubagent);
  expect(spawnImports.some((specifier) => specifier.includes("/tui/") || specifier.startsWith("../../../tui/"))).toBe(false);
  expect(runtimeImports('import type { OnlyAtCompileTime } from "./type-only";')).toEqual([]);

  const sacImports = new Map<string, readonly string[]>([
    ["machine-wrap-up", runtimeImports(machineWrapUp).filter((specifier) => specifier.startsWith("./"))],
    ["proposal-lifecycle", runtimeImports(proposalLifecycle).filter((specifier) => specifier.startsWith("./"))],
    ["session-wrap-up", runtimeImports(sessionWrapUp).filter((specifier) => specifier.startsWith("./"))],
  ]);
  const sacGraph = new Map<string, readonly string[]>(
    [...sacImports].map(([module, dependencies]) => [
      module,
      dependencies
        .map((specifier) => specifier.replace(/^\.\//, ""))
        .filter((dependency) => sacImports.has(dependency)),
    ]),
  );
  expect(hasRuntimeCycle(sacGraph)).toBe(false);

  for (const dependencies of sacImports.values()) {
    expect(dependencies.some((specifier) => /(?:^|\/)commands\/workspace(?:\.ts)?$/.test(specifier))).toBe(false);
  }
});

function stubProvider(text: string): ProviderPort {
  return {
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
      descriptor: { providerId: "architecture-stub" },
    }),
    async *stream(_request, options: StreamOptions): AsyncIterable<NormalizedEvent> {
      yield { kind: "text_delta", sequence: 0, attemptId: options.attemptId, text };
      yield { kind: "model_end", sequence: 1, attemptId: options.attemptId };
    },
  };
}

function createTool(onFleetEvent?: (event: SpawnSubagentFleetEvent) => void) {
  return createSpawnSubagentTool({
    cwd: process.cwd(),
    getParentModel: () => ({ providerId: "ollama", modelId: "architecture" }),
    makeProvider: () => stubProvider("Boundary check completed."),
    getDetectedProviders: () => [{ name: "ollama" }],
    idSeq: () => "architecture-child",
    clock: () => "2026-08-26T00:00:00.000Z",
    ...(onFleetEvent === undefined ? {} : { onFleetEvent }),
  });
}

test("spawn_subagent supports injected fleet events and an absent headless sink", async () => {
  const events: SpawnSubagentFleetEvent[] = [];
  const eventedResult = await createTool((event) => events.push(event)).invoke({
    task: "Check the architecture boundary",
    label: "architecture-check",
    mode: "read_only",
  });
  expect(eventedResult.isError).toBe(false);
  expect(events.some((event) => event.kind === "upsert" && event.status === "running")).toBe(true);
  expect(events.some((event) => event.kind === "log" && event.entry.kind === "text")).toBe(true);
  expect(events.some((event) => event.kind === "upsert" && event.status === "done")).toBe(true);

  const headlessResult = await createTool().invoke({
    task: "Check the headless architecture boundary",
    label: "headless-architecture-check",
    mode: "read_only",
  });
  expect(headlessResult.isError).toBe(false);
  expect(headlessResult.output).toContain("Boundary check completed.");
});
