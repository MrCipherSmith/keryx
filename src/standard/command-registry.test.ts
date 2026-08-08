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
      if (descriptor.module === "core") {
        expect(CORE_COMMANDS).toContain(descriptor.command);
      } else {
        expect(descriptor.command.startsWith(moduleStem(descriptor.module))).toBe(true);
      }
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

  test("matchIntent resolves sandbox-status phrases (flow 142 / P4, AC6)", () => {
    expect(matchIntent("sandbox status")[0]?.command).toBe("sandbox status");
    expect(matchIntent("is bubblewrap installed")[0]?.command).toBe("sandbox status");
    expect(matchIntent("проверь sandbox")[0]?.command).toBe("sandbox status");
  });

  test("matchIntent resolves the maintenance phrases to their commands", () => {
    // The maintenance descriptors added ~40 intent phrases. The intent index is
    // the agent-facing contract, so a collision or a ranking regression between
    // the three "статус …" phrases would be silent without this.
    const cases: ReadonlyArray<[string, string]> = [
      ["построй граф", "gdgraph build"],
      ["собери вики", "wiki collect"],
      ["проверь ссылки вики", "wiki check-links"],
      ["проанализируй тесты", "test analyze"],
      ["статус тестов", "test status"],
      ["переиндексируй память", "memory index"],
      ["статус ctx", "ctx status"],
      ["статус проекта", "status"],
      ["статус модулей", "modules status"],
    ];
    for (const [phrase, command] of cases) {
      expect(matchIntent(phrase)[0]?.command).toBe(command);
    }
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

/**
 * `core` is the toolkit itself, and its commands carry no module prefix. An
 * empty stem would satisfy `startsWith` for literally anything, disabling the
 * invariant for a whole module — so the members are enumerated instead. Adding
 * a core command means adding it here, which is the point.
 */
const CORE_COMMANDS: readonly string[] = [
  "status",
  "modules status",
  "projects list",
  "projects register",
  "projects forget",
];
