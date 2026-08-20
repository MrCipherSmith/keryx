// EXECUTING an operator message's delivery intent (flow 176, T18).
// Package: docs/requirements/keryx-external-agent-runtime §7.5; prd R18, R19, R20.
//
// `addressee-queue.ts` deliberately only DESCRIBES what should happen to a
// message — `stdin`, `resume`, `kill-then-resume`, `kill-only`, `hold`,
// `undeliverable` — because the two things needed to carry any of it out are
// impure and live in the caller: the live `ExternalRunHandle` (`kill()`,
// `writeStdin()`) and the agent's codec (argv construction, stdin encoding).
// This module is that caller's half, and it is the ONLY place an intent is
// turned into an action, so no future surface can execute one and forget the
// rules below.
//
// Three of those rules exist because the obvious shortcut is wrong:
//
//   1. A `user_message` EVENT IS EMITTED FOR — AND ONLY FOR — A DELIVERY THAT
//      ACTUALLY LANDED (D-09). `deliveredUserMessageEvent` is the single choke
//      point and this module never second-guesses it: emitting for a held
//      message would tell the parent's folded view that the operator said
//      something the child never received, and the operator would stop watching
//      for a reply that is not coming.
//   2. A FAILED `writeStdin` IS A REFUSAL, NOT A SUCCESS. `ExternalRunHandle`
//      returns `false` — never throws — when the run was launched one-shot,
//      because a `streamingInput: true` agent launched one-shot has no stdin
//      route at all (§7.5). Reporting that as delivered is exactly the lie rule
//      1 exists to prevent, so it becomes `{ok:false, reason}` naming the
//      one-shot launch.
//   3. RESUME IS BUILT, NOT SPAWNED. Executing a resume would mean starting a
//      SECOND vendor process — and the run's disposable worktree is removed the
//      moment the first one ends (§7.2), so there is nothing left to resume
//      into from here. What this module produces is the exact resume argv from
//      the agent's own codec, which is what the modal's Command tab and D-11's
//      detach path consume. The kill half of `kill-then-resume` IS executed:
//      that part has a live handle and is what makes `force` cost a restart
//      rather than the accumulated work (R20).
//
// Pure apart from the two effects it is explicitly handed (a handle write and a
// handle kill), which is what lets every branch below be tested with a fake
// handle, no subprocess and no TTY.

import { encodeClaudeStdinMessage } from "../harness/external/codec/claude-cli";
import { getExternalCodec } from "../harness/external/codec";
import type { ExternalRunHandle } from "../harness/external/supervise";
import type { ExternalEvent, ExternalRunInput } from "../harness/external/types";
import { deliveredUserMessageEvent, type ExternalDeliveryIntent } from "./addressee-queue";

/** The registry id of the one shipped agent that accepts mid-run stdin (§5.2). */
export const STREAMING_STDIN_AGENT_ID = "claude-cli";

/** Everything execution needs that the pure intent cannot carry. */
export interface ExternalDeliveryTarget {
  /** Registry id, so the right codec and stdin encoding are chosen. Never guessed. */
  readonly agentId: string;
  /** The live handle, when the run is still up. Absent means nothing can be written or killed. */
  readonly handle?: ExternalRunHandle;
  /**
   * The run's original codec input, needed by `buildResumeArgv`.
   *
   * `codex-cli` drops it (its `resume` subcommand takes a narrower flag set),
   * `claude-cli` uses it to reproduce the same model, sandbox and tool roster.
   * Absent means the resume argv cannot be built and the caller is told so
   * rather than handed an argv assembled from defaults the run never used.
   */
  readonly runInput?: ExternalRunInput;
}

/** What execution actually did. Distinguishable so the operator line is never a guess. */
export type ExternalDeliveryAction =
  | "stdin"
  | "resume-argv"
  | "kill-then-resume-argv"
  | "kill-only"
  | "held";

/** The result of executing one intent. */
export type ExternalDeliveryResult =
  | {
      readonly ok: true;
      readonly action: ExternalDeliveryAction;
      /** One operator-readable line describing what happened. */
      readonly note: string;
      /** The `user_message` to append to this run's stream, when the message landed (D-09). */
      readonly event?: ExternalEvent;
      /** The argv that continues the session by hand, for `resume`/`kill-then-resume`. */
      readonly resumeArgv?: readonly string[];
      /** True when the child process was terminated as part of this delivery. */
      readonly killed?: boolean;
      /** True when the message did NOT reach the agent and is not queued for it. */
      readonly lost?: boolean;
    }
  | { readonly ok: false; readonly reason: string };

