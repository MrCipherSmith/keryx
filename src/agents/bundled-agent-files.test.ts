// Guard: a bundled agent definition file is Markdown-with-frontmatter, never
// wrapped in a pseudo-XML tag. flow 311's rename batch left a stray
// `</content>` as the literal last line of five renamed files — leftover
// from whatever produced the rewritten prose — and it would have shipped
// into every compiled prompt and export for that agent. This test reads the
// real files on disk (not a fixture) so the guard fails the moment such a
// tag reappears, in these files or any future bundled agent.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { loadAgentCatalog } from "./catalog";

const BUNDLED_AGENTS_DIR = path.join(import.meta.dir, "..", "gdskills", "bundled", "agents");

// Closing tags only (`</content>`, `</response>`, ...) — an OPENING
// placeholder like `<file>` is legitimate prose in these files (e.g.
// "keryx test related <file>") and must not trip this guard.
const PSEUDO_XML_CLOSING_TAG = /<\/[a-zA-Z][\w-]*>/;

describe("bundled agent files contain no stray pseudo-XML closing tags", () => {
  const files = readdirSync(BUNDLED_AGENTS_DIR).filter((f) => f.endsWith(".md"));

  test("at least one bundled agent file exists (guard is not vacuous)", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    test(`${file} has no </content> or other pseudo-XML closing tag`, () => {
      const content = readFileSync(path.join(BUNDLED_AGENTS_DIR, file), "utf8");
      const match = content.match(PSEUDO_XML_CLOSING_TAG);
      expect(match).toBeNull();
    });
  }
});

test("the bundled catalogue includes the four v2 review entities with one delegating coordinator", () => {
  const catalog = loadAgentCatalog(process.cwd());
  expect(catalog.errors).toEqual([]);
  const names = catalog.agents.map((agent) => agent.definition.name);
  for (const name of ["review-scout", "review-coordinator", "review-worker", "review-validator"]) {
    expect(names).toContain(name);
  }
  const coordinator = catalog.agents.find((agent) => agent.definition.name === "review-coordinator")?.definition;
  expect(coordinator?.execution_kind).toBe("orchestrator");
  expect(coordinator?.tool_scope).toBe("parent");
  expect(coordinator?.delegation?.max_depth).toBe(1);
  for (const name of ["review-scout", "review-worker", "review-validator"]) {
    const definition = catalog.agents.find((agent) => agent.definition.name === name)?.definition;
    expect(definition?.execution_kind).toBe("worker");
    expect(definition?.delegation?.max_children).toBe(0);
  }
});
