import { describe, expect, test } from "bun:test";
import {
  COMMAND_DESCRIPTORS,
  emitCommandsJson,
  listDescriptors,
  matchIntent,
  renderCommandsMarkdown,
  renderIntentTable,
} from "./command-registry";

describe("command-registry", () => {
  test("every descriptor is well-formed", () => {
    for (const descriptor of COMMAND_DESCRIPTORS) {
      expect(descriptor.module.length).toBeGreaterThan(0);
      expect(descriptor.command.startsWith(moduleStem(descriptor.module))).toBe(true);
      expect(descriptor.summary.length).toBeGreaterThan(0);
      expect(descriptor.intent.length).toBeGreaterThan(0);
      for (const arg of descriptor.args) {
        expect(arg.name.length).toBeGreaterThan(0);
        expect(arg.desc.length).toBeGreaterThan(0);
        if (arg.type === "enum") {
          expect(Array.isArray(arg.values) && arg.values.length > 0).toBe(true);
        }
      }
      // A model command must name its prompt template.
      if (descriptor.model) {
        expect(descriptor.promptTemplate).toBeDefined();
      }
    }
  });

  test("listDescriptors is deterministically sorted", () => {
    const first = listDescriptors();
    const second = listDescriptors();
    expect(first).toEqual(second);
    const keys = first.map((descriptor) => `${descriptor.module} ${descriptor.command}`);
    expect(keys).toEqual([...keys].sort());
  });

  test("module filter narrows the set", () => {
    const wiki = listDescriptors("gdwiki");
    expect(wiki.length).toBeGreaterThan(0);
    expect(wiki.every((descriptor) => descriptor.module === "gdwiki")).toBe(true);
  });

  test("emitCommandsJson is stable, versioned JSON", () => {
    const once = emitCommandsJson();
    const twice = emitCommandsJson();
    expect(once).toBe(twice);
    const parsed = JSON.parse(once) as { schemaVersion: number; commands: unknown[] };
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.commands.length).toBe(COMMAND_DESCRIPTORS.length);
  });

  test("matchIntent resolves the wiki-index phrase", () => {
    const matches = matchIntent("сделай индексацию вики");
    expect(matches[0]?.command).toBe("wiki index");
  });

  test("matchIntent resolves the wiki-enrich phrase", () => {
    const matches = matchIntent("обогати вики");
    expect(matches[0]?.command).toBe("wiki enrich");
  });

  test("markdown rendering includes model + json badges", () => {
    const markdown = renderCommandsMarkdown("gdwiki");
    expect(markdown).toContain("keryx wiki enrich");
    expect(markdown).toContain("model");
    expect(markdown).toContain("prompt template");
  });

  test("intent table pairs every phrase with its command", () => {
    const table = renderIntentTable();
    expect(table).toContain("| обогати вики | `keryx wiki enrich` |");
    expect(table.startsWith("| User intent | Command |")).toBe(true);
  });
});

function moduleStem(module: string): string {
  // Command stems use the CLI verb, which differs from the module key for a few
  // modules (gdwiki -> wiki, gdctx -> ctx, tasks -> flow, memory -> memory).
  const map: Record<string, string> = {
    gdwiki: "wiki",
    gdctx: "ctx",
    tasks: "flow",
    gdgraph: "gdgraph",
    memory: "memory",
    health: "health",
    testing: "test",
    security: "security",
  };
  return map[module] ?? module;
}
