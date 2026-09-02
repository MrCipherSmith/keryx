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
  CODEX_RUNTIME,
  describeExistingGuard,
  preToolUseMatcher,
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

describe("an install that would not do its job is reported, not called clean", () => {
  const group = (overrides: Record<string, unknown> = {}) => ({
    matcher: preToolUseMatcher(CLAUDE_RUNTIME),
    hooks: [{ type: "command", command: "keryx ctx hook claude" }],
    _keryxManaged: "ctx-agent-hooks",
    ...overrides,
  });
  const settings = (overrides?: Record<string, unknown>) => ({ hooks: { PreToolUse: [group(overrides)] } });
  const validate = (s: unknown) => CLAUDE_RUNTIME.validate?.(s as never) ?? [];

  test("the matcher is derived from the runtime's own tool list, not declared twice", () => {
    // It used to be a module constant beside a per-runtime `nativeSearchTools`
    // with nothing tying them together, so adding a tool without editing the
    // constant meant the refusal never ran and validate still said clean.
    expect(preToolUseMatcher(CLAUDE_RUNTIME)).toBe("Bash|Grep");
    expect(preToolUseMatcher({})).toBe("Bash");
    expect(preToolUseMatcher({ nativeSearchTools: ["Grep", "Search"] })).toBe("Bash|Grep|Search");
  });

  test("a fresh install validates clean", () => {
    expect(validate(settings())).toEqual([]);
  });

  test("every shape that would silently under-cover is reported", () => {
    // All four were reported CLEAN before. The module fails toward reporting: a
    // guard that covers less than it claims is the defect this check exists for.
    for (const [label, overrides] of [
      ["a Bash-only matcher", { matcher: "Bash" }],
      ["an absent matcher", { matcher: undefined }],
      ["a non-string matcher", { matcher: 123 }],
      ["a null matcher", { matcher: null }],
    ] as const) {
      const errors = validate(settings(overrides as Record<string, unknown>));
      expect(errors.length, label).toBe(1);
      expect(errors[0], label).toContain("install-hook");
    }
  });

  test('a hook entry of type "prompt" is not an installed guard', () => {
    // A harness executes only `type: "command"` entries, so a one-word edit left
    // an install that validate called current and that never ran. Matching on
    // the command alone reported it clean.
    const errors = validate({
      hooks: {
        PreToolUse: [
          { ...group(), hooks: [{ type: "prompt", command: "keryx ctx hook claude" }] },
        ],
      },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("missing");
  });

  test("a missing guard is still reported as missing", () => {
    expect(validate({})).toHaveLength(1);
    expect(validate({})[0]).toContain("missing");
  });
});

describe("the drift check can actually reach a pre-install state", () => {
  // `installRuntimeHook` merges and THEN validates what it just wrote, so
  // `validate` never sees a stale install and its stale branch could not fire in
  // production at all — the tests reached it only by calling validate directly
  // with an object the installer can never produce. `describeExistingGuard` is
  // read before the merge, which is the only moment the old state exists.
  const stale = {
    hooks: {
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [{ type: "command", command: "keryx ctx hook claude" }],
          _keryxManaged: "ctx-agent-hooks",
        },
      ],
    },
  };

  test("it names what would be replaced", () => {
    const described = describeExistingGuard(stale as never, CLAUDE_RUNTIME);
    expect(described).toContain("Bash");
    expect(described).toContain("Bash|Grep");
  });

  test("it says nothing when there is nothing to upgrade", () => {
    expect(describeExistingGuard({} as never, CLAUDE_RUNTIME)).toBeNull();
    const current = {
      hooks: {
        PreToolUse: [
          {
            matcher: preToolUseMatcher(CLAUDE_RUNTIME),
            hooks: [{ type: "command", command: "keryx ctx hook claude" }],
            _keryxManaged: "ctx-agent-hooks",
          },
        ],
      },
    };
    expect(describeExistingGuard(current as never, CLAUDE_RUNTIME)).toBeNull();
  });
});

describe("codex declares only what is evidenced", () => {
  test("codex does not claim a Grep tool", () => {
    // Nothing in the repo evidences that codex names a search tool `Grep`; the
    // only `--tools Read Grep Glob` reference is about `claude`. Declaring it
    // widened codex's installed matcher for something that never fires.
    expect(CODEX_RUNTIME.nativeSearchTools).toBeUndefined();
    expect(preToolUseMatcher(CODEX_RUNTIME)).toBe("Bash");
  });

  test("claude still declares Grep, so the mechanism is live", () => {
    expect(CLAUDE_RUNTIME.nativeSearchTools).toContain("Grep");
  });
});
