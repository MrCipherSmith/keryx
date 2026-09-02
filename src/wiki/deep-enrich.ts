// deep-path child turn for `wiki enrich` RLM mode (TRD §1.3/§1.4, flow 169 T6).
//
// A `deep`-classified page (classify.ts, T2) is enriched via a bounded, flat
// (non-recursive) child turn with read-only code-graph access. Per TRD §1.3
// this deliberately does NOT call the interactive `spawn_subagent` tool
// (`harness/tool/builtin/spawn-subagent-tool.ts`) — that tool is invoked by a
// MODEL from inside an already-running interactive agent turn, and `wiki
// enrich` is a batch CLI command with no such turn to call it from. Instead
// this module calls the two primitives `spawn_subagent` itself wraps,
// directly:
//   - `spawnSubagent()` (`harness/child/orchestrate.ts`) — MAE budget/policy
//     admission (`RemainingBudgetLedger` + `childReadOnlyPolicy()`), the SAME
//     admission path every other harness child goes through. No new budget
//     mechanism.
//   - `runAgentTurn()` (`commands/agent.ts`) — the actual bounded model turn,
//     granted ONLY the filtered read-only `METAPROJECT_OPERATIONS` subset
//     (TRD §1.4: graph_query, graph_path, graph_symbol, graph_affected,
//     repomap, read_wiki) — no shell_exec-equivalent, no
//     spawn_subagent-equivalent, so a deep child has no mechanism to spawn a
//     grandchild (FR-6 flat recursion, enforced by construction — see
//     `deep-enrich.test.ts`'s tool-grant assertion, AC3).
//
// `SubagentContext` has no batch-CLI equivalent for a real "parent model
// turn" identity (`getParentModel()` in `spawn-subagent-tool.ts` reads a LIVE
// interactive session's active model) — this module uses `wikiEnrich`'s own
// already-resolved `provider`/`model` (via `resolveEnrichProviderModel`) as
// the parent identity instead, the closest real analog for a batch run. The
// interactive-only plumbing `spawn_subagent` also carries (slate, TUI fleet
// events, `getSlateSession`) has no batch-pipeline equivalent either and is
// simply omitted — this module is a `mapPool` worker helper, not a session.
//
// Standalone and independently callable — NOT wired into `wikiEnrich()`'s
// classify/skip/light/deep branching (T7's job); `enrichPageDeep` is the
// function T7 calls from inside the `deep` branch it adds. The existing
// `light`-path single-turn call in `enrich.ts` is completely untouched.
//
// AC5 contract: `enrichPageDeep` NEVER throws. Admission denial, provider
// construction failure, timeout, or any other child-turn error all degrade to
// the `{ fallback: true, reason }` variant (with `partial` populated when the
// child produced any text before failing) — a `wiki enrich` batch run over N
// pages must never fail outright because ONE deep child ran out of budget.
//
// AC7 provenance grounding correction: `toToolDefinitions()`'s
// `replay: { deterministic: true, recordedResultSupported: true }` metadata
// (`metaproject-operations.ts:719`) is real, but it is consumed by the
// SEPARATE `ToolRegistry`/`harness/run/run.ts`/`harness/replay/replay.ts`
// durable-execution pipeline — NOT by `runAgentTurn`'s tool-calling loop.
// `runAgentTurn` (`commands/agent.ts`) calls `deps.tools`
// (`InteractiveTool[]`, built here via `toInteractiveTools`) directly —
// `executeCall(...)` in that file's tool-execution loop invokes
// `tool.invoke(input)` in-process and appends the result straight into
// `history` as a `role:"tool"` message; it never touches `ToolRegistry` or
// any replay/provenance store (confirmed: `commands/agent.ts` imports
// nothing from `harness/tool/registry.ts` or `harness/replay/*`). So for
// THIS execution path, `ToolDefinition.replay` metadata records nothing —
// per-tool-call provenance is NOT automatic here and must be wired
// explicitly. This module does that itself via `AgentIO.onToolCall`/
// `onToolResult`, returning an ordered `toolCalls` log (name, input, isError)
// on every `EnrichPageDeepResult` variant so a caller can persist/audit it
// per page (AC7) without re-deriving this from `runAgentTurn` internals.

