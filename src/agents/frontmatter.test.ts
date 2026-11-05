import { describe, expect, test } from "bun:test";
import { parseAgentFrontmatter } from "./frontmatter";

const SAMPLE = `---
name: codebase-navigator
description: Read-only location and cross-reference search.
role: You locate code and cross-references; you never write.
tools: [read_file, search_code]
model_tier: light
policy_profile: read-only
output_contract: subagent-result
schema_version: 1
skills:
  - find-docs
  - grep-search
origin:
  kind: generated
  sourceRef: typescript
  generatedAt: 2026-09-24T00:00:00.000Z
---

Find what the caller asked for and report file paths.
`;

describe("parseAgentFrontmatter", () => {
  test("parses scalars, a flow array, a block array, and a nested origin mapping", () => {
    const result = parseAgentFrontmatter(SAMPLE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.data.name).toBe("codebase-navigator");
    expect(result.result.data.tools).toEqual(["read_file", "search_code"]);
    expect(result.result.data.skills).toEqual(["find-docs", "grep-search"]);
    expect(result.result.data.schema_version).toBe(1);
    expect(result.result.data.origin).toEqual({
      kind: "generated",
      sourceRef: "typescript",
      generatedAt: "2026-09-24T00:00:00.000Z",
    });
    expect(result.result.body).toBe("\nFind what the caller asked for and report file paths.\n");
  });

  test("an empty flow array parses to []", () => {
    const result = parseAgentFrontmatter("---\nname: x\ntools: []\n---\nbody\n");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.data.tools).toEqual([]);
  });

  test("quoted scalars are unquoted", () => {
    const result = parseAgentFrontmatter('---\nname: "quoted-name"\n---\nbody\n');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.data.name).toBe("quoted-name");
  });

  test("missing the opening `---` delimiter is a named error, never a throw", () => {
    const result = parseAgentFrontmatter("name: x\nbody text\n");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe("missing-delimiter");
  });

  test("an unterminated frontmatter block is a named error", () => {
    const result = parseAgentFrontmatter("---\nname: x\nno closing delimiter\n");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe("unterminated-block");
  });

  test("a line that is not a recognizable `key: value` pair is skipped, forgivingly", () => {
    const result = parseAgentFrontmatter("---\nname: x\nthis is not a key-value line\nrole: y\n---\nbody\n");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.data.name).toBe("x");
    expect(result.result.data.role).toBe("y");
  });

  test("parses the v2 delegation mapping with a nested entity list and integer bounds", () => {
    const result = parseAgentFrontmatter(`---
schema_version: 2
name: review-coordinator
delegation:
  allowed_entities: [review-worker, review-validator]
  max_depth: 1
  max_children: 48
---
body
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.data.delegation).toEqual({
      allowed_entities: ["review-worker", "review-validator"],
      max_depth: 1,
      max_children: 48,
    });
  });

  test("keeps hostile nested keys as own data for schema rejection without prototype mutation", () => {
    const result = parseAgentFrontmatter("---\nname: review-coordinator\ndelegation:\n  __proto__: polluted\n---\nbody\n");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const delegation = result.result.data.delegation as Record<string, unknown>;
    expect(Object.hasOwn(delegation, "__proto__")).toBe(true);
    expect(delegation.__proto__).toBe("polluted");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
