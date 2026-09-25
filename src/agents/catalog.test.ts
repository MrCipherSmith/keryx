// Catalog loader tests: fixtures in a temp dir (bundledRoot injectable, per
// plan.md's module layout), covering override, stem mismatch, and invalid
// frontmatter — named errors, never a throw.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { loadAgentCatalog } from "./catalog";

let root: string;
let bundledRoot: string;
let projectRoot: string;

function writeAgent(dir: string, stem: string, content: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${stem}.md`), content, "utf8");
}

const VALID_BODY = "Do the thing.";

function agentMarkdown(name: string, overrides: Record<string, string> = {}): string {
  const fields: Record<string, string> = {
    name,
    description: `Description for ${name}.`,
    role: `Role for ${name}.`,
    tools: "[read_file]",
    model_tier: "light",
    policy_profile: "read-only",
    output_contract: "subagent-result",
    ...overrides,
  };
  const lines = Object.entries(fields).map(([key, value]) => `${key}: ${value}`);
  return `---\n${lines.join("\n")}\n---\n\n${VALID_BODY}\n`;
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "keryx-agents-catalog-"));
  bundledRoot = path.join(root, "bundled-agents");
  projectRoot = path.join(root, "project");
  mkdirSync(bundledRoot, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("loadAgentCatalog", () => {
  test("loads a bundled definition", () => {
    writeAgent(bundledRoot, "codebase-navigator", agentMarkdown("codebase-navigator"));
    const catalog = loadAgentCatalog(projectRoot, { bundledRoot });
    expect(catalog.errors).toEqual([]);
    expect(catalog.agents.map((a) => a.definition.name)).toEqual(["codebase-navigator"]);
    expect(catalog.agents[0]?.source.kind).toBe("bundled");
  });

  test("a project definition of the same name overrides the bundled one", () => {
    writeAgent(bundledRoot, "codebase-navigator", agentMarkdown("codebase-navigator", { role: "Bundled role." }));
    writeAgent(
      path.join(projectRoot, ".metaproject", "agents"),
      "codebase-navigator",
      agentMarkdown("codebase-navigator", { role: "Project role." }),
    );
    const catalog = loadAgentCatalog(projectRoot, { bundledRoot });
    expect(catalog.errors).toEqual([]);
    expect(catalog.agents).toHaveLength(1);
    expect(catalog.agents[0]?.source.kind).toBe("project");
    expect(catalog.agents[0]?.definition.role).toBe("Project role.");
  });

  test("a second file whose declared name collides with another's is caught as a stem mismatch (the stem invariant makes true same-source duplicates unreachable on disk)", () => {
    // Two different files in the same source directory both declaring `name: codebase-navigator`:
    // the second one's OWN stem ("codebase-navigator-2") no longer matches its declared name, so
    // `name-stem-mismatch` fires for it before the duplicate-name check would ever see it —
    // which is exactly why a same-source duplicate can only happen if that invariant is later
    // relaxed (e.g. a second accepted file extension), the scenario `duplicate-name` guards.
    writeAgent(bundledRoot, "codebase-navigator", agentMarkdown("codebase-navigator"));
    writeAgent(bundledRoot, "codebase-navigator-2", agentMarkdown("codebase-navigator"));
    const catalog = loadAgentCatalog(projectRoot, { bundledRoot });
    expect(catalog.agents.map((a) => a.definition.name)).toEqual(["codebase-navigator"]);
    expect(catalog.errors.some((e) => e.reason === "name-stem-mismatch" && e.path.endsWith("codebase-navigator-2.md"))).toBe(
      true,
    );
  });

  test("a file stem that does not match the declared name is a named error", () => {
    writeAgent(bundledRoot, "wrong-stem", agentMarkdown("codebase-navigator"));
    const catalog = loadAgentCatalog(projectRoot, { bundledRoot });
    expect(catalog.agents).toEqual([]);
    expect(catalog.errors).toHaveLength(1);
    expect(catalog.errors[0]?.reason).toBe("name-stem-mismatch");
  });

  test("invalid frontmatter (no closing delimiter) is a named error", () => {
    writeAgent(bundledRoot, "broken", "---\nname: broken\nno closing delimiter here\n");
    const catalog = loadAgentCatalog(projectRoot, { bundledRoot });
    expect(catalog.agents).toEqual([]);
    expect(catalog.errors).toHaveLength(1);
    expect(catalog.errors[0]?.reason).toBe("invalid-frontmatter");
  });

  test("a schema-invalid definition (missing required field) is a named error with details", () => {
    writeAgent(bundledRoot, "incomplete", "---\nname: incomplete\ndescription: x\n---\n\nbody\n");
    const catalog = loadAgentCatalog(projectRoot, { bundledRoot });
    expect(catalog.agents).toEqual([]);
    expect(catalog.errors).toHaveLength(1);
    expect(catalog.errors[0]?.reason).toBe("invalid-schema");
    expect(catalog.errors[0]?.details?.length).toBeGreaterThan(0);
  });

  test("missing bundled and project directories yield an empty, error-free catalog", () => {
    const catalog = loadAgentCatalog(path.join(root, "does-not-exist"), {
      bundledRoot: path.join(root, "also-does-not-exist"),
    });
    expect(catalog.agents).toEqual([]);
    expect(catalog.errors).toEqual([]);
  });
});
