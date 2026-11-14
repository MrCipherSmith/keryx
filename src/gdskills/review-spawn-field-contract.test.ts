import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import {
  SPAWN_SUBAGENT_IGNORED_FIELDS,
  createSpawnSubagentTool,
} from "../harness/tool/builtin/spawn-subagent-tool";
import { MODEL_CLASSES } from "../harness/routing/model-class";

/**
 * AC7 (flow 488): a bundled review skill must only tell the model to pass
 * `spawn_subagent` fields the tool acts on. The orchestrator once told models to
 * pass `model_tier`, which the tool accepts and silently ignores, so every
 * reviewer ran on the parent's model. The accepted and ignored names are read
 * from the tool's own schema and exported constant, not copied here.
 */

const REVIEW_SKILLS_ROOT = path.join(process.cwd(), "src", "gdskills", "bundled", "skills", "review");

const tool = createSpawnSubagentTool({
  cwd: process.cwd(),
  getParentModel: () => ({ providerId: "anthropic", modelId: "claude-sonnet-5" }),
  makeProvider: () => {
    throw new Error("not used");
  },
  getDetectedProviders: () => [{ name: "anthropic" }],
  idSeq: () => "id-0",
  clock: () => "2026-01-01T00:00:00.000Z",
});

const schema = tool.definition.inputSchema as { properties: Record<string, unknown> };
const IGNORED: readonly string[] = SPAWN_SUBAGENT_IGNORED_FIELDS;
const ACCEPTED = new Set(Object.keys(schema.properties).filter((name) => !IGNORED.includes(name)));
// Other snake_case tool names share lines with spawn_subagent (`review_complete`,
// `memory_search`), so an unknown name is judged a mistyped spawn field only when it
// shares the first word of a real one (`model_`, `max_`, `context_`, ...). `review_`
// is left out: it prefixes the unrelated review tools.
const FIELD_PREFIXES = new Set(
  [...ACCEPTED, ...IGNORED].map((name) => name.split("_")[0]!).filter((word) => word !== "review"),
);

function isRejectedField(field: string): boolean {
  if (IGNORED.includes(field)) return true;
  if (ACCEPTED.has(field)) return false;
  return FIELD_PREFIXES.has(field.split("_")[0]!);
}

function markdownFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...markdownFiles(full));
    else if (entry.name.endsWith(".md")) out.push(full);
  }
  return out;
}

/** Backticked snake_case names on every line that mentions `spawn_subagent`. */
function spawnFieldMentions(markdown: string): { line: number; field: string }[] {
  const found: { line: number; field: string }[] = [];
  markdown.split("\n").forEach((text, index) => {
    if (!text.includes("spawn_subagent")) return;
    for (const match of text.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g)) {
      if (match[1] === "spawn_subagent") continue;
      found.push({ line: index + 1, field: match[1]! });
    }
  });
  return found;
}

describe("bundled review skills only name spawn_subagent fields the tool acts on", () => {
  test("the schema accepts model_class with every class and ignores model_tier", () => {
    expect(ACCEPTED.has("model_class")).toBe(true);
    expect(IGNORED).toContain("model_tier");
    const modelClass = schema.properties.model_class as { enum: string[] };
    expect(modelClass.enum).toEqual([...MODEL_CLASSES]);
  });

  test("the scanner flags an unknown field that looks like a spawn field", () => {
    expect(isRejectedField("model_levl")).toBe(true);
    expect(isRejectedField("model_class")).toBe(false);
    expect(isRejectedField("memory_search")).toBe(false);
  });

  test("the scanner flags an ignored field", () => {
    const hits = spawnFieldMentions("On `spawn_subagent` pass its tier as `model_tier` on every reviewer");
    expect(hits.map((h) => h.field)).toEqual(["model_tier"]);
    expect(isRejectedField("model_tier")).toBe(true);
  });

  const files = markdownFiles(REVIEW_SKILLS_ROOT);

  test("there are review skill files to scan", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    const rel = path.relative(process.cwd(), file);
    test(`${rel}`, () => {
      const bad = spawnFieldMentions(readFileSync(file, "utf8")).filter(({ field }) => isRejectedField(field));
      expect(bad.map(({ line, field }) => `${rel}:${line} names \`${field}\``)).toEqual([]);
    });
  }
});
