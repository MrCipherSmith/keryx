// The matcher was `Bash` alone and `parseCommand` returned null for every other
// tool, which fails open. An agent that reached for its runtime's own search
// tool instead of the shell was not guarded at all — and the Bash guard then
// reported a clean run, which is worse than no guard: the routing audit records
// compliance that did not happen.
//
// The list of guarded tools is explicit and never a heuristic. Anything not
// named keeps failing open, and that is the property that makes the guard safe
// to leave installed.

import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
  CLAUDE_RUNTIME,
  PRE_TOOL_USE_MATCHER,
  nativeSearchMessage,
  parseToolName,
} from "./runtimes";

const CLI = path.join(import.meta.dir, "..", "cli.ts");
const REPO = path.join(import.meta.dir, "..", "..");

async function hook(payload: string): Promise<{ code: number; err: string }> {
  const proc = Bun.spawn(["bun", CLI, "ctx", "hook", "claude"], {
    cwd: REPO,
    stdin: new TextEncoder().encode(payload),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  return { code, err };
}

describe("the native search tool is guarded", () => {
  test("Grep is declared as a code search for claude", () => {
    expect(CLAUDE_RUNTIME.nativeSearchTools).toContain("Grep");
  });

  test("Glob is deliberately NOT guarded", () => {
    // It returns paths rather than file content, so it is not "a text, symbol,
    // or pattern search over project code" in the sense the rule means, and
    // guarding it would generate false blocks for no routing gain.
    expect(CLAUDE_RUNTIME.nativeSearchTools).not.toContain("Glob");
  });

  test("a Grep payload is refused, naming the replacement", async () => {
    const { code, err } = await hook(
      JSON.stringify({ tool_name: "Grep", tool_input: { pattern: "foo", path: "src/" } }),
    );
    expect(code).toBe(2);
    expect(err).toContain("keryx ctx rg");
    // Naming the replacement is the whole point; a bare denial teaches nothing.
    expect(err).toContain("gdgraph");
  }, 30000);

  test("the refusal stays escapable in practice, and says how", () => {
    // It carries no in-line marker of its own, so it must point at the path that
    // does — otherwise it is the one refusal a user cannot get past.
    expect(nativeSearchMessage("Grep")).toContain("# keryx:raw");
  });

  test("a tool that is neither Bash nor declared fails open", async () => {
    for (const tool of ["Read", "Edit", "Glob", "WebFetch"]) {
      const { code, err } = await hook(JSON.stringify({ tool_name: tool, tool_input: {} }));
      expect(code).toBe(0);
      expect(err).toBe("");
    }
  }, 60000);

  test("an unparseable payload fails open", async () => {
    for (const payload of ["", "not json", "[1,2,3]", "{}"]) {
      const { code } = await hook(payload);
      expect(code).toBe(0);
    }
  }, 60000);

  test("parseToolName reads the name and nothing else", () => {
    expect(parseToolName('{"tool_name":"Grep"}')).toBe("Grep");
    expect(parseToolName('{"tool_name":42}')).toBeNull();
    expect(parseToolName("garbage")).toBeNull();
  });
});

describe("an install written before the widening is reported stale", () => {
  const managed = (matcher: string) => ({
    hooks: {
      PreToolUse: [
        {
          matcher,
          hooks: [{ type: "command", command: "keryx ctx hook claude" }],
          _keryxManaged: "ctx-agent-hooks",
        },
      ],
    },
  });

  test("the current matcher covers both the shell and the native tool", () => {
    expect(PRE_TOOL_USE_MATCHER).toContain("Bash");
    expect(PRE_TOOL_USE_MATCHER).toContain("Grep");
  });

  test("a fresh install validates clean", () => {
    expect(CLAUDE_RUNTIME.validate?.(managed(PRE_TOOL_USE_MATCHER))).toEqual([]);
  });

  test("a Bash-only install is reported as needing reinstall, not as valid", () => {
    // Reporting it clean would make the fix invisible to everyone who already
    // ran install-hook — the settings file looks identical from the outside.
    const errors = CLAUDE_RUNTIME.validate?.(managed("Bash")) ?? [];
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("only Bash");
    expect(errors[0]).toContain("install-hook");
  });

  test("a missing guard is still reported as missing", () => {
    const errors = CLAUDE_RUNTIME.validate?.({}) ?? [];
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("missing");
  });
});