/**
 * Carry out one delivery intent.
 *
 * Never throws: a delivery that cannot happen is a named refusal, because the
 * operator's next move depends on knowing whether the agent heard them.
 * `undeliverable` intents are refusals too — the intent already carries the
 * reason and this module simply forwards it rather than inventing a second one.
 */
export function executeExternalDelivery(
  intent: ExternalDeliveryIntent,
  target: ExternalDeliveryTarget,
): ExternalDeliveryResult {
  const event = deliveredUserMessageEvent(intent);

  switch (intent.kind) {
    case "stdin": {
      if (target.agentId !== STREAMING_STDIN_AGENT_ID) {
        // Fail-closed for the same reason `getExternalCodec` does: the stdin
        // wire format is per-agent, and writing claude's JSON envelope into
        // another CLI's stdin is a wrong answer wearing a success shape.
        return {
          ok: false,
          reason: `keryx has no stdin encoding for "${target.agentId}"; only ${STREAMING_STDIN_AGENT_ID} accepts mid-run messages`,
        };
      }
      const handle = target.handle;
      if (handle === undefined) {
        return { ok: false, reason: "this run has no live handle, so nothing can be written to its stdin" };
      }
      if (!handle.writeStdin(encodeClaudeStdinMessage(intent.message))) {
        // Rule 2. `false` means the run was spawned one-shot (`stdin: "ignore"`),
        // which is a registry-predicted state and not a programming error.
        return {
          ok: false,
          reason:
            "this run was launched one-shot, so it has no stdin to write to; the message must go " +
            "through resume instead",
        };
      }
      return {
        ok: true,
        action: "stdin",
        note: "delivered to the running agent's stdin",
        ...(event === undefined ? {} : { event }),
      };
    }

    case "kill-then-resume": {
      const argv = buildResumeArgv(target, intent.sessionRef, intent.message);
      if (!argv.ok) return argv;
      const handle = target.handle;
      if (handle === undefined) {
        return { ok: false, reason: "this run has no live handle, so it cannot be killed for a force delivery" };
      }
      // Order matters: the argv is built FIRST. Killing and then discovering the
      // codec cannot build a resume would leave the operator with a dead run and
      // no route back into it — the one outcome `force` promises not to produce.
      handle.kill();
      return {
        ok: true,
        action: "kill-then-resume-argv",
        note: `force: killed the run; resume session ${intent.sessionRef} with the recorded command to deliver this message`,
        killed: true,
        resumeArgv: argv.argv,
        ...(event === undefined ? {} : { event }),
      };
    }

    case "resume": {
      const argv = buildResumeArgv(target, intent.sessionRef, intent.message);
      if (!argv.ok) return argv;
      return {
        ok: true,
        action: "resume-argv",
        note:
          intent.when === "now"
            ? `the run has ended; resume session ${intent.sessionRef} with the recorded command to deliver this message`
            : `queued: session ${intent.sessionRef} will be resumed with this message when the run ends`,
        resumeArgv: argv.argv,
        ...(event === undefined ? {} : { event }),
      };
    }

    case "kill-only": {
      const handle = target.handle;
      if (handle === undefined) {
        return { ok: false, reason: "this run has no live handle, so there is nothing to kill" };
      }
      handle.kill();
      // `lost` is not decoration. The operator asked for `force`, got a kill, and
      // must be told the message went nowhere — believing it was delivered means
      // waiting for a reply that cannot come (§7.5).
      return {
        ok: true,
        action: "kill-only",
        note: `force: killed the run — ${intent.reason}; the message was NOT delivered`,
        killed: true,
        lost: true,
      };
    }

    case "hold":
      return { ok: true, action: "held", note: `held — ${intent.reason}` };

    case "undeliverable":
      return { ok: false, reason: intent.reason };

    default:
      return { ok: false, reason: "unrecognised delivery intent" };
  }
}

/** Build the resume argv through the agent's own codec, or say why it cannot be built. */
function buildResumeArgv(
  target: ExternalDeliveryTarget,
  sessionRef: string,
  message: string,
): { ok: true; argv: readonly string[] } | { ok: false; reason: string } {
  const codec = getExternalCodec(target.agentId);
  if (codec === undefined) {
    return {
      ok: false,
      reason: `keryx ships no codec for "${target.agentId}", so a resume command cannot be built; run \`keryx agents external list\` for the agents it does drive`,
    };
  }
  const runInput = target.runInput;
  if (runInput === undefined) {
    return {
      ok: false,
      reason:
        "the original launch input for this run was not recorded, so a resume command cannot " +
        "reproduce the model, sandbox and tool roster it ran with",
    };
  }
  return { ok: true, argv: codec.buildResumeArgv(sessionRef, message, runInput) };
}
