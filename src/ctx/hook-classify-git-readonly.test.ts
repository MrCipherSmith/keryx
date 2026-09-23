import { describe, expect, test } from "bun:test";
import { classifyCommand } from "./hook-classify";

// W7-AC9 / GDCTX-3 hook friction register: a small set of read-only `git`
// subcommands must pass through the ctx routing guard exactly like
// `git status` already does today — never blocked, never require a
// `# keryx:raw` escape marker. This is the Wave-0 exit metric "false-block
// rate on the allowlist is zero" — every row in the first table must report
// block: false, or the allowlist has a false positive.
describe("false-block rate on the allowlist is zero (W7-AC9)", () => {
  const allowed: string[] = [
    "git status",
    "git status --short",
    "git status -s",
    "git blame src/ctx/hook-classify.ts",
    "git branch",
    "git branch -a",
    "git branch -v",
    "git branch -D some-branch", // routing-only guard: a delete flag is not this hook's concern
    "git tag",
    "git tag -l",
    "git log --oneline -5",
    "git log --oneline -n 5",
    "git log --oneline -n5",
    "git log --oneline --max-count=5",
    "git log --oneline --max-count 5",
    "git diff --stat",
    "git diff --shortstat",
    "git diff --numstat",
    "git diff --stat HEAD~1",
    "git diff --stat --cached",
    "git diff --stat --staged",
    "git log --oneline -5 --decorate",
    "git log --oneline -5 --graph",
    "git log --oneline -5 --no-merges",
    "git log --oneline -5 --first-parent",
    "git log --oneline -5 --reverse",
    "git log --oneline -200", // exactly at the cap
    "git -C some/dir status",
    "git -C some/dir log --oneline -3",
  ];

  for (const cmd of allowed) {
    test(`allows: ${cmd}`, () => {
      const result = classifyCommand(cmd);
      expect(result.block).toBe(false);
      expect(result.escapeReason).toBeUndefined();
    });
  }
});

// The allowlist must not swallow the commands that genuinely need `keryx ctx`
// routing — an unbounded/patch-producing form of the same subcommand, or a
// subcommand the allowlist never covers.
describe("must-stay-routed git forms are still blocked", () => {
  const routed: string[] = [
    "git diff",
    "git diff src/ctx/hook-classify.ts",
    "git diff HEAD~1",
    "git log",
    "git log --oneline", // no bound
    "git log -5", // bound, but no --oneline
    "git log -p -5", // patch output, even with a bound
    "git log --oneline -5 -p", // patch output, even with --oneline and a bound
    "git log --oneline -5 --stat", // per-commit stat block is not a bounded summary
    "git show",
    "git show HEAD",
    "git show --stat", // spec keeps `show --stat` routed, unlike `diff --stat`

    // F5 regression: the previous denylist-of-unsafe-modifiers admitted these
    // patch-producing forms because none of them was individually named as
    // unsafe. The fix switches to an explicit SAFE-flag allowlist, so any
    // flag not on that list falls through unclassified (routed) instead of
    // needing to be named here.
    "git diff --stat -p", // reviewer example: 4297-line patch despite --stat
    "git diff --numstat -U999",
    "git diff --stat=200", // width argument is a distinct token from the bare flag
    "git diff --dirstat",
    "git diff --word-diff",
    "git diff --cc",
    "git log --oneline -5 -U5",
    "git log --oneline -5 --word-diff",
    "git log --oneline -5 --cc",
    "git log --oneline -5 -L1,400:f",
    "git log --oneline -5 --remerge-diff",
    "git log --oneline -5 --format=%B",
    "git log --oneline -5 --pretty=fuller",
    "git log --oneline -100000", // bound present but exceeds the 200-commit cap
  ];

  for (const cmd of routed) {
    test(`stays routed: ${cmd}`, () => {
      const result = classifyCommand(cmd);
      expect(result.block).toBe(true);
      expect(result.matched).toContain("git");
    });
  }
});

test("a compound command still blocks when another stage is blocked", () => {
  // `git status` itself is allowed, but `cat file` in the same compound
  // command is not — the allowlist must not leak permission across `&&`.
  const result = classifyCommand("git status && cat file");
  expect(result.block).toBe(true);
  expect(result.matched).toBe("cat");
});

test("git -C <path> resolves the real subcommand, not the -C flag itself", () => {
  expect(classifyCommand("git -C some/dir diff HEAD~1").block).toBe(true);
  expect(classifyCommand("git -C some/dir status").block).toBe(false);
});
