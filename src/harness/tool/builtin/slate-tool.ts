// Agent-pulled Course/Seeds access for the session-local Slate (SLATE-3a,
// flow 161 AC5). Mirrors `workspace-context-tool.ts`'s shape: a factory
// taking constructor args, returning an `InteractiveTool` whose `invoke`
// NEVER throws — matching `executeCall`'s bare `return tool.invoke(input);`
// in `commands/agent.ts` (not wrapped in try/catch there; a throwing
// `invoke` would propagate uncaught through `runAgentTurnCore` and crash the
// whole turn loop).
//
// This is the ONLY way Course/Seeds content reaches the model this phase.
// SLATE-2a's `renderAnchorsBlock` (`src/session/slate.ts`) is a strictly
// separate code path that renders `anchors.*` only and never reads
// `Slate.course`/`Slate.seeds` — the two concerns stay genuinely apart, which
// is what makes AC5 ("Course/Seeds content is reachable only through
// slate_read/slate_write_seed, never silently injected every round") hold by
// construction, not by convention.

import {
  appendSeed,
  isSlateSeedKind,
  readSlate,
  SEED_TEXT_MAX_LENGTH,
  SLATE_SEED_KINDS,
  type SlateSeed,
  type SlateSeedKind,
} from "../../../session/slate";
import { courseFromSlate } from "../../../session/slate-course";
import { redactSensitiveText } from "../../../security/redact";
import type { InteractiveTool } from "./interactive-tools";

// `SEED_TEXT_MAX_LENGTH`/`SLATE_SEED_KINDS`/`isSlateSeedKind` used to be local,
// unexported copies defined in this file (F-002, review remediation, prior
// round). Flow 182 T7 (F-001 fix) promoted them to `../../../session/slate` —
// the canonical `SlateSeedKind` owner — as the single source of truth both
// this keryx-native tool AND the new external-hand `slate.writeSeed` MCP tool
// (`src/mcp/tools.ts`) now import from, rather than duplicating (or, as
// `slate.writeSeed` did before this fix, omitting) the same literal list.
// This file's own behavior (schema `maxLength`, `enum`, and the try/catch
// error-shape below) is otherwise unchanged.

/**
 * Read-only Course/Seeds lookup. `cwd` identifies the project (needed by
 * `courseFromSlate`'s live Flow re-derivation); `getSessionDir` is a LAZY
 * getter, not a static dir, because the session dir is not always known at
 * tool-build time (see `interactive-agent-tools.ts`'s `getSessionDir` doc
 * comment for the TDZ/closure reasoning this mirrors).
 */
