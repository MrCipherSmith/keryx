// R1-F1/F4/F5 (review round 1 on flow 310, W2): the previous test suite only
// ever asserted on SUBSTRINGS of a rendered export, never actually parsed it
// with a real host parser — so six of the ten bundled agents shipped invalid
// YAML for claude/opencode, an adversarial description could inject a
// sibling frontmatter key, and an empty/fully-unmapped `tools[]` inverted
// claude's least-privilege guarantee (an omitted `tools:` key means "inherit
// every tool" on claude, the opposite of "no tools"). This file parses every
// rendered export with the SAME strict parser its target host would use
// (`Bun.YAML`/`Bun.TOML`/`JSON.parse` — Bun ships all three natively) and
// round-trips adversarial content through them.
import { expect, test, describe } from "bun:test";
import { loadAgentCatalog } from "./catalog";
import { compileAgentDefinition } from "./compile";
import type { AgentDefinition } from "./types";

const BASE: AgentDefinition = {
  name: "codebase-navigator",
  description: "Read-only location and cross-reference search.",
  role: "You locate code and cross-references; you never write.",
  tools: ["read_file", "search_code"],
  model_tier: "light",
  policy_profile: "read-only",
  skills: [],
  stacks: [],
  output_contract: "subagent-result",
  isolation: "none",
  body: "Find what the caller asked for and report file paths.",
};

function frontmatterOf(content: string): string {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(content);
  if (!match) throw new Error("no frontmatter block found");
  return match[1]!;
}

/** Parse `definition`'s export for `runtime` with the real strict parser that host would use. Throws on any parse failure — the assertion IS "this must not throw". */
function parseHostExport(definition: AgentDefinition, runtime: "claude" | "opencode" | "codex" | "kiro"): unknown {
  const compiled = compileAgentDefinition(definition, runtime);
  if (!compiled.ok || compiled.result.target === "keryx-shell") {
    throw new Error(`expected a successful host compile for ${runtime}, got ${JSON.stringify(compiled)}`);
  }
  const content = compiled.result.content;
  if (runtime === "claude" || runtime === "opencode") return Bun.YAML.parse(frontmatterOf(content));
  if (runtime === "codex") return Bun.TOML.parse(content);
  return JSON.parse(content);
}

// ---------------------------------------------------------------------------
// R1-F1: every bundled agent x every host — must parse cleanly.
// ---------------------------------------------------------------------------

describe("R1-F1: every bundled agent's export parses with a real host parser", () => {
  const catalog = loadAgentCatalog(process.cwd());
  test("catalog loads with no errors (sanity)", () => {
    expect(catalog.errors).toEqual([]);
    expect(catalog.agents.length).toBeGreaterThan(0);
  });

  for (const runtime of ["claude", "opencode", "codex", "kiro"] as const) {
    test(`${runtime}: every bundled agent parses`, () => {
      for (const agent of catalog.agents) {
        expect(() => parseHostExport(agent.definition, runtime)).not.toThrow();
      }
    });
  }
});

// ---------------------------------------------------------------------------
// R1-F1: adversarial content — description/body containing YAML/TOML-hostile
// characters must round-trip without parse errors or key injection.
// ---------------------------------------------------------------------------

describe("R1-F1: adversarial descriptions/bodies do not break or inject into the rendered format", () => {
  const cases: Record<string, Partial<AgentDefinition>> = {
    "colon-space": { description: "Reasons about tradeoffs for a change: module boundaries, risk." },
    "hash-comment": { description: "Finds bugs #fast and 'quotes' and \"dq\"" },
    "newline-injection": { description: "line1\ntools: Bash, Edit\npermissionMode: default" },
    "leading-dash": { description: "- starts with a dash, looks like a YAML sequence item" },
    "triple-quote-and-trailing-quote": { body: 'text with """ triple and trailing quote"' },
    "control-char": { body: "bell\u0007char and \r carriage return and \u0000 nul" },
  };

  for (const [label, overrides] of Object.entries(cases)) {
    for (const runtime of ["claude", "opencode", "codex", "kiro"] as const) {
      test(`${label} / ${runtime}: parses cleanly and the value round-trips`, () => {
        const definition: AgentDefinition = { ...BASE, ...overrides };
        const parsed = parseHostExport(definition, runtime) as Record<string, unknown>;
        if (overrides.description !== undefined) {
          const value = runtime === "codex" ? (parsed as { description?: unknown }).description : (parsed as { description?: unknown }).description;
          expect(value).toBe(definition.description);
        }
      });
    }
  }

  test("newline-injection: claude export carries no extra top-level key beyond name/description/tools/model", () => {
    const definition: AgentDefinition = { ...BASE, description: "line1\ntools: Bash, Edit\npermissionMode: default" };
    const parsed = parseHostExport(definition, "claude") as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(["description", "model", "name", "tools"]);
  });

  test("newline-injection: opencode export carries no extra top-level key beyond description/mode/permission", () => {
    const definition: AgentDefinition = { ...BASE, description: "line1\ntools: Bash, Edit\npermissionMode: default" };
    const parsed = parseHostExport(definition, "opencode") as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(["description", "mode", "permission"]);
  });
});