import { randomUUID, createHash } from "node:crypto";
import { runAgentTurn, type AgentDeps, type AgentIO } from "../commands/agent";
import { RemainingBudgetLedger } from "../harness/child/ledger";
import { spawnSubagent, type SubagentContext } from "../harness/child/orchestrate";
import { shellChildReadOnlyProfile, shellParentProfile } from "../harness/policy/profiles";
import { makeProvider } from "../harness/provider/make-provider";
import { hasCredential } from "../harness/provider/single-turn";
import type { ProviderFactory } from "../harness/provider/single-turn";
import type { NormalizedMessage, ProviderPort } from "../harness/provider/types";
import type { Provenance } from "../harness/session/types";
import { createMetaprojectAdapter } from "../harness/tool/metaproject-adapter";
import { METAPROJECT_OPERATIONS, toInteractiveTools } from "../harness/tool/metaproject-operations";
import type { MetaprojectPort } from "../harness/tool/metaproject-port";
import type { InteractiveTool } from "../harness/tool/builtin/interactive-tools";
import { envWithSavedApiKeys } from "../lib/shell-config";
import type { WikiPage } from "./types";

/**
 * Read-only ops granted to a `deep`-path child (TRD §1.4). Exported so the
 * FR-6/AC3 "flat recursion" test can assert on the exact allowlist rather
 * than re-deriving it, and so a future caller can reuse the same constant.
 */
export const DEEP_ENRICH_OPS = [
  "graph_query",
  "graph_path",
  "graph_symbol",
  "graph_affected",
  "repomap",
  "read_wiki",
] as const;

/** One recorded tool call from a deep child turn (AC7 provenance). */
export interface DeepEnrichToolCall {
  name: string;
  /** Raw JSON input string the model proposed. */
  input: string;
  isError: boolean;
}

export interface DeepEnrichSuccess {
  enriched: string;
  /** Ordered per-call provenance log (AC7) — see this module's doc comment. */
  toolCalls: DeepEnrichToolCall[];
}

export interface DeepEnrichFallback {
  fallback: true;
  reason: string;
  /**
   * Best partial assistant text captured before the failure/timeout, when
   * any was produced (AC5: caller may prefer this over the deterministic
   * `collect.ts` template — `enrichPageDeep` does not decide that itself).
   */
  partial?: string;
  toolCalls: DeepEnrichToolCall[];
}

export type DeepEnrichResult = DeepEnrichSuccess | DeepEnrichFallback;

export interface EnrichPageDeepInput {
  cwd: string;
  page: WikiPage;
  /** Already frontmatter-normalized original markdown (same content the `light` path sends). */
  original: string;
  /** Trusted wiki-writer system prompt (same one `light`'s `loadSystemPrompt` resolves). */
  systemPrompt: string;
  /** Extra instruction merged into the prompt (mirrors `WikiEnrichInput.prompt`). */
  extraInstruction?: string;
  provider: string;
  model: string;
  /** `rlm.deep.maxToolCalls` (TRD §3.1) — sourced from `loadWikiConfig`, never hardcoded. */
  maxToolCalls: number;
  /** `rlm.deep.maxRuntimeMs` (TRD §3.1) — sourced from `loadWikiConfig`, never hardcoded. */
  maxRuntimeMs: number;
  // Injected, all-optional for deterministic offline tests (mirrors `enrich.ts`'s own seam):
  providerFactory?: ProviderFactory;
  fetch?: typeof fetch;
  env?: Record<string, string | undefined>;
  baseUrl?: string;
  /** Injected `MetaprojectPort` (tests); default `createMetaprojectAdapter(cwd)`. */
  metaprojectPort?: MetaprojectPort;
  idSeq?: () => string;
  clock?: () => string;
  /** Cancellation inherited from the shell/wiki operation. */
  signal?: AbortSignal;
}

