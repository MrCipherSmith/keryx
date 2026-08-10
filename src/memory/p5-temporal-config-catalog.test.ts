import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_MEMORY_CONFIG, loadMemoryConfig } from "./config";
import {
  isValidCalendarDate,
  isValidAt,
  validateCalendarDate,
} from "./temporal";
import { searchEntries } from "./search";
import { collectEntries } from "./store";
import { relevantAcceptedMemory, proceduralMemoryForScope } from "./relevant";
import { createMemoryService } from "./service";
import { MemoryValidationError } from "./validation";
import { MEMORY_TYPES } from "./types";
import type { MemoryEntry } from "./types";
import type { SearchFilters } from "./types";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "keryx-memory-p5-"));
  await mkdir(path.join(root, ".metaproject", "memory", "decisions"), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function entry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    absolutePath: "",
    relativePath: "decisions/example.md",
    type: "decision",
    title: "Temporal example",
    version: "1.0.0",
    status: "accepted",
    confidence: "high",
    summary: "temporal cache guidance",
    details: "",
    tags: ["temporal"],
    scopes: { module: "memory", entity: null, files: [], skills: [] },
    created: "2026-01-01",
    updated: "2026-01-01",
    provenance: { source: null, link: null },
    validFrom: null,
    validTo: null,
    supersededBy: null,
    ...overrides,
  };
}

function memoryMarkdown(title: string, extra = ""): string {
  return `# ${title}\n\nVersion: 1.0.0\nType: decision\nStatus: accepted\nValid-From: 2026-01-01\n${extra}\n## Summary\n\n${title} temporal cache guidance.\n\n## Related Scopes\n\n- Module: memory\n`;
}

test("P5 shared temporal helper validates real calendar dates and exclusive intervals", () => {
  expect(isValidCalendarDate("2024-02-29")).toBe(true);
  expect(isValidCalendarDate("2023-02-29")).toBe(false);
  expect(isValidCalendarDate("2026-04-31")).toBe(false);
  expect(() => validateCalendarDate("2026-02-30", "Valid-To")).toThrow();

  const bounded = entry({ validFrom: "2024-02-01", validTo: "2024-03-01" });
  expect(isValidAt(bounded, "2024-02-01")).toBe(true);
  expect(isValidAt(bounded, "2024-02-29")).toBe(true);
  expect(isValidAt(bounded, "2024-03-01")).toBe(false);
  expect(isValidAt(entry({ validFrom: "2026-04-01" }), "2026-03-31")).toBe(false);
  expect(isValidAt(entry(), "2026-08-10")).toBe(true);
});

test("P5 all recall selectors share temporal boundaries", async () => {
  const entries = [
    entry({ relativePath: "decisions/boundary.md", validFrom: "2026-01-01", validTo: "2026-08-10" }),
    entry({ relativePath: "decisions/current.md", validFrom: "2026-01-01", validTo: "2026-08-11" }),
  ];
  const config = { ...DEFAULT_MEMORY_CONFIG };
  const searchPaths = searchEntries(entries, "temporal", {}, config, new Date("2026-08-10"))
    .map((result) => result.entry.relativePath);
  expect(searchPaths).toEqual(["decisions/current.md"]);
  await writeFile(
    path.join(root, ".metaproject", "memory", "decisions", "current.md"),
    memoryMarkdown("Current", "Valid-To: 2026-08-11"),
    "utf8",
  );
  await writeFile(
    path.join(root, ".metaproject", "memory", "decisions", "boundary.md"),
    memoryMarkdown("Boundary", "Valid-To: 2026-08-10"),
    "utf8",
  );
  const scope = { module: "memory", target: "temporal", files: [] };
  expect((await relevantAcceptedMemory(root, scope, 10, new Date("2026-08-10"))).map((e) => e.title)).toEqual(["Current"]);
  expect((await proceduralMemoryForScope(root, scope, 10, ["semantic"], new Date("2026-08-10"))).map((e) => e.title)).toEqual(["Current"]);
});

test("P5 old configs deep-merge, ignore allowAutoAccept, and retain every known type", async () => {
  await writeFile(
    path.join(root, ".metaproject", "memory.config.json"),
    JSON.stringify({ ingest: { defaultStatus: "accepted", allowAutoAccept: true } }),
    "utf8",
  );
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
  try {
    const config = await loadMemoryConfig(root);
    expect(config.ingest.defaultStatus).toBe("accepted");
    expect("allowAutoAccept" in config.ingest).toBe(false);
    expect(config.typing.injectLimit).toBe(DEFAULT_MEMORY_CONFIG.typing.injectLimit);
    expect(MEMORY_TYPES.every((type) => !Object.prototype.hasOwnProperty.call(type, "template"))).toBe(true);
  } finally {
    console.warn = originalWarn;
  }
  expect(warnings.some((warning) => warning.includes("allowAutoAccept"))).toBe(true);
});

test("P5 missing catalog is advisory and lexical recall is unchanged after generated data deletion", async () => {
  await writeFile(path.join(root, ".metaproject", "memory", "decisions", "one.md"), memoryMarkdown("One"), "utf8");
  const service = createMemoryService();
  const before = await service.search({ cwd: root, query: "temporal" });
  const check = await service.check({ cwd: root });
  expect(check.ok).toBe(true);
  await service.index({ cwd: root });
  const catalog = path.join(root, ".metaproject", "data", "memory", "index", "index.json");
  await rm(catalog);
  const after = await service.search({ cwd: root, query: "temporal" });
  expect(JSON.stringify(after.results.map((result) => ({ path: result.entry.relativePath, score: result.score })))).toBe(
    JSON.stringify(before.results.map((result) => ({ path: result.entry.relativePath, score: result.score }))),
  );
  expect(await readFile(path.join(root, ".metaproject", "memory", "decisions", "one.md"), "utf8")).toContain("One");
});

test("P5 service input validation is structured and actionable", async () => {
  const service = createMemoryService();
  for (const [field, filters] of [
    ["status", { status: "unknown" }],
    ["class", { class: "unknown" }],
    ["limit", { limit: 0 }],
    ["as-of", { asOf: "2026-02-30" }],
  ] as const) {
    try {
      await service.search({ cwd: root, query: "cache", filters: filters as unknown as SearchFilters });
      throw new Error(`expected ${field} validation`);
    } catch (error) {
      expect(error).toBeInstanceOf(MemoryValidationError);
      expect((error as MemoryValidationError).field).toBe(field);
      expect((error as MemoryValidationError).action.length).toBeGreaterThan(0);
    }
  }
  try {
    await service.search({ cwd: root, query: "x".repeat(4097) });
    throw new Error("expected query validation");
  } catch (error) {
    expect(error).toBeInstanceOf(MemoryValidationError);
    expect((error as MemoryValidationError).field).toBe("query");
  }
});