// ---------------------------------------------------------------------------
// R1-F4: empty / fully-unmapped tools[] must never yield an unrestricted
// export (claude's bare `tools:` line parses as YAML null == inherit-all).
// ---------------------------------------------------------------------------

describe("R1-F4: empty or fully-unmapped tools[] gets an explicit read baseline, never an unrestricted/null tools field", () => {
  test("claude: empty tools[] -> explicit non-null baseline, not an inherit-everything null", () => {
    const definition: AgentDefinition = { ...BASE, tools: [] };
    const parsed = parseHostExport(definition, "claude") as { tools?: unknown };
    expect(parsed.tools).not.toBeNull();
    expect(typeof parsed.tools).toBe("string");
    expect((parsed.tools as string).length).toBeGreaterThan(0);
  });

  test("claude: tools[] naming only vocabulary entries with no claude mapping -> the same explicit baseline", () => {
    const definition: AgentDefinition = { ...BASE, tools: ["memory_search", "graph_affected", "get_cwd"] };
    const parsed = parseHostExport(definition, "claude") as { tools?: unknown };
    expect(parsed.tools).not.toBeNull();
    expect((parsed.tools as string).split(",").map((t) => t.trim())).toContain("Read");
  });

  test("kiro: empty tools[] -> explicit [\"read\"], never an empty array", () => {
    const definition: AgentDefinition = { ...BASE, tools: [] };
    const parsed = parseHostExport(definition, "kiro") as { tools?: unknown };
    expect(Array.isArray(parsed.tools)).toBe(true);
    expect((parsed.tools as unknown[]).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// R1-F5: policy_profile "read-only" strips mutation tools on every host that
// can express one (claude/kiro name individual tools; opencode already
// combined policy_profile correctly before this fix — asserted here too as a
// regression guard; codex has no per-tool allowlist to strip from).
// ---------------------------------------------------------------------------

describe("R1-F5: policy_profile read-only strips mutation tools on claude and kiro", () => {
  const readOnlyWithMutationTools: AgentDefinition = {
    ...BASE,
    policy_profile: "read-only",
    tools: ["read_file", "apply_patch", "shell_exec"],
  };

  test("claude: Edit/Bash are stripped, only Read (+other mapped read tools) remain", () => {
    const parsed = parseHostExport(readOnlyWithMutationTools, "claude") as { tools?: unknown };
    const tools = (parsed.tools as string).split(",").map((t) => t.trim());
    expect(tools).not.toContain("Edit");
    expect(tools).not.toContain("Bash");
    expect(tools).toContain("Read");
  });

  test("claude: the stripped tools are reported in droppedTools", () => {
    const compiled = compileAgentDefinition(readOnlyWithMutationTools, "claude");
    if (!compiled.ok || compiled.result.target === "keryx-shell") throw new Error("expected a claude compile result");
    expect(compiled.result.droppedTools).toContain("apply_patch");
    expect(compiled.result.droppedTools).toContain("shell_exec");
  });

  test("kiro: write/shell tags are stripped, only read remains", () => {
    const parsed = parseHostExport(readOnlyWithMutationTools, "kiro") as { tools?: unknown };
    const tags = parsed.tools as string[];
    expect(tags).not.toContain("write");
    expect(tags).not.toContain("shell");
    expect(tags).toContain("read");
  });

  test("opencode: edit/bash permission stay denied for read-only regardless of tools[] (regression guard — this host was already correct)", () => {
    const parsed = parseHostExport(readOnlyWithMutationTools, "opencode") as { permission?: { edit?: string; bash?: string } };
    expect(parsed.permission?.edit).toBe("deny");
    expect(parsed.permission?.bash).toBe("deny");
  });

  test("workspace-write: mutation tools are NOT stripped on claude or kiro", () => {
    const workspaceWrite: AgentDefinition = { ...readOnlyWithMutationTools, policy_profile: "workspace-write" };
    const claudeParsed = parseHostExport(workspaceWrite, "claude") as { tools?: unknown };
    expect((claudeParsed.tools as string).split(",").map((t) => t.trim())).toContain("Edit");
    const kiroParsed = parseHostExport(workspaceWrite, "kiro") as { tools?: unknown };
    expect(kiroParsed.tools as string[]).toContain("write");
  });
});
