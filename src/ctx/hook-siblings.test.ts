// Three defects round 3 of PR #431 found and recorded rather than fixed.
//
// They are one flow because they share a file, not a cause. Each is pinned here
// because that review's standing lesson was blunt: across three rounds the guard
// and the prose describing the regression it prevents both shipped, and the
// assertion did not. Every test below was checked by reverting its fix.

import { describe, expect, test } from "bun:test";
import path from "node:path";
import { classifyCommand } from "./hook-classify";
import {
  ANTIGRAVITY_RUNTIME,
  CLAUDE_RUNTIME,
  CURSOR_RUNTIME,
  preToolUseMatcher,
} from "./runtimes";

const CLI = path.join(import.meta.dir, "..", "cli.ts");
const REPO = path.join(import.meta.dir, "..", "..");

describe("ctx hook cannot be wedged by a stdin that never closes", () => {
  test("it exits on an unfed pipe instead of waiting forever", async () => {
    // `ctx hook` is a PreToolUse gate, so hanging is worse than allowing: it
    // wedges the tool call rather than failing open, which is the opposite of
    // what the module header promises. PR #431 bounded the SAME read in `orient`
    // and argued exactly this in that fix's own comment; hook.ts was edited in
    // the same commit range and left. Measured before this fix: still running at
    // 14s, and one attempt ran past 120s.
    const proc = Bun.spawn(["bun", CLI, "ctx", "hook", "claude"], {
      cwd: REPO,
      stdin: "pipe", // opened, never written, never closed
      stdout: "pipe",
      stderr: "pipe",
    });
    const settled = await Promise.race([
      proc.exited.then((code) => ({ code })),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 20000)),
    ]);
    if (settled === null) {
      proc.kill();
      throw new Error("ctx hook did not exit with an unfed stdin — the read was not released");
    }
    // Fail-open is the contract: no payload arrived, so nothing is refused.
    expect(settled.code).toBe(0);
  }, 40000);

  test("a real payload is still read and still refused", async () => {
    // The deadline must not cost the guard its job. This is the half a careless
    // bound would break silently.
    const proc = Bun.spawn(["bun", CLI, "ctx", "hook", "claude"], {
      cwd: REPO,
      stdin: new TextEncoder().encode(
        JSON.stringify({ tool_name: "Bash", tool_input: { command: "grep -rn foo src/" } }),
      ),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(code).toBe(2);
    expect(err).toContain("keryx ctx rg");
  }, 30000);
});

describe("ownership of an installed guard is decided in one place", () => {
  const antigravity = (hookEntry: Record<string, unknown>) => ({
    "keryx-ctx-guard": {
      PreToolUse: [
        { matcher: "run_command", hooks: [hookEntry], _keryxManaged: "ctx-agent-hooks" },
      ],
    },
  });

  test("every runtime declares the shape it writes", () => {
    // "Either shape counts for everyone" is what let a flat group validate clean
    // for a nested-shape runtime. The shape is now a fact each runtime states.
    expect(CLAUDE_RUNTIME.groupShape).toBe("nested");
    expect(CURSOR_RUNTIME.groupShape).toBe("flat");
    expect(ANTIGRAVITY_RUNTIME.groupShape).toBe("nested");
    expect(ANTIGRAVITY_RUNTIME.groupContainer).toBe("keryx-ctx-guard");
  });

  test("antigravity no longer reports an inert entry as clean", () => {
    // It had its own hand-rolled walker matching on `command` alone. A harness
    // executes only type:"command", so this install never ran and validate said
    // it was fine. The comment on the shared walker predicted this in as many
    // words, and the fourth shape was already in the file when it was written.
    const inert = ANTIGRAVITY_RUNTIME.validate?.(
      antigravity({ type: "prompt", command: "keryx ctx hook antigravity" }) as never,
    );
    expect(inert).toHaveLength(1);
    expect(inert?.[0]).toContain("missing");

    const live = ANTIGRAVITY_RUNTIME.validate?.(
      antigravity({ type: "command", command: "keryx ctx hook antigravity" }) as never,
    );
    expect(live).toEqual([]);
  });

  test("a flat-shaped group does not validate clean for a nested-shape runtime", () => {
    const flatForClaude = {
      hooks: {
        PreToolUse: [
          {
            matcher: preToolUseMatcher(CLAUDE_RUNTIME),
            command: "keryx ctx hook claude", // cursor's shape, which claude never runs
            _keryxManaged: "ctx-agent-hooks",
          },
        ],
      },
    };
    const errors = CLAUDE_RUNTIME.validate?.(flatForClaude as never) ?? [];
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("missing");
  });
});

describe("the escape marker is only an escape where a shell would see one", () => {
  const verdict = (c: string) => (classifyCommand(c).block ? "block" : "pass");

  test("a quoted marker does not opt the command out", () => {
    // Searching the guard's own source, tests or docs for the marker silently
    // disabled the guard for that command. `splitPipeline` in the same file was
    // taught that a `|` inside quotes is not a pipe; this was left quote-blind.
    expect(verdict("grep -rn '#keryx:raw' src/")).toBe("block");
    expect(verdict('grep -rn "#keryx:raw" src/')).toBe("block");
    expect(verdict("git log --grep='# keryx:raw'")).toBe("block");
  });

  test("a genuine trailing marker still works, and still returns its reason", () => {
    const result = classifyCommand("grep -rn foo src/ # keryx:raw comparing against a vendored copy");
    expect(result.block).toBe(false);
    expect(result.escapeReason).toBe("comparing against a vendored copy");
  });

  test("the marker is what allows it — the same command without one blocks", () => {
    expect(verdict("grep -rn foo src/")).toBe("block");
  });
});
