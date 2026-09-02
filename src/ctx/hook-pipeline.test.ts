// A command downstream of a pipe reads STDIN. It is filtering a stream, not
// searching a tree.
//
// The classifier split on `||`, `&&`, `;`, `|` and newline all at once and
// classified every piece as though it named a file. So the guard refused
// `npm test | grep -E 'Tests'`, `bun test 2>&1 | tail -5`, and — the case that
// gives the game away — `keryx ctx rg 'foo' | grep -c 'bar'`: routing the search
// exactly as the rule demands and then counting the results was refused. That is
// the failure mode that gets a hook uninstalled, and the most likely reason this
// guard is opt-in while every other module hook is installed by `keryx init`.
//
// The fix must not overshoot in the other direction, which is the expensive one:
// piping a code search into a pager does not stop it being a code search.

import { describe, expect, test } from "bun:test";
import { classifyCommand } from "./hook-classify";

const verdict = (command: string) => (classifyCommand(command).block ? "block" : "pass");

describe("filtering piped output is not a code search", () => {
  const ALLOWED = [
    "npm run test:unit | grep -E 'Test Files|Tests '",
    "bun test 2>&1 | tail -5",
    "echo hi | grep hi",
    "keryx ctx rg 'foo' | grep -c 'bar'",
    "bun run typecheck | grep error",
    "ls -la | head -20",
  ];

  for (const command of ALLOWED) {
    test(`pass: ${command}`, () => {
      expect(verdict(command)).toBe("pass");
    });
  }
});

describe("the first stage of a statement is still classified", () => {
  const BLOCKED: ReadonlyArray<readonly [string, string]> = [
    ["grep -rn 'foo' src/", "a plain recursive search"],
    ["grep -n 'foo' src/some/file.ts", "a search with a file operand"],
    ["grep -rn 'foo' src/ | head -20", "piping a code search into a pager does not stop it being one"],
    ["rg 'foo' src/ | wc -l", "same, counted rather than paged"],
    ["cd x && rg y", "the sequencing case the shallow split exists to catch"],
    ["cat f | rg y", "now caught at `cat f`, which is the more accurate place"],
    ["find . -name '*.ts'", "large listings are routed too"],
  ];

  for (const [command, why] of BLOCKED) {
    test(`block: ${command} — ${why}`, () => {
      expect(verdict(command)).toBe("block");
    });
  }
});

describe("the outside proposal's own specimens", () => {
  // A proposal filed from another session listed five pass/block cases as the
  // detail that "decides whether the hook survives its first day". Four are now
  // as it asked. The fifth is a deliberate divergence and is asserted as such,
  // so that changing it later is a decision rather than an accident.
  const SPECIMENS: ReadonlyArray<readonly [string, "pass" | "block", string]> = [
    ["npm run test:unit | grep -E 'Test Files|Tests '", "pass", "agreed"],
    ["keryx ctx rg 'foo' | grep -c 'bar'", "pass", "agreed"],
    ["grep -rn 'foo' src/", "block", "agreed"],
    ["grep -n 'foo' src/some/file.ts", "block", "agreed"],
    [
      "git log --format=%B | grep -v '^Co-Authored-By'",
      "block",
      "DIVERGENCE: `git log` is in the guard for output volume, not for being a code search. A downstream filter does not bound it, `keryx ctx run -- <command>` exists for exactly this, and the escape marker covers the exception.",
    ],
  ];

  for (const [command, want, note] of SPECIMENS) {
    test(`${want}: ${command} (${note.slice(0, 40)})`, () => {
      expect(verdict(command)).toBe(want);
    });
  }
});

describe("the escape marker still works", () => {
  test("a raw command with a reason is allowed, and the reason is returned", () => {
    const result = classifyCommand("grep -rn 'foo' src/ # keryx:raw comparing against a vendored copy");
    expect(result.block).toBe(false);
    expect(result.escapeReason).toBe("comparing against a vendored copy");
  });

  test("the marker is what allows it — without it the same command blocks", () => {
    expect(verdict("grep -rn 'foo' src/")).toBe("block");
  });
});