function composeAbortSignals(external: AbortSignal | undefined, timeout: AbortSignal): {
  signal: AbortSignal;
  dispose: () => void;
} {
  if (external === undefined) {
    return { signal: timeout, dispose: () => {} };
  }
  const controller = new AbortController();
  const abortFrom = (signal: AbortSignal): void => {
    if (!controller.signal.aborted) {
      controller.abort(signal.reason);
    }
  };
  const onExternalAbort = (): void => abortFrom(external);
  const onTimeoutAbort = (): void => abortFrom(timeout);
  external.addEventListener("abort", onExternalAbort, { once: true });
  timeout.addEventListener("abort", onTimeoutAbort, { once: true });
  if (external.aborted) abortFrom(external);
  if (timeout.aborted) abortFrom(timeout);
  return {
    signal: controller.signal,
    dispose: () => {
      external.removeEventListener("abort", onExternalAbort);
      timeout.removeEventListener("abort", onTimeoutAbort);
    },
  };
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Build the EXACT (and only) tool grant for a deep child: `toInteractiveTools`
 * projecting `METAPROJECT_OPERATIONS` filtered to {@link DEEP_ENRICH_OPS} over
 * `port`. No other tool source (`builtinReadOnlyTools`, `builtinMetaprojectTools`,
 * `spawn_subagent`, `shell_exec`) is ever added — this is the ONE place
 * `enrichPageDeep` constructs `AgentDeps.tools`, so a direct test on this
 * function's return value is a precise, construction-level proof of FR-6/AC3
 * ("no shell_exec-equivalent, no spawn_subagent-equivalent capability"),
 * not an inference from METAPROJECT_OPERATIONS never having included them.
 */
export function buildDeepEnrichTools(port: MetaprojectPort): InteractiveTool[] {
  const deepOps = METAPROJECT_OPERATIONS.filter((op) => (DEEP_ENRICH_OPS as readonly string[]).includes(op.name));
  return toInteractiveTools(deepOps, port);
}

/** Assemble the child's system instruction: the wiki writer prompt + read-only tool guidance. */
function buildDeepSystemInstruction(systemPrompt: string, maxRounds: number): string {
  return (
    `${systemPrompt}\n\n` +
    "You ALSO have READ-ONLY code-graph tools for this page: graph_query, graph_path, " +
    "graph_symbol, graph_affected, repomap, read_wiki. This page was flagged as complex " +
    "(high PageRank/fan-in) — use these tools to verify facts about the actual code before " +
    "writing prose (key files, callers/dependents, related pages) instead of guessing. You have " +
    `up to ${maxRounds} model turns (rounds) for this whole task — each round may include ` +
    "several tool calls; an identical call repeated does not start a new round, so do not retry " +
    "the same query hoping for a different answer. No further subagents are available to you; " +
    "do not attempt to spawn one. Return ONLY the full Markdown page (frontmatter + body), no commentary."
  );
}

/** Assemble the child's user turn: page context + the current markdown to enrich. */
function buildDeepUserPrompt(page: WikiPage, original: string, extra?: string): string {
  const parts = [
    `Wiki page type: ${page.pageType}`,
    `Title: ${page.title}`,
    `Summary: ${page.summary || "(none)"}`,
    "",
    "Current page content (enrich the prose; keep or create YAML frontmatter starting with ---,",
    "including Title and Status; keep the H1 title). Use the read-only graph tools to verify",
    "facts about the code before writing:",
    "```markdown",
    original.trimEnd(),
    "```",
  ];
  if (extra !== undefined && extra.trim().length > 0) {
    parts.push("", `Additional instruction: ${extra.trim()}`);
  }
  return parts.join("\n");
}

/**
 * Run one `deep`-classified page through a bounded, flat child turn with
 * read-only code-graph access. Never throws — see this module's doc comment
 * (AC5 contract).
 */
export async function enrichPageDeep(input: EnrichPageDeepInput): Promise<DeepEnrichResult> {
  const idSeq = input.idSeq ?? (() => randomUUID());
  const clock = input.clock ?? (() => new Date().toISOString());
  const toolCalls: DeepEnrichToolCall[] = [];

  if (input.signal?.aborted) {
    return { fallback: true, reason: "deep enrich cancelled", toolCalls };
  }

  try {
    const env = envWithSavedApiKeys(input.env ?? process.env);
    const credentialAvailable = hasCredential(input.provider, env);
    if (!credentialAvailable && input.providerFactory === undefined) {
      return {
        fallback: true,
        reason: `no credential for provider "${input.provider}" (set its API key env var or enter it in keryx shell)`,
        toolCalls,
      };
    }

    const ledger = new RemainingBudgetLedger({ maxRuntimeMs: input.maxRuntimeMs }, { maxChildren: 1 });
    const parentRunId = idSeq();
    const parentSessionId = idSeq();
    const parentProvenance: Provenance = {
      provenanceId: idSeq(),
      trustLevel: "trusted",
      sourceKind: "keryx-wiki-enrich",
    };
    const ctx: SubagentContext = {
      parentRunId,
      parentSessionId,
      parentProvenance,
      contextManifestHash: sha256Hex(`${parentRunId}:${parentSessionId}`),
      canonicalContractVersion: "1.0.0",
      // Batch CLI has no live interactive parent turn/model identity (unlike
      // `spawn-subagent-tool.ts`'s `deps.getParentModel()`) — `wikiEnrich`'s
      // own already-resolved provider/model is the closest real analog.
      parentModel: { providerId: input.provider, modelId: input.model },
      parentPolicy: shellParentProfile(),
      ledger,
      detected: [{ name: input.provider }],
      config: { maxTreeDepth: 1, maxChildren: 1 },
    };

    const spawned = spawnSubagent(
      {
        attempt: { attemptId: idSeq(), number: 1 },
        branchId: idSeq(),
        budgetRequest: {
          reservationId: idSeq(),
          maxRuntimeMs: input.maxRuntimeMs,
        },
        policyRequest: shellChildReadOnlyProfile(),
        durableResultArtifact: {
          artifactId: idSeq(),
          kind: "final-report",
          hash: sha256Hex(input.page.relativePath),
        },
      },
      ctx,
      { idSeq, clock },
    );

    if (!spawned.ok) {
      return { fallback: true, reason: `deep enrich denied by MAE: ${spawned.reason}`, toolCalls };
    }

    const runModel = spawned.runModel ?? { provider: input.provider, model: input.model };
    const port = input.metaprojectPort ?? createMetaprojectAdapter(input.cwd);
    const tools = buildDeepEnrichTools(port);

    const factory = input.providerFactory ?? makeProvider;
    let provider: ProviderPort;
    try {
      provider = factory(runModel.provider, runModel.model, {
        fetch: input.fetch ?? globalThis.fetch,
        env,
        ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
      });
    } catch (cause) {
      ledger.release(spawned.reservation.reservationId, { maxRuntimeMs: 0 });
      return { fallback: true, reason: `provider construction failed: ${errorMessage(cause)}`, toolCalls };
    }

    // `input.maxToolCalls` is the persisted config field name (`rlm.deep.maxToolCalls`,
    // TRD §3.1 — kept unchanged, see this input's own doc comment); its value is
    // now interpreted as a round count, not a unique-tool-call count.
    const effectiveMaxRounds = input.maxToolCalls;
    const deps: AgentDeps = {
      provider,
      providerId: runModel.provider,
      modelId: runModel.model,
      tools,
      systemInstruction: buildDeepSystemInstruction(input.systemPrompt, effectiveMaxRounds),
      idSeq,
      maxRounds: effectiveMaxRounds,
    };

    let assistant = "";
    let pending: DeepEnrichToolCall | undefined;
    const abort = new AbortController();
    const composed = composeAbortSignals(input.signal, abort.signal);
    const io: AgentIO = {
      write: (s) => {
        assistant += s;
      },
      onAssistantText: (text) => {
        assistant = text;
      },
      onToolCall: (name, toolInput) => {
        pending = { name, input: toolInput, isError: false };
      },
      onToolResult: (name, result) => {
        if (pending !== undefined && pending.name === name) {
          pending.isError = result.isError;
          toolCalls.push(pending);
        } else {
          toolCalls.push({ name, input: "", isError: result.isError });
        }
        pending = undefined;
      },
      // MUST be defined: `runAgentTurnCore`'s `system()` helper falls back to
      // `io.write` whenever `onSystem` is absent (`commands/agent.ts`), which
      // would otherwise splice budget/reprompt/error diagnostics straight
      // into `assistant` — the exact text this function returns as the
      // enriched page. A no-op here (diagnostics are not page content) is
      // deliberate, not an oversight; pinned by
      // `deep-enrich.test.ts`'s "empty model response" test.
      onSystem: () => {},
      // Every granted tool is `risk: "read"` (METAPROJECT_OPERATIONS, filtered
      // to DEEP_ENRICH_OPS) so approval is never actually requested on this
      // path — deny-all is here only as the same fail-closed default every
      // other unattended/batch AgentIO in this codebase uses.
      requestApproval: async () => false,
    };

    const startedAt = performance.now();
    const releaseBudget = (): void => {
      ledger.release(spawned.reservation.reservationId, {
        maxRuntimeMs: Math.round(performance.now() - startedAt),
        maxToolCalls: toolCalls.length,
      });
    };

    const history: NormalizedMessage[] = [];
    const userLine = buildDeepUserPrompt(input.page, input.original, input.extraInstruction);
    const turn = runAgentTurn(io, deps, history, userLine, { signal: composed.signal });

    const deadlineMs = spawned.reservation.maxRuntimeMs;
    if (deadlineMs <= 0) {
      // Defense in depth (flow 169 T10, review finding #3), even with the
      // `config.ts` clamp in place: a non-positive budget must NEVER mean
      // "await with no bound" — that was this branch's actual bug (`else {
      // await turn; }`, no timeout at all), silently removing the deep
      // child's core safety guarantee for any value that reached here
      // unclamped. Treat it as the budget already being exhausted — abort
      // the just-started turn immediately and fall back, the same outward
      // outcome a real timeout produces, instead of waiting on it at all.
      abort.abort();
      void turn.catch(() => {
        // A provider may ignore cancellation; contain any late rejection from
        // the abandoned turn after the caller has already fallen back.
      });
      composed.dispose();
      releaseBudget();
      return {
        fallback: true,
        reason: `deep enrich given a non-positive runtime budget (${deadlineMs}ms); treated as already exhausted`,
        toolCalls,
      };
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), deadlineMs);
    });
    let onExternalAbort: (() => void) | undefined;
    const cancelled = new Promise<"cancelled">((resolve) => {
      if (input.signal === undefined) return;
      onExternalAbort = () => resolve("cancelled");
      if (input.signal.aborted) {
        onExternalAbort();
      } else {
        input.signal.addEventListener("abort", onExternalAbort, { once: true });
      }
    });
    let outcome: "done" | "timeout" | "cancelled";
    try {
      outcome = await Promise.race([turn.then(() => "done" as const), expired, cancelled]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (onExternalAbort !== undefined) {
        input.signal?.removeEventListener("abort", onExternalAbort);
      }
    }
    if (outcome === "cancelled") {
      abort.abort(input.signal?.reason);
      void turn.catch(() => {
        // A provider may ignore cancellation; contain any late rejection from
        // the abandoned turn after the caller has already returned.
      });
      composed.dispose();
      releaseBudget();
      return { fallback: true, reason: "deep enrich cancelled", toolCalls };
    }
    if (outcome === "timeout") {
      abort.abort();
      void turn.catch(() => {
        // A provider may ignore cancellation; contain any late rejection from
        // the abandoned turn after the caller has already fallen back.
      });
      composed.dispose();
      releaseBudget();
      const partial = assistant.trim();
      return {
        fallback: true,
        reason: `deep enrich timed out after ${deadlineMs}ms and was abandoned`,
        ...(partial.length > 0 ? { partial } : {}),
        toolCalls,
      };
    }

    composed.dispose();
    releaseBudget();
    if (input.signal?.aborted) {
      return {
        fallback: true,
        reason: "deep enrich cancelled",
        toolCalls,
      };
    }
    const raw =
      assistant.trim().length > 0
        ? assistant.trim()
        : history
            .filter((m) => m.role === "assistant")
            .map((m) => m.content)
            .join("\n")
            .trim();
    if (raw.length === 0) {
      return { fallback: true, reason: "empty model response", toolCalls };
    }
    return { enriched: raw, toolCalls };
  } catch (cause) {
    return { fallback: true, reason: `deep enrich failed: ${errorMessage(cause)}`, toolCalls };
  }
}
