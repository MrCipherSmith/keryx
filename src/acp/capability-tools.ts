// ACP client-capability-aware tool wrapping (flow 285, T11 — AC6).
//
// Three decisions, recorded here and in the flow's context.md (T11 section):
//
//   READ  — when the session's client advertised `fs.readTextFile === true`,
//   `read_file` calls the client's `fs/read_text_file` instead of reading the
//   local filesystem. Absent the capability (missing, `false`, or no `fs` at
//   all), `read_file` never calls it — falls straight through to the
//   existing local implementation from `builtinReadOnlyTools`. Every input
//   validation `read_file` already performs (empty path, path escaping the
//   project root) runs BEFORE a client round trip is attempted, by simply
//   delegating those cases to the local tool's own `invoke` — so a malformed
//   call never reaches the wire either way.
//
//   WRITE — `apply_patch`, the ACP roster's only write-risk tool, stays local
//   UNCONDITIONALLY, regardless of `fs.writeTextFile`. It applies a
//   multi-file unified diff atomically via `git apply` (ADR-0010): every
//   hunk across every target file lands, or none do. ACP's
//   `fs/write_text_file` writes ONE file's full content, with no diff/patch
//   semantics and no cross-file atomicity — rerouting apply_patch through it
//   would mean keryx re-implementing patch application (context-matching,
//   create/delete, multi-file atomicity) outside git, computing each target's
//   post-patch content some other way, and losing ADR-0010's atomicity
//   guarantee the moment a multi-file patch's Nth file write fails after the
//   first N-1 already landed on the client's side. That is a redesign of
//   apply_patch, not a capability branch, and this dispatch has no scoped
//   reason to attempt it. `keryx acp` therefore never calls
//   `fs/write_text_file` in this flow, with or without the capability — a
//   documented gap (see context.md's T11 section), not a silent one.
//
//   TERMINAL — `shell_exec` stays local UNCONDITIONALLY too, regardless of
//   `terminal`. It already has a full-featured local implementation
//   (background jobs, streaming, timeouts, the approval gate T9 wired) that
//   ACP's `terminal/create` + `terminal/output` + `terminal/wait_for_exit` +
//   `terminal/kill` + `terminal/release` surface does not match one-for-one —
//   no approval-linked semantics, no background-job-registry parity — and
//   rebuilding shell_exec against it would risk that existing, well-tested
//   subsystem for a capability keryx does not need (it already runs commands
//   locally, same machine, same process tree, as `keryx shell` always has).
//   Consequence: `keryx acp` never calls any `terminal/*` method in ANY
//   capability configuration. AC6's bar — "absent capability ⇒ never
//   called" — holds unconditionally rather than only in the absent case,
//   which is the stronger and simpler property to test and keep true.

import { confineToRoot, type InteractiveTool } from "../harness/tool/builtin/interactive-tools";
import type { AcpClientCapabilities } from "./protocol";

/**
 * Sends `fs/read_text_file` for the confined, absolute `path` and returns its
 * text — or `undefined` when the client could not or would not answer (a
 * JSON-RPC error, a malformed result, or a non-object/non-string `content`),
 * in which case the caller falls back to the local read rather than fail a
 * call the local tool could still serve.
 */
export type AcpFsReader = (path: string, line?: number) => Promise<string | undefined>;

/**
 * Wraps the local `read_file` tool (`base`, from `builtinReadOnlyTools`) so
 * it routes through `readViaClient` — the session's `fs/read_text_file` — when
 * the client's advertised capabilities say it can answer that method, and
 * returns `base` UNCHANGED otherwise. Unchanged, not a pass-through wrapper
 * that always checks and always declines: the capability decision is made
 * ONCE, at roster-construction time, so a test asserting "no fs/read_text_file
 * frame was ever sent" when the capability is absent is asserting about a
 * tool that has no code path capable of sending one, not one that merely
 * chose not to this time.
 */
export function acpAwareReadFileTool(
  base: InteractiveTool,
  root: string,
  clientCapabilities: AcpClientCapabilities | undefined,
  readViaClient: AcpFsReader,
): InteractiveTool {
  if (clientCapabilities?.fs?.readTextFile !== true) {
    return base;
  }
  return {
    definition: base.definition,
    invoke: async (input, ctx) => {
      const requested = typeof input.path === "string" ? input.path : "";
      if (requested.length === 0) {
        // Same "requires a non-empty 'path'" error the local tool produces —
        // no client round trip for an input that cannot succeed either way.
        return base.invoke(input, ctx);
      }
      const target = confineToRoot(root, requested);
      if (target === null) {
        // Same "path escapes the project root" error, same reasoning.
        return base.invoke(input, ctx);
      }
      const startLine = typeof input.start_line === "number" ? input.start_line : undefined;
      const viaClient = await readViaClient(target, startLine);
      if (viaClient !== undefined) {
        return { output: viaClient, isError: false };
      }
      return base.invoke(input, ctx);
    },
  };
}
