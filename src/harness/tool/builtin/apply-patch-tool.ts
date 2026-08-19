// apply_patch tool for interactive agent mode (ADR-0010).
//
// The `write`-risk complement to `shell_exec`: mutates project files via a
// standard multi-file unified diff instead of a shell command. Applies
// in-process via a CONSTRAINED, argv-only `git apply` subprocess call — the
// patch travels over STDIN, never as a shell-interpolated argument, so there
// is no metacharacter-injection surface analogous to `shell_exec`'s (mirrors
// `metaproject-tools.ts`'s `makeKeryxRunner`: `Bun.spawn([...])`, never a
// shell string). Every target path is confined to the project root via
// `confineToRoot` BEFORE git ever runs; a single escaping path rejects the
// WHOLE patch — nothing is written. Risk `write`, gated by `executeCall`'s
// ADR-0010 branch — never runs except through the DEFAULT-DENY approval
// gate. No custom hunk-matching code lives here: `git apply`'s own
// context-matching (fails closed on ambiguity) is the correctness boundary.

import { confineToRoot, type InteractiveTool, type InteractiveToolResult } from "./interactive-tools";
import { parsePatchTargets, type PatchTarget } from "../../../lib/patch-risk";

const MAX_OUTPUT_BYTES = 20_000;

/** Outcome of one `git apply` invocation (check or real apply). */
export interface GitApplyResult {
  ok: boolean;
  error?: string;
}

/** Runs `git apply --check` then `git apply` against `patch` in `cwd`. Injectable for tests. */
export type GitApplyRunner = (patch: string, cwd: string) => Promise<GitApplyResult>;

/** One `git apply` subprocess call, patch fed over stdin, argv fixed. Never throws. */
async function spawnGitApply(args: string[], patch: string, cwd: string): Promise<GitApplyResult> {
  try {
    const proc = Bun.spawn(["git", ...args], { cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    proc.stdin.write(patch);
    await proc.stdin.end();
    const [stderr] = await Promise.all([new Response(proc.stderr).text()]);
    const exit = await proc.exited;
    if (exit !== 0) {
      const bounded = stderr.length > MAX_OUTPUT_BYTES ? `${stderr.slice(0, MAX_OUTPUT_BYTES)}\n…(truncated)` : stderr;
      return {
        ok: false,
        error: bounded.trim().length > 0 ? bounded.trim() : `git ${args.join(" ")} exited with code ${exit}`,
      };
    }
    return { ok: true };
  } catch (cause) {
    return { ok: false, error: `git is not available: ${cause instanceof Error ? cause.message : String(cause)}` };
  }
}

/**
 * The default runner: dry-run validate (`--check`), then apply for real only
 * if validation passed — never a partial write from a patch that fails
 * partway through (git itself refuses the whole patch on any hunk mismatch).
 */
export function makeGitApplyRunner(): GitApplyRunner {
  return async (patch, cwd) => {
    const check = await spawnGitApply(["apply", "--check", "-p1"], patch, cwd);
    if (!check.ok) {
      return check;
    }
    return spawnGitApply(["apply", "-p1"], patch, cwd);
  };
}

/** Per-file outcome reported back to the model — never a single pass/fail blob. */
export interface ApplyPatchFileResult {
  path: string;
  action: PatchTarget["action"];
  ok: boolean;
  error?: string;
}

/** Structured `apply_patch` output (serialized as the tool's text result). */
export interface ApplyPatchOutput {
  applied: boolean;
  results: ApplyPatchFileResult[];
}

/**
 * The `apply_patch` tool, bound to `root`. `run` defaults to the real `git
 * apply` runner and is injectable for deterministic tests (no real
 * subprocess). Risk `write` → the driver requires approval before this ever
 * executes (ADR-0010, `executeCall`'s `write` branch in `agent.ts`).
 */
export function applyPatchTool(root: string, run: GitApplyRunner = makeGitApplyRunner()): InteractiveTool {
  return {
    definition: {
      name: "apply_patch",
      description:
        "Apply a unified diff (the same format `git diff` produces) to one or more files in the project. " +
        "Input: { patch: string }. Supports creating (`--- /dev/null`), deleting (`+++ /dev/null`), and " +
        "modifying files — concatenate several file sections to edit multiple files in ONE call. Prefer " +
        "ONE apply_patch call with every hunk for this turn's edits over several small calls: each call is " +
        "one budget slot regardless of how many files/hunks it contains. A patch that does not apply cleanly " +
        "(wrong context, file changed since you read it) is rejected wholesale — nothing is written, not even " +
        "for the files that would have applied; re-read the file and resend a corrected patch. Requires the " +
        "user's explicit approval before it writes anything.",
      inputSchema: {
        type: "object",
        properties: { patch: { type: "string" } },
        required: ["patch"],
        additionalProperties: false,
      },
      risk: "write",
    },
    invoke: async (input): Promise<InteractiveToolResult> => {
      const patch = typeof input.patch === "string" ? input.patch : "";
      if (patch.trim().length === 0) {
        return { output: "apply_patch requires a non-empty 'patch'", isError: true };
      }
      const targets = parsePatchTargets(patch);
      if (targets.length === 0) {
        return {
          output:
            "apply_patch: no valid file targets found in patch (expected `--- a/path` / `+++ b/path` unified-diff headers)",
          isError: true,
        };
      }

      // Confine every target BEFORE git ever runs — one escaping path
      // rejects the WHOLE patch (same posture as multi-file atomicity
      // below: never a partial write). Mirrors `search_code`'s own
      // `confineToRoot` usage in `metaproject-tools.ts`.
      const escaping = targets.find((target) => confineToRoot(root, target.path) === null);
      if (escaping !== undefined) {
        const output: ApplyPatchOutput = {
          applied: false,
          results: targets.map((t) => ({
            path: t.path,
            action: t.action,
            ok: false,
            error:
              t.path === escaping.path
                ? "path escapes the project root"
                : "not applied: a sibling target in this patch escapes the project root",
          })),
        };
        return { output: JSON.stringify(output), isError: true };
      }

      const applied = await run(patch, root);
      const output: ApplyPatchOutput = {
        applied: applied.ok,
        results: targets.map((t) => ({
          path: t.path,
          action: t.action,
          ok: applied.ok,
          ...(applied.ok ? {} : { error: applied.error ?? "git apply failed" }),
        })),
      };
      return { output: JSON.stringify(output), isError: !applied.ok };
    },
  };
}