export function slateReadTool(cwd: string, getSessionDir: () => string | undefined): InteractiveTool {
  return {
    definition: {
      name: "slate_read",
      description:
        "Read this session's Slate: the live Course projection (derived from the bound Flow, if any) and the Seeds recorded so far (draft hypotheses, not yet accepted). Input: {} (no arguments). Course/Seeds are NEVER auto-injected into the conversation — this tool is the only way to see them.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      risk: "read",
    },
    invoke: async () => {
      const dir = getSessionDir();
      if (dir === undefined) {
        return { output: "slate_read: no active session in this run", isError: true };
      }
      // F-001 fix: `readSlate` only catches `ENOENT` and rethrows everything
      // else (malformed JSON, EACCES, …; see slate.ts), and `courseFromSlate`
      // is not documented as non-throwing either. Per this module's own doc
      // comment, `invoke` must NEVER throw — `executeCall` calls it with a
      // bare `return tool.invoke(input);`, no surrounding try/catch, so an
      // uncaught rejection here would propagate through `runAgentTurnCore`
      // and crash the whole turn for a live user. Mirrors
      // `slateWriteSeedTool`'s own try/catch around `appendSeed` below.
      try {
        const slate = await readSlate(dir);
        const course = await courseFromSlate(cwd, slate);
        return {
          output: JSON.stringify({ course, seeds: slate?.seeds ?? [], workspaceId: slate?.workspaceId }, null, 2),
          isError: false,
        };
      } catch (cause) {
        return {
          output: `slate_read failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          isError: true,
        };
      }
    },
  };
}

/**
 * Append a Seed (SLATE-4's append-only write) directly from the model.
 *
 * Risk classification (`risk: "read"`, deliberate — flagged for a second
 * look during T8/T9 review): a Seed is a DRAFT hypothesis the model is
 * jotting down for a later, separately-gated `workspace review`/wrap-up
 * pass — never accepted knowledge, never surfaced back to the model or any
 * other reader until that review happens. It is the same trust framing
 * `ask_user` (also `risk: "read"`) already uses despite blocking on/writing
 * session state: a `risk` classification here tracks whether unreviewed
 * model output can influence something consequential WITHOUT a human/gate in
 * the loop, not whether bytes hit disk. This IS a real filesystem write to
 * session-local `slate.json` (unlike `ask_user`, which writes nothing) and it
 * deliberately bypasses the shell/destructive-tool approval gate — that is
 * intentional and safe specifically BECAUSE a Seed cannot become "accepted"
 * project knowledge on its own; only the separate, human-reviewed
 * `workspace propose`/review path (SLATE-7/SLATE-10, out of this phase) can
 * promote it. If a future phase lets Seeds influence anything before that
 * review gate runs, this classification must be revisited.
 *
 * `idSeq`/`clock` are injected (never `Date.now`/`randomUUID` baked in here)
 * mirroring `spawn-subagent-tool.ts`'s injected-clock pattern — `runAgentTurn`
 * is documented as deterministic (`deps.idSeq()` only), so anything it wires
 * a tool through must accept the same injected sources of non-determinism
 * rather than reaching for a global clock/RNG itself.
 *
 * ACCEPTED, DOCUMENTED limitation (F-002, review remediation — read this
 * before copying this tool's pattern for anything more consequential): this
 * tool bypasses BOTH the shell/destructive approval gate (`executeCall`'s
 * risk gate in `commands/agent.ts` only requires approval for `risk ===
 * "shell" | "destructive"`; `"read"` auto-allows) AND the non-read budget
 * pool (`reserveToolAttempt` in `agent.ts` only charges the read pool for
 * `risk === "read"` calls) — by design, per the draft-hypothesis framing
 * above. This is intentional, not an oversight: `agent.ts`'s `executeCall`
 * only recognizes four risk tiers — `"read"` / `"shell"` / `"destructive"` /
 * `"delegate"` — and there is no genuine confirmable "write" tier in the
 * current risk model that would fit a Seed (a Seed is neither a shell
 * command nor project-consequential on its own). Introducing a new risk tier
 * is an explicit non-goal of this phase (see flow 161's description.md "Out
 * of Scope"). What IS bounded this phase: `text` is capped at
 * {@link SEED_TEXT_MAX_LENGTH} (rejected before `invoke` even runs, via the
 * input schema's `maxLength` and `executeCall`'s pre-invoke schema
 * validation) and scrubbed with `redactSensitiveText` before it ever touches
 * disk (see `invoke` below) — closing the two concrete gaps a Seed write
 * actually had (unbounded size, unredacted secrets), without attempting a
 * full risk-model redesign. If a future phase lets Seeds influence anything
 * BEFORE a human review gate runs (see the risk-classification paragraph
 * above), this whole classification — including the approval/budget bypass
 * — must be revisited, not just re-justified.
 */
export function slateWriteSeedTool(
  getSessionDir: () => string | undefined,
  idSeq: () => string,
  clock: () => string,
): InteractiveTool {
  return {
    definition: {
      name: "slate_write_seed",
      description:
        "Record a Seed: a draft hypothesis, decision, or follow-up worth surfacing to a later review — never accepted project knowledge by itself. Input: { text: string, kind?: 'decision'|'wiki-update'|'memory-entry'|'follow-up'|'contract-change'|'risk' }.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", maxLength: SEED_TEXT_MAX_LENGTH },
          kind: { type: "string", enum: [...SLATE_SEED_KINDS] },
        },
        required: ["text"],
        additionalProperties: false,
      },
      risk: "read",
    },
    invoke: async (input) => {
      const rawText = typeof input.text === "string" ? input.text : undefined;
      const text = rawText?.trim();
      if (text === undefined || text.length === 0) {
        return { output: "slate_write_seed requires a non-empty 'text'", isError: true };
      }
      let kind: SlateSeedKind | undefined;
      if (input.kind !== undefined) {
        if (!isSlateSeedKind(input.kind)) {
          return {
            output: `slate_write_seed: unrecognized 'kind': ${JSON.stringify(input.kind)}`,
            isError: true,
          };
        }
        kind = input.kind;
      }
      const dir = getSessionDir();
      if (dir === undefined) {
        return { output: "slate_write_seed: no active session in this run", isError: true };
      }
      // `appendSeed` throws "no open slate in <dir>" when no slate is open at
      // `dir` (its own documented contract — see slate.ts). That throw must
      // never propagate past this `invoke` (see this module's doc comment),
      // so it is caught here and degraded to a normal tool error.
      try {
        // F-002 fix: scrub the seed text BEFORE it ever hits disk — the same
        // `redactSensitiveText` `agent.ts` already applies to tool OUTPUT
        // (F3) applied here to a tool INPUT, since a Seed is model-authored
        // free text that could echo a credential the model just read
        // elsewhere in the session. Redacting on write (not only on read)
        // means a leaked secret never lands in `slate.json` at all, rather
        // than merely being hidden from a later `slate_read`.
        const redactedText = redactSensitiveText(text);
        const seed: SlateSeed = { id: idSeq(), text: redactedText, ts: clock(), ...(kind !== undefined ? { kind } : {}) };
        await appendSeed(dir, seed);
        return { output: JSON.stringify({ appended: seed }, null, 2), isError: false };
      } catch (cause) {
        return {
          output: `slate_write_seed failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          isError: true,
        };
      }
    },
  };
}
