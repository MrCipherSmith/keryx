// OpenTUI interactive agent shell (flows 060 skeleton + 061 chrome parity).
//
// A new IO implementation of the existing `AgentIO` hook surface (src/commands/
// agent.ts): it renders into an OpenTUI transcript and drives `runAgentTurn` from
// a `split-footer` composer (a fixed footer input over a scrolling main region —
// the Pi/grok layout). Chrome parity with the readline shell: assistant text →
// one sibling renderable per markdown segment, styled by the worker-free
// `markdownToChunks` (the native `MarkdownRenderable` is deliberately NOT used —
// flow 109 decision D-2); `● keryx` role header; `⚙ tool(args)` (via the pure
// `summarizeToolArgs`); collapsed tool output (`collapseToolOutput`); dim
// `⋯ thinking` reasoning; dim `↑in ↓out tokens`. The deterministic driver and the
// pure helpers are unchanged. Gutter = the transcript box `padding`.
//
// `@opentui/core` is an OPTIONAL dependency (ADR-0005) loaded ONLY via a dynamic
// `import()` — never a top-level import (keryx's zero-`dependencies` floor + lazy
// optional-import guard, src/capability/no-optional-imports). `launchTuiAgentShell`
// is defensive: it returns `false` (caller falls back to the readline shell)
// whenever there is no TTY, the package is absent, or the renderer fails to init.
import type { AgentDeps, AgentIO } from "../commands/agent";
import { runAgentTurn } from "../commands/agent";
import type { NormalizedMessage } from "../harness/provider/types";
import { AGENT_SLASH_COMMANDS, filterCommands, findAgentCommand } from "../commands/agent-commands";
import type { DetectedProvider } from "../commands/select";
import { resolveModelsForPicker } from "../commands/providers";
import { collapseToolOutput, summarizeToolArgs } from "../lib/ui";
import { saveApiKey, saveShellConfig } from "../lib/shell-config";
import {
  allowShellPattern,
  isShellCommandAllowed,
  loadShellPermissions,
  parseShellExecCommand,
  suggestShellPatterns,
} from "../lib/shell-permissions";
import { isWikiEnrichIntent, planWikiEnrich, wikiEnrich } from "../wiki/enrich";
import {
  compactSession,
  createSession,
  findSession,
  listSessions,
  openSession,
  persistHistory,
  shortSessionId,
  type SessionHandle,
} from "../session";
import { setAskUserHost } from "./ask-user-bridge";
import { showComposerChoice, type ChoiceOption } from "./composer-choice";
import {
  buildSideWorkerPrompt,
  buildSideWorkerSystemInstruction,
  isSideWorkerId,
  SIDE_WORKER_ID_PREFIX,
  sideWorkerLabel,
} from "./side-worker";
import { setSubagentFleetListener } from "./subagent-bridge";
import { formatFleetSidebar, MAIN_AGENT_ID, shortWorkerLabel, WorkerFleet } from "./worker-fleet";
import { segmentMarkdown, type MdSegment } from "../lib/md-blocks";
import {
  createBlockMount,
  createBlockNavController,
  createBlockRegistry,
  createSegmentView,
  createStreamSegmenter,
  markdownToChunks,
  type BlockState,
  type SegmentView,
} from "./transcript-blocks";

/** A resolved provider/model selection. */
export interface TuiSelection {
  provider: string;
  model: string;
  baseUrl?: string;
}

/** The `@opentui/core` module shape, referenced structurally (type-only import). */
type OpenTui = typeof import("@opentui/core");
type Renderer = Awaited<ReturnType<OpenTui["createCliRenderer"]>>;
type Box = InstanceType<OpenTui["BoxRenderable"]>;
type StyledContent = string | ReturnType<OpenTui["t"]>;

// `markdownToChunks` now lives in `./transcript-blocks` (flow 109) so the render
// rules are unit-testable and shared with the block bodies.

/**
 * Build an `AgentIO` that renders into an OpenTUI `transcript` box with chrome
 * parity: streamed tokens (`write`) go through `createStreamSegmenter` and paint
 * one `SegmentView` per markdown segment (prose via `markdownToChunks`, a fence
 * as a framed language-tagged box — no `MarkdownRenderable`, D-2); tool
 * calls/results, reasoning, usage, and system lines append styled one-liners.
 * Exported so the headless test can drive the same render path through
 * `runAgentTurn` without a real TTY. Pass the reasoning/tool hooks through
 * {@link attachBlockIo} to upgrade those one-liners into retained blocks (AC1).
 */
export function createTuiAgentIo(otui: OpenTui, renderer: Renderer, transcript: Box): AgentIO {
  let seq = 0;
  const append = (content: StyledContent): void => {
    transcript.add(new otui.TextRenderable(renderer, { id: `n${seq++}`, content }));
  };

  // An assistant message is a COLUMN of sibling renderables — one per markdown
  // segment (flow 109 / AC5) — so a fenced block can be framed with its language
  // tag instead of being flattened into one dim `TextRenderable`.
  type Message = {
    container: Box;
    segmenter: ReturnType<typeof createStreamSegmenter>;
    views: SegmentView[];
    /** Views whose segment is final; never repainted again (risk R1). */
    frozen: number;
  };
  let message: Message | undefined;

  const startMessage = (): Message => {
    const container = new otui.BoxRenderable(renderer, {
      id: `msg${seq++}`,
      flexDirection: "column",
      flexShrink: 0,
    });
    transcript.add(container);
    return { container, segmenter: createStreamSegmenter(), views: [], frozen: 0 };
  };

  // Repaint from `frozen` onwards only: earlier segments are settled, so a token
  // costs the trailing segment's render and nothing else.
  const paint = (m: Message, segments: readonly MdSegment[], frozen: number): void => {
    for (let i = m.frozen; i < segments.length; i++) {
      const segment = segments[i];
      if (segment === undefined) {
        continue;
      }
      const existing = m.views[i];
      if (existing !== undefined && existing.kind === segment.kind) {
        existing.update(segment);
        continue;
      }
      existing?.destroy();
      m.views[i] = createSegmentView(otui, renderer, m.container, segment);
    }
    for (const stale of m.views.splice(segments.length)) {
      stale.destroy();
    }
    m.frozen = frozen;
  };

  return {
    // Assistant text streams into per-segment renderables: worker-free markdown
    // chunks for prose (parity with the readline `renderMarkdown`) and a framed
    // language-tagged box per fence.
    write: (s) => {
      if (s.length === 0) {
        return;
      }
      const m = (message ??= startMessage());
      const { segments, frozen } = m.segmenter.push(s);
      paint(m, segments, frozen);
    },
    onAssistantText: (text) => {
      const m = message ?? startMessage();
      // The authoritative final text: re-segment ONCE (not per token) and rebuild.
      for (const view of m.views.splice(0)) {
        view.destroy();
      }
      m.frozen = 0;
      const segments = segmentMarkdown(text);
      paint(m, segments, segments.length);
      if (segments.length === 0) {
        try {
          transcript.remove(m.container);
        } catch {
          // best-effort teardown
        }
      }
      message = undefined;
    },
    // Reasoning is COLLAPSED to a one-line marker (grok/opencode style) instead of
    // dumping the whole chain-of-thought; `line count` hints at its length.
    onReasoning: (text) => {
      const lines = text.trim().split("\n").filter((l) => l.trim().length > 0).length;
      append(otui.t`${otui.dim(`◆ thought (${lines} line${lines === 1 ? "" : "s"})`)}`);
    },
    onUsage: (usage) => {
      const parts: string[] = [];
      if (usage.inputTokens !== undefined) {
        parts.push(`↑${usage.inputTokens}`);
      }
      if (usage.outputTokens !== undefined) {
        parts.push(`↓${usage.outputTokens}`);
      }
      if (parts.length > 0) {
        append(otui.t`${otui.dim(`${parts.join(" ")} tokens`)}`);
      }
    },
    onToolCall: (name, input) => {
      const args = summarizeToolArgs(input);
      const call = args.length > 0 ? `${name}(${args})` : `${name}()`;
      append(otui.t`${otui.cyan(`⚙ ${call}`)}`);
    },
    onToolResult: (_name, result) => {
      const { summary, hidden } = collapseToolOutput(result.output);
      const more = hidden > 0 ? ` · +${hidden} more` : "";
      const line = `${result.isError ? "✗" : "↳"} ${summary}${more}`;
      append(result.isError ? otui.t`${otui.red(line)}` : otui.t`${otui.dim(line)}`);
    },
    onSystem: (text) => append(text.includes("[error]") ? otui.t`${otui.red(text)}` : otui.t`${otui.dim(text)}`),
  };
}

/** Registers a block and mounts its view; returns the new block id. */
export type BlockSink = (
  input: { kind: string; summary: string; fullText: string; lineCount: number },
  options?: { hint?: string; tone?: "dim" | "cyan" | "red" },
) => string;

/** Shell chrome that runs BEFORE each block is registered (busy phase, fleet). */
export interface BlockIoChrome {
  onReasoning?: (text: string) => void;
  onToolCall?: (name: string, input: string) => void;
  onToolResult?: AgentIO["onToolResult"];
}

/**
 * Upgrade the reasoning / tool-call / tool-result hooks of `io` so each one is
 * registered as a RETAINED, addressable block instead of a one-line renderable
 * whose text is discarded (AC1). This is the real wiring the shell installs —
 * it lives here, exported, so a headless test can drive `runAgentTurn` through
 * it and assert the recovered payload, rather than proving a replica.
 *
 * The `createTuiAgentIo` defaults are REPLACED, not chained: they append their
 * own line and would double-print. `chrome` keeps the shell's per-event side
 * effects (busy phase, fleet status) out of this mapping.
 */
export function attachBlockIo(io: AgentIO, addBlock: BlockSink, chrome: BlockIoChrome = {}): AgentIO {
  io.onReasoning = (text) => {
    chrome.onReasoning?.(text);
    const body = text.trim();
    const lineCount = body.split("\n").filter((l) => l.trim().length > 0).length;
    addBlock({ kind: "thought", summary: "", fullText: body, lineCount }, { hint: "/think · ctrl+o" });
  };
  io.onToolCall = (name, input) => {
    chrome.onToolCall?.(name, input);
    const args = summarizeToolArgs(input);
    // The block retains the RAW input json; the header keeps the compact call.
    addBlock(
      {
        kind: "tool",
        summary: `⚙ ${args.length > 0 ? `${name}(${args})` : `${name}()`}`,
        fullText: input,
        lineCount: input.split("\n").length,
      },
      { hint: "ctrl+o", tone: "cyan" },
    );
  };
  io.onToolResult = (name, result) => {
    chrome.onToolResult?.(name, result);
    const { summary, lineCount, hidden } = collapseToolOutput(result.output);
    const more = hidden > 0 ? ` · +${hidden} more` : "";
    addBlock(
      {
        kind: "output",
        summary: `${result.isError ? "✗" : "↳"} ${summary}${more}`,
        fullText: result.output,
        lineCount,
      },
      { hint: "/expand · ctrl+o", ...(result.isError ? { tone: "red" as const } : {}) },
    );
  };
  return io;
}

/** True only for an explicit `y`/`yes` (case-insensitive). Default-deny otherwise. */
export function isShellApproved(answer: string): boolean {
  return /^y(es)?$/i.test(answer.trim());
}

/** Outcomes of the interactive shell_exec approval picker (OpenCode-style). */
export type ShellApprovalChoice = "once" | "always-exact" | "always-prefix" | "deny";

/** Outcomes of the wiki-enrich pre-router picker. */
export type WikiEnrichChoice = "drafts" | "force" | "cancel";

/**
 * Ask how to run wiki enrich (composer-dock menu, above the input).
 * drafts = batch drafts only; force = all statuses; cancel = do nothing.
 */
async function pickWikiEnrichMode(
  otui: OpenTui,
  r: Renderer,
  dock: Box,
  plan: { draftCount: number; acceptedCount: number; total: number },
): Promise<WikiEnrichChoice> {
  const id = await showComposerChoice(otui, r, dock, {
    title: "Wiki enrich",
    subtitle: `drafts: ${plan.draftCount} · accepted: ${plan.acceptedCount} · total: ${plan.total}`,
    cancelId: "cancel",
    options: [
      {
        id: "drafts",
        label: `Enrich ${plan.draftCount} draft page(s)`,
        description: "Default batch — Status: draft only",
        recommended: true,
      },
      {
        id: "force",
        label: `Force enrich all ${plan.total} page(s)`,
        description: `Includes ${plan.acceptedCount} accepted (+ other statuses)`,
      },
      {
        id: "cancel",
        label: "Skip / cancel",
        description: "Do not run enrich",
      },
    ],
  });
  return id === "drafts" || id === "force" || id === "cancel" ? id : "cancel";
}

/**
 * Shell permission menu (composer-dock, above input — same band as `/` commands).
 */
async function pickShellApproval(
  otui: OpenTui,
  r: Renderer,
  dock: Box,
  command: string,
): Promise<ShellApprovalChoice> {
  const { exact, prefix } = suggestShellPatterns(command);
  const id = await showComposerChoice(otui, r, dock, {
    title: "Allow shell command?",
    subtitle: command.length > 120 ? `${command.slice(0, 117)}…` : command,
    cancelId: "deny",
    options: [
      {
        id: "once",
        label: "Allow once",
        description: "Run only this time",
        recommended: true,
      },
      {
        id: "always-exact",
        label: `Always allow “${exact.length > 40 ? `${exact.slice(0, 37)}…` : exact}”`,
        description: "Remember exact command (permissions.json)",
      },
      {
        id: "always-prefix",
        label: `Always allow “${prefix}”`,
        description: "Remember this prefix (permissions.json)",
      },
      {
        id: "deny",
        label: "Deny",
        description: "Do not run",
      },
    ],
  });
  if (id === "once" || id === "always-exact" || id === "always-prefix" || id === "deny") {
    return id;
  }
  return "deny";
}

/** Compact token count for the header counter: 1234 → "1.2K", else the number. */
export function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}

/** Composer grows 1…max rows with wrap; beyond max the textarea scrolls vertically. */
export const COMPOSER_MIN_ROWS = 1;
export const COMPOSER_MAX_ROWS = 6;

/** Pure: clamp visual line count into the composer height band. */
export function composerHeightForLines(
  visualLines: number,
  min = COMPOSER_MIN_ROWS,
  max = COMPOSER_MAX_ROWS,
): number {
  const n = Number.isFinite(visualLines) ? Math.floor(visualLines) : min;
  return Math.min(max, Math.max(min, n < 1 ? min : n));
}

/**
 * Rough token estimate of the conversation (≈ 4 chars/token) — a fallback for the
 * context counter when the provider does not report exact `usage` (e.g. local
 * Ollama models). Pure.
 */
export function estimateContextTokens(history: readonly { content: string }[]): number {
  const chars = history.reduce((n, m) => n + m.content.length, 0);
  return Math.round(chars / 4);
}

/**
 * Box height (rows) for a `SelectRenderable` so ALL `count` items stay visible.
 * OpenTUI renders each item across `linesPerItem` rows — 2 when descriptions are
 * shown, 1 otherwise — and `maxVisibleItems = floor(height / linesPerItem)`. So a
 * height of `count` rows shows only `count/2` described items (the "only the first
 * provider is listed" bug, flow 084). Height is `count * per`, capped at `max`
 * (overflow then scrolls). Pure.
 */
export function selectBoxHeight(count: number, withDescription: boolean, max = 16): number {
  const per = withDescription ? 2 : 1;
  return Math.min(max, Math.max(per, count * per));
}

/** Current wall-clock time as `h:mm AM/PM` (UI-only; the core stays clock-free). */
function hhmm(): string {
  const d = new Date();
  const h = d.getHours();
  const hour = h % 12 || 12;
  return `${hour}:${d.getMinutes().toString().padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/** A full-screen absolute overlay box (covers the running shell for a picker). */
function overlayBox(otui: OpenTui, r: Renderer, id: string): Box {
  return new otui.BoxRenderable(r, {
    id,
    position: "absolute",
    top: 0,
    left: 0,
    width: "100%",
    height: "100%",
    backgroundColor: "#0a1414",
    flexDirection: "column",
    padding: 1,
  });
}

/** OpenTUI keypress event fields the overlay steps read. */
export type KeypressEvent = {
  name: string;
  ctrl: boolean;
  meta: boolean;
  sequence: string;
  preventDefault: () => void;
  stopPropagation: () => void;
};

/**
 * Subscribe `handler` to OpenTUI's internal keypress stream and return an unsubscribe
 * fn. The single place that reaches into the private `_internalKeyInput` API, so the
 * overlay steps don't each duplicate the on/off wiring (flow 086).
 *
 * Exported for the flow-109 headless nav-mode tests: they subscribe the REAL
 * `createBlockNavController` through this exact wrapper and drive real keys, so
 * the test exercises the shell's own subscription path rather than a replica.
 */
export function onKeypress(r: Renderer, handler: (key: KeypressEvent) => void): () => void {
  r._internalKeyInput.onInternal("keypress", handler);
  return () => r._internalKeyInput.offInternal("keypress", handler);
}

/** Result of the API-key step: a key to save, skip (proceed keyless), or go back. */
type KeyStepResult = { kind: "key"; value: string } | { kind: "skip" } | { kind: "back" };

/**
 * API-key entry step. Enter with text → `key`; empty Enter → `skip` (proceed without
 * a key); Esc → `back` (return to the previous step). Absolute overlay; removes its
 * key handler on close.
 */
function promptApiKeyStep(otui: OpenTui, r: Renderer, opts: { label: string; envKey: string; placeholder?: string }): Promise<KeyStepResult> {
  return new Promise((resolve) => {
    const box = overlayBox(otui, r, "key-picker");
    r.root.add(box);
    box.add(new otui.TextRenderable(r, { id: "kp-title", content: otui.t`${otui.bold(`Paste your ${opts.label} API key`)} ${otui.dim("(Enter · Esc to go back)")}` }));
    box.add(
      new otui.TextRenderable(r, {
        id: "kp-note",
        content: otui.t`${otui.dim(`Set as ${opts.envKey} · saved to your keryx config dir (owner-only, 0600)`)}`,
        marginTop: 1,
      }),
    );
    const keyInput = new otui.InputRenderable(r, { id: "kp-input", placeholder: opts.placeholder ?? "sk-...", marginTop: 1 });
    box.add(keyInput);
    keyInput.focus();
    const onKey = (key: { name: string; preventDefault: () => void; stopPropagation: () => void }): void => {
      if (key.name === "escape") {
        cleanup();
        resolve({ kind: "back" });
        key.preventDefault();
        key.stopPropagation();
      }
    };
    const unsub = onKeypress(r, onKey);
    const cleanup = (): void => {
      unsub();
      r.root.remove(box);
    };
    keyInput.on(otui.InputRenderableEvents.ENTER, () => {
      const value = keyInput.value.trim();
      cleanup();
      resolve(value.length > 0 ? { kind: "key", value } : { kind: "skip" });
    });
  });
}

/**
 * Resolve models for the picker: always probe the live `/models` endpoint when
 * the provider is OpenAI-compat (network available + optional Bearer key);
 * curated registry list is offline/401 fallback only.
 */
async function modelsForPicker(prov: DetectedProvider): Promise<string[]> {
  const result = await resolveModelsForPicker(globalThis.fetch, prov, process.env);
  return result.models;
}

/** Provider-selection step. Resolves the chosen provider, or `undefined` on Esc/cancel. */
function pickProviderStep(otui: OpenTui, r: Renderer, detected: DetectedProvider[]): Promise<DetectedProvider | undefined> {
  return new Promise((resolve) => {
    const box = overlayBox(otui, r, "picker");
    r.root.add(box);
    box.add(new otui.TextRenderable(r, { id: "picker-title", content: otui.t`${otui.bold("Select a provider")} ${otui.dim("(↑/↓, Enter · Esc to cancel)")}` }));
    // Match by the displayed label (unique) so registry ids stay hidden but resolvable.
    const labelOf = (d: DetectedProvider): string => d.label ?? d.name;
    const provSelect = new otui.SelectRenderable(r, {
      id: "picker-provider",
      width: 60,
      // Descriptions are shown → 2 rows per item, so height must be 2× the count
      // or only half the providers stay visible (flow 084 fix).
      height: selectBoxHeight(detected.length, true),
      showScrollIndicator: true,
      options: detected.map((d) => ({ name: labelOf(d), description: d.note ?? `${d.models.length} model(s)` })),
      selectedTextColor: "#ffd166",
    });
    box.add(provSelect);
    provSelect.focus();
    const onKey = (key: { name: string; preventDefault: () => void; stopPropagation: () => void }): void => {
      if (key.name === "escape") {
        cleanup();
        resolve(undefined);
        key.preventDefault();
        key.stopPropagation();
      }
    };
    const unsub = onKeypress(r, onKey);
    const cleanup = (): void => {
      unsub();
      r.root.remove(box);
    };
    provSelect.on(otui.SelectRenderableEvents.ITEM_SELECTED, () => {
      const chosen = provSelect.getSelectedOption();
      cleanup();
      resolve(chosen === null ? undefined : detected.find((d) => labelOf(d) === chosen.name));
    });
  });
}

/**
 * In-TUI provider → model → key wizard with BACK navigation: Esc at the provider step
 * cancels; Esc at the model step returns to the provider list; Esc at the key step
 * returns to the model list. Registered providers (OpenRouter, DeepSeek, Z.AI GLM,
 * Cerebras, Groq, Moonshot, …) fetch their LIVE model list and prompt + persist a key
 * when missing. Absolute overlay (works at startup AND for `/connect`). Resolves the
 * selection or `undefined`.
 */
function selectProviderModelInTui(
  otui: OpenTui,
  r: Renderer,
  detected: DetectedProvider[],
): Promise<TuiSelection | undefined> {
  return new Promise((resolve) => {
    if (detected.length === 0) {
      resolve(undefined);
      return;
    }
    void (async () => {
      // Provider ← Esc cancels.
      // Key (when required) ← Esc backs to provider.
      // Model ← Esc backs to provider.
      // IMPORTANT: prompt for the API key BEFORE fetching /models — Z.AI and most
      // OpenAI-compat gateways return 401 without a Bearer key, and we would
      // otherwise show only the short curated fallback (e.g. stale glm-4.5/4.6).
      while (true) {
        const prov = await pickProviderStep(otui, r, detected);
        if (prov === undefined) {
          resolve(undefined);
          return;
        }

        const envKey = prov.envKey;
        if (envKey !== undefined) {
          const existingKey = process.env[envKey];
          if (existingKey === undefined || existingKey.length === 0) {
            const kr = await promptApiKeyStep(otui, r, { label: prov.label ?? prov.name, envKey });
            if (kr.kind === "back") {
              continue; // Esc at the key step → re-pick the provider
            }
            if (kr.kind === "key") {
              process.env[envKey] = kr.value;
              saveApiKey(envKey, kr.value); // persist (0600), opencode-style
            }
            // kind === "skip" → proceed without a key (curated fallback models)
          }
        }

        // Fetch AFTER key is available so live GET /models can authenticate.
        const models = await modelsForPicker(prov);
        const model = await pickModelInTui(otui, r, models);
        if (model === undefined) {
          continue; // Esc at the model step → re-pick the provider
        }
        resolve(
          prov.baseUrl === undefined
            ? { provider: prov.name, model }
            : { provider: prov.name, model, baseUrl: prov.baseUrl },
        );
        return;
      }
    })();
  });
}

/**
 * In-TUI model picker with TYPE-TO-FILTER (search by name, e.g. `free`). Absolute
 * overlay; the SelectRenderable is focused (↑/↓/Enter native) while printable keys
 * and Backspace edit a live filter over the (potentially large) model list. Resolves
 * the chosen model, or `undefined` on Esc / no match. Removes its key handler on close.
 */
function pickModelInTui(otui: OpenTui, r: Renderer, models: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    const all = models.length > 0 ? models : ["fake-echo"];
    const box = overlayBox(otui, r, "model-picker");
    r.root.add(box);
    box.add(new otui.TextRenderable(r, { id: "mp-title", content: otui.t`${otui.bold("Select a model")}` }));
    const filterLine = new otui.TextRenderable(r, { id: "mp-filter", content: otui.t`${otui.dim("type to filter · ↑/↓ Enter · Esc to go back")}` });
    box.add(filterLine);
    const NO_MATCH = "(no match)";
    const sel = new otui.SelectRenderable(r, {
      id: "mp-sel",
      width: 72,
      showDescription: false,
      height: 14,
      showScrollIndicator: true,
      wrapSelection: true,
      options: all.map((m) => ({ name: m, description: "" })),
      selectedTextColor: "#ffd166",
    });
    box.add(sel);
    sel.focus();

    let filter = "";
    const apply = (): void => {
      const q = filter.trim().toLowerCase();
      const matches = q.length > 0 ? all.filter((m) => m.toLowerCase().includes(q)) : all;
      sel.options = matches.length > 0 ? matches.map((m) => ({ name: m, description: "" })) : [{ name: NO_MATCH, description: "" }];
      filterLine.content = otui.t`${otui.dim(q.length > 0 ? `filter: ${filter}  (${matches.length})` : "type to filter · ↑/↓ Enter · Esc to go back")}`;
    };

    const onKey = (key: { name: string; ctrl: boolean; meta: boolean; sequence: string; preventDefault: () => void; stopPropagation: () => void }): void => {
      if (key.name === "escape") {
        cleanup();
        resolve(undefined);
        key.preventDefault();
        key.stopPropagation();
        return;
      }
      if (key.name === "backspace") {
        filter = filter.slice(0, -1);
        apply();
        key.preventDefault();
        key.stopPropagation();
        return;
      }
      const ch = key.sequence;
      if (!key.ctrl && !key.meta && typeof ch === "string" && ch.length === 1 && ch >= " ") {
        filter += ch;
        apply();
        key.preventDefault();
        key.stopPropagation();
      }
      // ↑/↓/Enter fall through to the focused SelectRenderable.
    };
    const unsub = onKeypress(r, onKey);
    const cleanup = (): void => {
      unsub();
      r.root.remove(box);
    };

    sel.on(otui.SelectRenderableEvents.ITEM_SELECTED, () => {
      const chosen = sel.getSelectedOption();
      cleanup();
      resolve(chosen === null || chosen.name === NO_MATCH ? undefined : chosen.name);
    });
  });
}

/**
 * Run the OpenTUI agent shell. OpenTUI owns the terminal from the START — there is
 * NO concurrent readline (that leaked terminal query responses, flows 065/066).
 * The provider/model is taken from `opts.initial` (flags) or an in-TUI picker over
 * `opts.detected`; `opts.makeAgentDeps` then builds the driver deps. Returns `true`
 * once the user exits, `false` if it declined/failed (no TTY / absent optional dep)
 * so the caller can fall back to the readline shell. Never throws.
 */
export async function launchTuiAgentShell(opts: {
  detected: DetectedProvider[];
  initial?: TuiSelection;
  makeAgentDeps: (sel: TuiSelection) => Promise<AgentDeps>;
  /** Re-probe providers for `/connect` and `/model` (fresh detection). */
  redetect?: () => Promise<DetectedProvider[]>;
  /**
   * Per-project session bootstrap. Sessions never cross git-root/cwd boundaries.
   * `pickOnStart` opens the resume menu when `-r` is given without an id.
   */
  session?: {
    cwd: string;
    continueLast?: boolean;
    resumeId?: string;
    pickOnStart?: boolean;
  };
}): Promise<boolean> {
  if (!process.stdout.isTTY) {
    return false;
  }
  let otui: OpenTui;
  try {
    otui = await import("@opentui/core"); // optional dep; absent → fall back
  } catch {
    return false;
  }

  let renderer: Renderer | undefined;
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  // Pending `shell_exec` approval (legacy y/N path + interactive picker teardown).
  let uid = 0;
  let pendingApproval: ((ok: boolean) => void) | undefined;
  /** Session-scoped allow patterns (plus persisted permissions.json). */
  const sessionShellAllow = new Set<string>(loadShellPermissions().allow);
  try {
    // Stable non-nullable handle for the closures below (the outer `renderer`
    // stays `Renderer | undefined` for the `finally` teardown).
    const r = (renderer = await otui.createCliRenderer({
      exitOnCtrlC: true,
      // Full-screen (grok/opencode style): own the alternate screen buffer so the
      // shell's prior scrollback is cleared on launch and restored on exit, and
      // the layout fills the terminal (composer anchored to the bottom). The
      // earlier `split-footer` left the launch output on screen and floated the
      // composer mid-screen.
      screenMode: "alternate-screen",
      clearOnShutdown: true,
      // Enable mouse so OpenTUI tracks drag-selection (the alternate screen would
      // otherwise disable the terminal's native selection). Copy-on-select is
      // wired below (OSC52), matching grok/opencode.
      useMouse: true,
      onDestroy: () => {
        pendingApproval?.(false); // deny any in-flight approval on exit
        pendingApproval = undefined;
        clearBusyTimer?.(); // stop live spinner if a turn is mid-flight
        setAskUserHost(undefined);
        setSubagentFleetListener(undefined);
        resolveDone();
      },
    }));
    // Assigned once the sidebar toast is built (below); the copy handler may fire
    // before then, so start with a safe no-op.
    let showToast: (msg: string) => void = () => {};
    let clearBusyTimer: (() => void) | undefined;
    // Copy-on-select (grok/opencode): when a mouse selection changes, copy the
    // selected text to the SYSTEM clipboard via OSC52 (works locally and over SSH;
    // the terminal must permit clipboard access — e.g. iTerm2's "Applications may
    // access the clipboard"). Best-effort: any failure is ignored.
    r.on(otui.CliRenderEvents.SELECTION, () => {
      try {
        const text = r.getSelection()?.getSelectedText() ?? "";
        if (text.length > 0) {
          r.copyToClipboardOSC52(text);
          showToast("Copied to clipboard");
        }
      } catch {
        // clipboard access not permitted — ignore
      }
    });

    // Resolve the provider/model — from flags, or an in-TUI picker.
    const sel = opts.initial ?? (await selectProviderModelInTui(otui, r, opts.detected));
    if (sel === undefined) {
      r.destroy();
      return true; // could not select; treat as a clean exit (do not fall back)
    }
    // Persist the chosen provider/model (opencode-style) so the next launch reuses it.
    saveShellConfig(sel.baseUrl === undefined ? { provider: sel.provider, model: sel.model } : { provider: sel.provider, model: sel.model, baseUrl: sel.baseUrl });
    // Mutable: `/connect` and `/model` rebuild these mid-session.
    let currentSel: TuiSelection = sel;
    let deps = await opts.makeAgentDeps(sel);

    // opencode-style layout: a main chat column on the left + a right status
    // sidebar (model, context, tools).
    const rootRow = new otui.BoxRenderable(r, { id: "root-row", flexGrow: 1, flexDirection: "row" });
    r.root.add(rootRow);
    const main = new otui.BoxRenderable(r, { id: "main", flexGrow: 1, minWidth: 0, flexDirection: "column" });
    rootRow.add(main);
    const sidebar = new otui.BoxRenderable(r, {
      id: "sidebar",
      width: 30,
      flexShrink: 0,
      flexDirection: "column",
      border: ["left"],
      borderColor: "#22333b",
      paddingLeft: 2,
      paddingRight: 1,
      paddingTop: 1,
    });
    rootRow.add(sidebar);
    sidebar.add(new otui.TextRenderable(r, { id: "sb-title", content: otui.t`${otui.bold("keryx")}` }));
    sidebar.add(new otui.TextRenderable(r, { id: "sb-model-k", content: otui.t`${otui.dim("Model")}`, marginTop: 1 }));
    const sbModelV = new otui.TextRenderable(r, { id: "sb-model-v", content: otui.t`${otui.dim(`${sel.provider}/${sel.model}`)}` });
    sidebar.add(sbModelV);
    sidebar.add(new otui.TextRenderable(r, { id: "sb-ctx-k", content: otui.t`${otui.dim("Context")}`, marginTop: 1 }));
    const sbContext = new otui.TextRenderable(r, { id: "sb-ctx-v", content: otui.t`${otui.dim("0 tokens")}` });
    sidebar.add(sbContext);
    sidebar.add(new otui.TextRenderable(r, { id: "sb-tools-k", content: otui.t`${otui.dim("Tools")}`, marginTop: 1 }));
    sidebar.add(
      new otui.TextRenderable(r, { id: "sb-tools-v", content: otui.t`${otui.dim(`${deps.tools.length} available`)}` }),
    );
    // Multi-agent / page-worker fleet (enrich swarm + future harness subagents).
    // Live activity: main agent phase + optional enrich/subagent fleet.
    // Yellow when blocked (user must act), red on failure — not cryptic glyphs only.
    sidebar.add(new otui.TextRenderable(r, { id: "sb-status-k", content: otui.t`${otui.dim("Status")}`, marginTop: 1 }));
    const sbWorkers = new otui.TextRenderable(r, {
      id: "sb-status-v",
      content: otui.t`${otui.dim("○ Ready")}`,
    });
    sidebar.add(sbWorkers);
    const fleet = new WorkerFleet();
    const paintFleet = (): void => {
      const list = fleet.list();
      const text = formatFleetSidebar(list, 12);
      const main = list.find((w) => w.id === MAIN_AGENT_ID);
      if (main?.status === "blocked") {
        sbWorkers.content = otui.t`${otui.yellow(text)}`;
      } else if (main?.status === "failed") {
        sbWorkers.content = otui.t`${otui.red(text)}`;
      } else {
        sbWorkers.content = otui.t`${otui.dim(text)}`;
      }
    };
    fleet.subscribe(paintFleet);
    // MAE spawn_subagent → Workers panel
    setSubagentFleetListener((ev) => {
      if (ev.kind === "remove") {
        fleet.remove(ev.id);
        return;
      }
      fleet.upsert({
        id: ev.id,
        label: ev.label,
        status: ev.status,
        ...(ev.detail !== undefined ? { detail: ev.detail } : {}),
        ...(ev.model !== undefined ? { model: ev.model } : {}),
      });
    });

    /** Update the pinned main-agent slot (Activity panel). */
    const setMainAgent = (
      status: "queued" | "running" | "done" | "failed" | "blocked",
      detail?: string,
    ): void => {
      fleet.upsert({
        id: MAIN_AGENT_ID,
        label: "main",
        status,
        ...(detail !== undefined ? { detail } : {}),
        model: `${currentSel.provider}/${currentSel.model}`,
      });
    };
    // Idle main agent visible from launch.
    setMainAgent("queued", "ready");
    // Toast area pinned to the bottom of the sidebar (spacer pushes it down).
    sidebar.add(new otui.BoxRenderable(r, { id: "sb-spacer", flexGrow: 1 }));
    const toastText = new otui.TextRenderable(r, { id: "sb-toast", content: "" });
    sidebar.add(toastText);
    // A transient toast: `✓ <msg>`, cleared after 5s or replaced by the next toast.
    let toastTimer: ReturnType<typeof setTimeout> | undefined;
    showToast = (msg: string): void => {
      toastText.content = otui.t`${otui.green(`✓ ${msg}`)}`;
      if (toastTimer !== undefined) {
        clearTimeout(toastTimer);
      }
      toastTimer = setTimeout(() => {
        toastText.content = "";
        toastTimer = undefined;
      }, 5000);
    };

    // Header bar (grok-style): identity on the left, cumulative token counter on
    // the right (updated from usage).
    const header = new otui.BoxRenderable(r, {
      id: "header",
      flexShrink: 0,
      flexDirection: "row",
      justifyContent: "space-between",
      paddingLeft: 1,
      paddingRight: 1,
    });
    const headerLeft = new otui.TextRenderable(r, {
      id: "header-left",
      content: otui.t`${otui.dim(`keryx · agent · ${sel.provider}/${sel.model}`)}`,
    });
    header.add(headerLeft);
    const tokenText = new otui.TextRenderable(r, { id: "header-tokens", content: otui.t`${otui.dim("↑0 ↓0")}` });
    header.add(tokenText);
    main.add(header);

    // A scrollable, sticky-to-bottom transcript so long conversations scroll and
    // auto-follow the newest output; the AgentIO renders into its `.content`.
    const scroll = new otui.ScrollBoxRenderable(r, {
      id: "transcript",
      flexGrow: 1,
      minHeight: 0,
      scrollY: true,
      stickyScroll: true,
      stickyStart: "bottom",
      contentOptions: { flexDirection: "column", paddingLeft: 1, paddingRight: 1 },
    });
    main.add(scroll);
    const transcript = scroll.content;

    const io = createTuiAgentIo(otui, r, transcript);
    // Cumulative token usage → the header counter + sidebar. Prefer the provider's
    // EXACT `usage`; fall back to an estimate (see the turn `finally` below) for
    // providers that report nothing (e.g. local Ollama models).
    let totalIn = 0;
    let totalOut = 0;
    let hasExactUsage = false;
    const baseWrite = io.write.bind(io);
    const baseOnSystem = io.onSystem?.bind(io);
    // Live phase updates (footer spinner + in-transcript status) — defined after
    // footer chrome below; assigned no-ops until then, then rewired.
    let setBusyPhase: (phase: string) => void = () => {};
    // setMainAgent is already defined above (Workers fleet); hooks close over it.

    // --- collapsible transcript blocks (flow 109) --------------------------
    // Reasoning, tool calls and tool results become addressable blocks that
    // RETAIN their full text (bounded — D-4) instead of discarding it, so they
    // can be expanded in place, navigated with the keyboard and copied.
    const blocks = createBlockRegistry();
    const blockMount = createBlockMount(otui, r, transcript, blocks);
    // The whole modal navigation mode (focus guard, key dispatch, sticky-scroll
    // suspension) lives in `transcript-blocks.ts` so it is reachable from a
    // headless test; the closure keeps only wiring (risk R5). `overlayActive`,
    // `menu`/`menuNav` and `paintBusyStatus` are declared further down — the
    // callbacks below are only ever invoked from a keypress, long after.
    const nav = createBlockNavController({
      registry: blocks,
      view: (id) => blockMount.view(id),
      scroll,
      isBlocked: () => (menu.visible && menuNav) || overlayActive(),
      focusComposer: () => input.focus(),
      blurComposer: () => textarea.blur(),
      copyText: (text) => r.copyToClipboardOSC52(text),
      toast: (message) => showToast(message),
      onChange: () => paintBusyStatus(),
    });
    const navMode = (): boolean => nav.active();
    const focusComposer = (): void => nav.restoreComposerFocus();
    const setBlockCollapsed = (id: string, collapsed: boolean): void => nav.setCollapsed(id, collapsed);
    const newestBlock = (kind?: string): BlockState | undefined => nav.newest(kind);
    const copyBlock = (id: string): boolean => nav.copy(id);

    /** Register + render a new collapsed block at the end of the transcript. */
    const addBlock: BlockSink = (input, options = {}) => {
      const id = blockMount.add(input, options);
      nav.paint(id);
      return id;
    };

    io.write = (s: string) => {
      if (s.length > 0) {
        setBusyPhase("streaming reply");
        setMainAgent("running", "streaming");
      }
      baseWrite(s);
    };
    io.onUsage = (u) => {
      if ((u.inputTokens ?? 0) === 0 && (u.outputTokens ?? 0) === 0) {
        return; // a 0/0 report is not usable — keep the estimate
      }
      hasExactUsage = true;
      totalIn += u.inputTokens ?? 0;
      totalOut += u.outputTokens ?? 0;
      tokenText.content = otui.t`${otui.dim(`↑${fmtTokens(totalIn)} ↓${fmtTokens(totalOut)}`)}`;
      sbContext.content = otui.t`${otui.dim(`${(totalIn + totalOut).toLocaleString()} tokens`)}`;
    };
    // Reasoning / tool call / tool result all render as collapsed BLOCKS whose
    // full text is retained (AC1). The event → block mapping itself lives in the
    // exported `attachBlockIo` (headlessly testable); the closure contributes
    // only the busy-phase / fleet chrome that needs these locals.
    attachBlockIo(io, addBlock, {
      onReasoning: () => {
        setBusyPhase("thinking");
        setMainAgent("running", "thinking");
      },
      onToolCall: (name, toolInput) => {
        const args = summarizeToolArgs(toolInput);
        const short = args.length > 40 ? `${args.slice(0, 37)}…` : args;
        setBusyPhase(short.length > 0 ? `running ${name}(${short})` : `running ${name}`);
        // Keep tool names intact for humanFleetPhase ("tool: shell_exec").
        setMainAgent("running", name.length > 20 ? `${name.slice(0, 18)}…` : name);
      },
      onToolResult: (name, result) => {
        setBusyPhase(result.isError ? `tool error · waiting for model` : `waiting for model`);
        // Stay "running" between tools (multi-step turn); only terminal on turn end.
        setMainAgent("running", result.isError ? `err:${name.slice(0, 14)}` : "waiting");
      },
    });
    io.onSystem = (text) => {
      // Surface budget/stop/errors on the main agent slot.
      if (/\[error\]|\[budget\]|\[stopped\]/i.test(text)) {
        setMainAgent("failed", text.includes("[budget]") ? "budget" : "error");
      }
      baseOnSystem?.(text);
    };

    // Bottom chrome (above footer): choice dock + slash menu + composer.
    // Layout order = visual bottom stack: dock/menu open *upward* into transcript.
    // Declared before requestApproval / ask_user so closures capture real bindings.
    const choiceDock = new otui.BoxRenderable(r, {
      id: "choice-dock",
      flexShrink: 0,
      flexDirection: "column",
      visible: false,
      backgroundColor: "#0f1b1b",
      borderStyle: "rounded",
      border: true,
      borderColor: "#3a4a4a",
      paddingLeft: 1,
      paddingRight: 1,
      paddingTop: 0,
      paddingBottom: 0,
    });
    main.add(choiceDock);

    // A picker/approval overlay owns the keyboard while it is up, so block-nav
    // keys must stay inert (AC4). `choiceDock.visible` covers every composer-dock
    // menu (`showComposerChoice` toggles it); `overlayDepth` covers the
    // full-screen `/model` and `/connect` pickers, which live on `r.root`.
    let overlayDepth = 0;
    const withOverlay = async <T>(run: () => Promise<T>): Promise<T> => {
      overlayDepth += 1;
      try {
        return await run();
      } finally {
        overlayDepth -= 1;
      }
    };
    const overlayActive = (): boolean =>
      overlayDepth > 0 || choiceDock.visible === true || pendingApproval !== undefined;

    // Live `/` command dropdown (Pi/grok-style): Select filtered as composer changes.
    const menu = new otui.SelectRenderable(r, {
      id: "menu",
      flexShrink: 0,
      height: 10,
      visible: false,
      options: [...AGENT_SLASH_COMMANDS],
      showScrollIndicator: true,
      wrapSelection: true,
      backgroundColor: "#0f1b1b",
      focusedBackgroundColor: "#0f1b1b",
      selectedBackgroundColor: "#22333b",
      textColor: "#c8d0d0",
      focusedTextColor: "#c8d0d0",
      selectedTextColor: "#ffd166",
      descriptionColor: "#6b7a7a",
      selectedDescriptionColor: "#8b9a9a",
    });
    main.add(menu);

    // Bordered composer: multi-line wrap, grows 1→6 rows, then vertical scroll.
    // Enter submits (Shift/Alt+Enter insert newline). Not a single-line Input.
    const composer = new otui.BoxRenderable(r, {
      id: "composer",
      flexShrink: 0,
      borderStyle: "rounded",
      border: true,
      paddingLeft: 1,
      paddingRight: 1,
    });
    const textarea = new otui.TextareaRenderable(r, {
      id: "prompt",
      placeholder: "type a task or / for commands · Enter send · Shift+Enter newline",
      wrapMode: "word",
      minHeight: COMPOSER_MIN_ROWS,
      maxHeight: COMPOSER_MAX_ROWS,
      height: COMPOSER_MIN_ROWS,
      width: "100%",
      // Enter = submit; Shift/Meta+Enter = newline (default Textarea is inverted).
      keyBindings: [
        { name: "return", action: "submit" },
        { name: "linefeed", action: "submit" },
        { name: "kpenter", action: "submit" },
        { name: "return", shift: true, action: "newline" },
        { name: "linefeed", shift: true, action: "newline" },
        { name: "kpenter", shift: true, action: "newline" },
        { name: "return", meta: true, action: "newline" },
        { name: "linefeed", meta: true, action: "newline" },
      ],
    });
    composer.add(textarea);
    main.add(composer);

    /** Adapter so the rest of the shell can keep using `.value` / `.focus()`. */
    const input = {
      get value(): string {
        return textarea.plainText;
      },
      set value(v: string) {
        const next = v ?? "";
        if (textarea.plainText !== next) {
          textarea.setText(next);
          try {
            textarea.cursorOffset = next.length;
          } catch {
            // best-effort
          }
        }
        syncComposerHeight();
      },
      focus(): void {
        textarea.focus();
      },
    };

    const syncComposerHeight = (): void => {
      let lines = 1;
      try {
        // Prefer visual (wrapped) lines so long single-line text grows vertically.
        lines = Math.max(textarea.virtualLineCount || 0, textarea.lineCount || 0, 1);
      } catch {
        lines = Math.max(1, (textarea.plainText.match(/\n/g)?.length ?? 0) + 1);
      }
      const h = composerHeightForLines(lines);
      if (textarea.height !== h) {
        textarea.height = h;
      }
    };
    // Content-change → height + slash menu: wired after `refilter` is defined.
    textarea.focus();
    syncComposerHeight();

    // Approval gate: `shell_exec` (remembered patterns) + `spawn_subagent` (MAE).
    // Default-deny for shell on cancel; read_only subagents auto-approve.
    io.requestApproval = async (tool, inputJson) => {
      // Multi-agent spawn: auto-allow read_only; ask for general.
      if (tool === "spawn_subagent") {
        let mode = "read_only";
        let taskPreview = inputJson;
        try {
          const parsed: unknown = JSON.parse(inputJson);
          if (parsed !== null && typeof parsed === "object") {
            const o = parsed as { mode?: unknown; task?: unknown; label?: unknown };
            if (o.mode === "general" || o.mode === "read_only") {
              mode = o.mode;
            }
            if (typeof o.task === "string") {
              taskPreview = o.task.length > 80 ? `${o.task.slice(0, 77)}…` : o.task;
            }
          }
        } catch {
          // raw
        }
        if (mode === "read_only") {
          transcript.add(
            new otui.TextRenderable(r, {
              id: `ap${uid++}`,
              content: otui.t`${otui.dim(`◇ spawn_subagent (read_only): ${taskPreview}`)}`,
            }),
          );
          return true;
        }
        menu.visible = false;
        setMainAgent("blocked", "approval");
        const id = await showComposerChoice(otui, r, choiceDock, {
          title: "Spawn general subagent?",
          subtitle: taskPreview,
          cancelId: "deny",
          options: [
            {
              id: "allow",
              label: "Allow subagent",
              description: "Run bounded child (still no shell in v1)",
              recommended: true,
            },
            { id: "deny", label: "Deny", description: "Do not spawn" },
          ],
        });
        input.focus();
        setMainAgent("running", id === "allow" ? "subagent" : "denied");
        transcript.add(
          new otui.TextRenderable(r, {
            id: `ap${uid++}`,
            content:
              id === "allow"
                ? otui.t`${otui.green("◇ subagent approved")}`
                : otui.t`${otui.red("◇ subagent denied")}`,
          }),
        );
        return id === "allow";
      }

      const cmd = parseShellExecCommand(inputJson);
      // Auto-allow from session + disk (re-read disk so external edits apply).
      for (const p of loadShellPermissions().allow) {
        sessionShellAllow.add(p);
      }
      if (isShellCommandAllowed(cmd, [...sessionShellAllow])) {
        transcript.add(
          new otui.TextRenderable(r, {
            id: `ap${uid++}`,
            content: otui.t`${otui.dim(`✓ auto-approved shell: ${cmd}`)}`,
          }),
        );
        return true;
      }

      transcript.add(
        new otui.TextRenderable(r, {
          id: `ap${uid++}`,
          content: otui.t`${otui.yellow(`⚙ shell_exec needs approval`)} ${otui.dim("(menu above input)")}`,
        }),
      );
      setMainAgent("blocked", "approval");
      setBusyPhase("waiting for your approval (menu above input)");
      menu.visible = false;
      const choice = await pickShellApproval(otui, r, choiceDock, cmd);
      input.focus();

      if (choice === "deny") {
        transcript.add(
          new otui.TextRenderable(r, {
            id: `av${uid++}`,
            content: otui.t`${otui.red("denied")}`,
          }),
        );
        setMainAgent("running", "denied");
        setBusyPhase("shell denied · continuing");
        return false;
      }

      if (choice === "always-exact" || choice === "always-prefix") {
        const { exact, prefix } = suggestShellPatterns(cmd);
        const pattern = choice === "always-exact" ? exact : prefix;
        allowShellPattern(pattern);
        sessionShellAllow.add(pattern);
        transcript.add(
          new otui.TextRenderable(r, {
            id: `av${uid++}`,
            content: otui.t`${otui.green(`approved · remembered “${pattern}”`)}`,
          }),
        );
        setMainAgent("running", "shell");
        setBusyPhase("running approved shell");
        return true;
      }

      // once
      transcript.add(
        new otui.TextRenderable(r, {
          id: `av${uid++}`,
          content: otui.t`${otui.green("approved (once)")}`,
        }),
      );
      setMainAgent("running", "shell");
      setBusyPhase("running approved shell");
      return true;
    };

    /** Host for ask_user — Claude-style options docked above the composer. */
    const askUserInteractive = async (req: {
      question: string;
      options: Array<{ id: string; label: string; description: string; recommended?: boolean }>;
    }): Promise<string> => {
      menu.visible = false;
      setMainAgent("blocked", "ask");
      setBusyPhase("waiting for your answer (menu above input)");
      // Keep a short transcript breadcrumb; the interactive picker is at the input.
      const qShort = req.question.length > 100 ? `${req.question.slice(0, 97)}…` : req.question;
      transcript.add(
        new otui.TextRenderable(r, {
          id: `ask${uid++}`,
          content: otui.t`${otui.yellow("? ")} ${otui.dim(qShort)}`,
        }),
      );
      const chosen = await showComposerChoice(otui, r, choiceDock, {
        title: req.question.length > 72 ? `${req.question.slice(0, 69)}…` : req.question,
        subtitle: "Pick an option · Esc cancels",
        cancelId: "__cancel__",
        options: req.options.map(
          (o): ChoiceOption => ({
            id: o.id,
            label: o.label,
            description: o.description.length > 0 ? o.description : " ",
            ...(o.recommended === true ? { recommended: true } : {}),
          }),
        ),
      });
      input.focus();
      if (chosen !== "__cancel__") {
        const picked = req.options.find((o) => o.id === chosen);
        transcript.add(
          new otui.TextRenderable(r, {
            id: `aska${uid++}`,
            content: otui.t`${otui.green("→")} ${otui.dim(picked?.label ?? chosen)}`,
          }),
        );
      } else {
        transcript.add(
          new otui.TextRenderable(r, {
            id: `askc${uid++}`,
            content: otui.t`${otui.dim("→ cancelled")}`,
          }),
        );
      }
      setMainAgent("running", "waiting");
      return chosen;
    };
    setAskUserHost(askUserInteractive);

    // Footer: live status (spinner + phase + elapsed) while busy; idle hints.
    const footer = new otui.BoxRenderable(r, {
      id: "footer",
      flexShrink: 0,
      flexDirection: "row",
      justifyContent: "space-between",
      paddingLeft: 1,
      paddingRight: 1,
    });
    const FOOTER_IDLE = "/ commands · Ctrl+O blocks · Ctrl+C to exit";
    const FOOTER_NAV = "blocks · ↑/↓ move · Enter toggle · y copy · Esc exit";
    const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
    const footerLeft = new otui.TextRenderable(r, {
      id: "footer-left",
      content: otui.t`${otui.dim(FOOTER_IDLE)}`,
    });
    footer.add(footerLeft);
    const footerRight = new otui.TextRenderable(r, { id: "footer-right", content: otui.t`${otui.dim(`${sel.provider}/${sel.model}`)}` });
    footer.add(footerRight);
    main.add(footer);

    // In-transcript live status line (updated in place while the agent works).
    let liveStatus: InstanceType<OpenTui["TextRenderable"]> | undefined;
    let busyPhase = "waiting for model";
    let busyStartedAt = 0;
    let spinIdx = 0;
    let busyTimer: ReturnType<typeof setInterval> | undefined;
    // Declared early so paintBusyStatus can read it; toggled in runLine.
    let busy = false;

    const paintBusyStatus = (): void => {
      // Block-nav mode owns the footer hint even mid-turn: the spinner interval
      // would otherwise repaint over it every 120ms.
      if (navMode()) {
        footerLeft.content = otui.t`${otui.yellow(FOOTER_NAV)}`;
        return;
      }
      if (!busy) {
        footerLeft.content = otui.t`${otui.dim(FOOTER_IDLE)}`;
        return;
      }
      const frame = SPINNER[spinIdx % SPINNER.length] ?? "⠋";
      const secs = ((Date.now() - busyStartedAt) / 1000).toFixed(1);
      const line = `${frame} ${busyPhase} · ${secs}s`;
      footerLeft.content = otui.t`${otui.yellow(line)}`;
      if (liveStatus !== undefined) {
        liveStatus.content = otui.t`${otui.dim(line)}`;
      }
    };

    // Wire the outer setBusyPhase used by AgentIO hooks (defined earlier as a no-op).
    setBusyPhase = (phase: string): void => {
      busyPhase = phase;
      paintBusyStatus();
    };

    const startBusy = (phase = "waiting for model"): void => {
      busy = true;
      busyPhase = phase;
      busyStartedAt = Date.now();
      spinIdx = 0;
      liveStatus = new otui.TextRenderable(r, {
        id: `ls${uid++}`,
        content: otui.t`${otui.dim(`⠋ ${phase} · 0.0s`)}`,
        marginTop: 1,
      });
      transcript.add(liveStatus);
      if (busyTimer !== undefined) {
        clearInterval(busyTimer);
      }
      busyTimer = setInterval(() => {
        spinIdx += 1;
        paintBusyStatus();
      }, 120);
      paintBusyStatus();
    };

    const stopBusy = (): void => {
      busy = false;
      if (busyTimer !== undefined) {
        clearInterval(busyTimer);
        busyTimer = undefined;
      }
      // Remove the in-transcript spinner line; "worked for Ns" replaces it.
      if (liveStatus !== undefined) {
        try {
          transcript.remove(liveStatus);
        } catch {
          // best-effort
        }
        liveStatus = undefined;
      }
      paintBusyStatus(); // idle hint, or the nav hint when nav mode is active
    };
    clearBusyTimer = () => {
      if (busyTimer !== undefined) {
        clearInterval(busyTimer);
        busyTimer = undefined;
      }
    };

    // `menuNav` = the `/` dropdown (not the Input) currently owns the keyboard.
    // The dropdown is FOCUSED as soon as it opens, so ↑/↓/Enter work immediately;
    // printable keys / Backspace are re-routed to the composer value (below) so
    // typing still filters live.
    let menuNav = false;
    const refilter = (): void => {
      const matches = filterCommands(input.value);
      if (matches.length > 0 && input.value.startsWith("/")) {
        menu.options = matches;
        menu.visible = true;
        if (!menuNav) {
          menu.focus();
          menuNav = true;
        }
      } else {
        menu.visible = false;
        if (menuNav) {
          menuNav = false;
          input.focus();
        }
      }
    };
    textarea.onContentChange = () => {
      syncComposerHeight();
      refilter();
    };

    const helpText = (): string =>
      ["Commands:", ...AGENT_SLASH_COMMANDS.map((c) => `  ${c.name}  ${c.description}`)].join("\n") + "\n";

    // --- Per-project session (isolated by git root / cwd) --------------------
    const sessionCwd = opts.session?.cwd ?? process.cwd();
    // Definite assignment: every control-flow path calls `applyOpened` before
    // paint/save; `!` satisfies TS2454 (assignments inside nested closures are
    // invisible to control-flow analysis).
    let liveSession!: SessionHandle;
    let history: NormalizedMessage[] = [];
    let archive: NormalizedMessage[] = [];

    const applyOpened = (opened: {
      handle: SessionHandle;
      history: NormalizedMessage[];
      archive: NormalizedMessage[];
      resumed: boolean;
    }): void => {
      liveSession = opened.handle;
      history = opened.history;
      archive = opened.archive.length > 0 ? [...opened.archive] : [...opened.history];
    };

    try {
      if (opts.session?.pickOnStart === true && opts.session.resumeId === undefined) {
        const rows = listSessions(sessionCwd).slice(0, 12);
        if (rows.length === 0) {
          applyOpened(
            openSession({
              cwd: sessionCwd,
              provider: currentSel.provider,
              model: currentSel.model,
            }),
          );
        } else {
          menu.visible = false;
          const pickId = await showComposerChoice(otui, r, choiceDock, {
            title: "Resume session (this project)",
            subtitle: "Esc = new session",
            cancelId: "__new__",
            options: [
              {
                id: "__new__",
                label: "New session",
                description: "Start fresh (old sessions stay on disk)",
                recommended: true,
              },
              ...rows.map((s) => ({
                id: s.id,
                label: s.title.length > 40 ? `${s.title.slice(0, 37)}…` : s.title,
                description: `${shortSessionId(s.id)} · ctx ${s.messageCount} · ${s.updatedAt.slice(0, 16).replace("T", " ")}`,
              })),
            ],
          });
          input.focus();
          if (pickId === "__new__") {
            applyOpened(
              openSession({
                cwd: sessionCwd,
                provider: currentSel.provider,
                model: currentSel.model,
              }),
            );
          } else {
            applyOpened(
              openSession({
                cwd: sessionCwd,
                resumeId: pickId,
                provider: currentSel.provider,
                model: currentSel.model,
              }),
            );
          }
        }
      } else {
        const opened = openSession({
          cwd: sessionCwd,
          ...(opts.session?.continueLast === true ? { continueLast: true } : {}),
          ...(opts.session?.resumeId !== undefined ? { resumeId: opts.session.resumeId } : {}),
          provider: currentSel.provider,
          model: currentSel.model,
        });
        applyOpened(opened);
        if (opened.resumed) {
          transcript.add(
            new otui.TextRenderable(r, {
              id: `sess${uid++}`,
              content: otui.t`${otui.dim(
                `session ${shortSessionId(liveSession.summary.id)} · ${liveSession.summary.title} · ctx ${history.length} · archive ${archive.length}`,
              )}`,
              marginTop: 1,
            }),
          );
          for (const m of history.filter((x) => x.role === "user").slice(-5)) {
            const t = m.content.length > 100 ? `${m.content.slice(0, 97)}…` : m.content;
            transcript.add(
              new otui.TextRenderable(r, {
                id: `sessu${uid++}`,
                content: otui.t`${otui.dim(`  ❯ ${t}`)}`,
              }),
            );
          }
        }
      }
    } catch (cause) {
      transcript.add(
        new otui.TextRenderable(r, {
          id: `sesserr${uid++}`,
          content: otui.t`${otui.red(cause instanceof Error ? cause.message : String(cause))}`,
          marginTop: 1,
        }),
      );
      applyOpened(
        openSession({
          cwd: sessionCwd,
          provider: currentSel.provider,
          model: currentSel.model,
        }),
      );
    }

    const paintSessionHeader = (): void => {
      const label = `${currentSel.provider}/${currentSel.model}`;
      const sid = shortSessionId(liveSession.summary.id);
      const title =
        liveSession.summary.title.length > 24
          ? `${liveSession.summary.title.slice(0, 21)}…`
          : liveSession.summary.title;
      const cx = liveSession.summary.compactCount > 0 ? ` · c×${liveSession.summary.compactCount}` : "";
      headerLeft.content = otui.t`${otui.dim(`keryx · ${title} · ${sid}${cx} · ${label}`)}`;
    };

    const saveSession = (): void => {
      liveSession = persistHistory(liveSession, history, {
        archive,
        provider: currentSel.provider,
        model: currentSel.model,
      });
      paintSessionHeader();
    };

    const startNewSession = (note?: string): void => {
      liveSession = createSession({
        cwd: sessionCwd,
        provider: currentSel.provider,
        model: currentSel.model,
      });
      history = [];
      archive = [];
      paintSessionHeader();
      if (note !== undefined && note.length > 0) {
        io.onSystem?.(`${note}\n`);
      }
    };

    const resumeSessionInteractive = async (): Promise<void> => {
      const rows = listSessions(sessionCwd).slice(0, 12);
      if (rows.length === 0) {
        io.onSystem?.("No saved sessions in this project.\n");
        input.focus();
        return;
      }
      menu.visible = false;
      const pickId = await showComposerChoice(otui, r, choiceDock, {
        title: "Resume session (this project only)",
        subtitle: "Esc cancels",
        cancelId: "__cancel__",
        options: rows.map((s, i) => ({
          id: s.id,
          label: s.title.length > 40 ? `${s.title.slice(0, 37)}…` : s.title,
          description: `${shortSessionId(s.id)} · ctx ${s.messageCount} · arch ${s.archiveMessageCount} · ${s.updatedAt.slice(0, 16).replace("T", " ")}`,
          ...(i === 0 ? { recommended: true } : {}),
        })),
      });
      input.focus();
      if (pickId === "__cancel__") {
        return;
      }
      const found = findSession(sessionCwd, pickId);
      if (found === undefined) {
        io.onSystem?.("Session not found in this project.\n");
        return;
      }
      applyOpened(
        openSession({
          cwd: sessionCwd,
          resumeId: found.id,
          provider: currentSel.provider,
          model: currentSel.model,
        }),
      );
      paintSessionHeader();
      io.onSystem?.(
        `Resumed ${shortSessionId(liveSession.summary.id)} · ${liveSession.summary.title} (ctx ${history.length} · archive ${archive.length})\n`,
      );
    };

    paintSessionHeader();

    // `/model` and `/connect` rebuild `deps` mid-session and refresh the labels.
    const updateModelLabels = (): void => {
      paintSessionHeader();
      const label = `${currentSel.provider}/${currentSel.model}`;
      sbModelV.content = otui.t`${otui.dim(label)}`;
      footerRight.content = otui.t`${otui.dim(label)}`;
    };
    const switchTo = async (ns: TuiSelection): Promise<void> => {
      currentSel = ns;
      deps = await opts.makeAgentDeps(ns);
      saveShellConfig(
        ns.baseUrl === undefined ? { provider: ns.provider, model: ns.model } : { provider: ns.provider, model: ns.model, baseUrl: ns.baseUrl },
      );
      updateModelLabels();
      input.focus();
      showToast(`Switched to ${ns.provider}/${ns.model}`);
    };

    // Side workers while main is busy (automatic — no special slash command).
    let sideSeq = 0;
    let activeSides = 0;
    const MAX_SIDE_WORKERS = 3;

    const spawnSideWorker = (question: string): void => {
      if (activeSides >= MAX_SIDE_WORKERS) {
        transcript.add(
          new otui.TextRenderable(r, {
            id: `side-max${uid++}`,
            content: otui.t`${otui.yellow(
              `◇ side worker limit (${MAX_SIDE_WORKERS}) — wait for one to finish`,
            )}`,
            marginTop: 1,
          }),
        );
        return;
      }
      sideSeq += 1;
      activeSides += 1;
      const seq = sideSeq;
      const workerId = `${SIDE_WORKER_ID_PREFIX}${seq}`;
      const label = sideWorkerLabel(seq);
      const mainSlot = fleet.list().find((w) => w.id === MAIN_AGENT_ID);
      const elapsedSec = busyStartedAt > 0 ? (Date.now() - busyStartedAt) / 1000 : undefined;

      fleet.upsert({
        id: workerId,
        label,
        status: "running",
        detail: "side Q",
        model: `${currentSel.provider}/${currentSel.model}`,
      });

      transcript.add(
        new otui.TextRenderable(r, {
          id: `side-h${uid++}`,
          content: otui.t`${otui.magenta(`◇ ${label}`)} ${otui.dim(`· while main: ${busyPhase}`)}`,
          marginTop: 1,
        }),
      );
      const qBox = new otui.BoxRenderable(r, {
        id: `side-q${uid++}`,
        borderStyle: "rounded",
        border: true,
        borderColor: "#5a3a6a",
        paddingLeft: 1,
        paddingRight: 1,
        marginTop: 0,
        alignSelf: "flex-start",
      });
      qBox.add(
        new otui.TextRenderable(r, {
          id: `side-qt${uid++}`,
          content: otui.t`${otui.dim(`❯ ${question}`)}`,
        }),
      );
      transcript.add(qBox);

      const prompt = buildSideWorkerPrompt({
        question,
        snapshot: {
          phase: busyPhase,
          ...(mainSlot?.detail !== undefined ? { mainDetail: mainSlot.detail } : {}),
          ...(elapsedSec !== undefined ? { elapsedSec } : {}),
        },
        recentHistory: history,
      });

      void (async () => {
        let answer = "";
        try {
          const base = await opts.makeAgentDeps(currentSel);
          // Read-only: never allow shell/mutations from a side worker.
          const tools = base.tools.filter((t) => t.definition.risk === "read");
          const sideDeps: AgentDeps = {
            ...base,
            tools,
            systemInstruction: buildSideWorkerSystemInstruction(currentSel.provider, currentSel.model),
            maxToolCalls: 4,
            idSeq: () => `${workerId}-${base.idSeq()}`,
          };
          const sideHistory: NormalizedMessage[] = [];
          const sideIo: AgentIO = {
            write: (s) => {
              answer += s;
            },
            onAssistantText: (text) => {
              answer = text;
            },
            onToolCall: (name) => {
              fleet.upsert({
                id: workerId,
                label,
                status: "running",
                detail: name.length > 12 ? `${name.slice(0, 10)}…` : name,
              });
            },
            onToolResult: () => {
              fleet.upsert({ id: workerId, label, status: "running", detail: "waiting" });
            },
            onSystem: (text) => {
              transcript.add(
                new otui.TextRenderable(r, {
                  id: `side-sys${uid++}`,
                  content: otui.t`${otui.dim(text.trimEnd())}`,
                }),
              );
            },
            // Side workers never get shell approval — tools are read-only only.
            requestApproval: async () => false,
          };
          await runAgentTurn(sideIo, sideDeps, sideHistory, prompt);
          const body = answer.trim().length > 0 ? answer.trim() : "(no reply)";
          transcript.add(
            new otui.TextRenderable(r, {
              id: `side-a${uid++}`,
              content: otui.t`${otui.magenta("◇")} ${body}`,
              marginTop: 0,
            }),
          );
          fleet.upsert({ id: workerId, label, status: "done", detail: "answered" });
        } catch (cause) {
          const msg = cause instanceof Error ? cause.message : String(cause);
          transcript.add(
            new otui.TextRenderable(r, {
              id: `side-err${uid++}`,
              content: otui.t`${otui.red(`◇ ${label} failed: ${msg}`)}`,
            }),
          );
          fleet.upsert({ id: workerId, label, status: "failed", detail: "error" });
        } finally {
          activeSides = Math.max(0, activeSides - 1);
          // Auto-drop finished side slots after a short moment so the panel stays clean.
          setTimeout(() => {
            try {
              fleet.remove(workerId);
            } catch {
              // ignore
            }
          }, 12_000);
        }
      })();
    };

    // Run a submitted line: a slash command, an unknown-slash notice, a main turn,
    // or (when main is busy) an automatic side worker — no special command needed.
    const runLine = (line: string): void => {
      if (line.length === 0) {
        return;
      }

      // While main is in progress: control slash still works; anything else → side worker.
      if (busy) {
        const command = findAgentCommand(line);
        if (command?.name === "/exit") {
          r.destroy();
          return;
        }
        if (command?.name === "/help") {
          transcript.add(
            new otui.TextRenderable(r, {
              id: `c${uid++}`,
              content: otui.t`${otui.cyan(`❯ ${line}`)}`,
              marginTop: 1,
            }),
          );
          io.onSystem?.(
            "Main agent is busy. Type a normal question to spawn a side worker " +
              "(sees main status + recent context; read-only). /exit still works.\n",
          );
          return;
        }
        // /new /resume /compact /model while busy: refuse (avoid racing main session).
        if (command !== undefined || line.startsWith("/")) {
          transcript.add(
            new otui.TextRenderable(r, {
              id: `c${uid++}`,
              content: otui.t`${otui.yellow(
                `◇ main is busy — command deferred. Ask a normal question for a side worker, or wait.`,
              )}`,
              marginTop: 1,
            }),
          );
          return;
        }
        spawnSideWorker(line);
        return;
      }

      // Echo a slash command so it is clear WHICH command ran (turns echo their
      // own `❯ …` user box below).
      if (line.startsWith("/")) {
        transcript.add(
          new otui.TextRenderable(r, {
            id: `c${uid++}`,
            content: otui.t`${otui.cyan(`❯ ${line}`)}`,
            marginTop: 1,
          }),
        );
      }
      const command = findAgentCommand(line);
      if (command !== undefined) {
        if (command.name === "/exit") {
          r.destroy();
          return;
        }
        if (command.name === "/clear" || command.name === "/new") {
          // Creates a NEW session id; previous transcript stays on disk for /resume.
          startNewSession();
          io.onSystem?.(
            `New session ${shortSessionId(liveSession.summary.id)} (previous kept on disk · /resume)\n`,
          );
          return;
        }
        if (command.name === "/resume") {
          void resumeSessionInteractive();
          return;
        }
        if (command.name === "/compact") {
          const focus = line.trim().split(/\s+/).slice(1).join(" ").trim();
          const packed = compactSession(liveSession, history, archive, {
            keepLastUserTurns: 3,
            ...(focus.length > 0 ? { focus } : {}),
            provider: currentSel.provider,
            model: currentSel.model,
          });
          liveSession = packed.handle;
          history = packed.context;
          paintSessionHeader();
          if (packed.result.noop) {
            io.onSystem?.("Nothing to compact (context already small).\n");
          } else {
            io.onSystem?.(
              `Compacted −${packed.result.removed} context msgs · archive ${liveSession.summary.archiveMessageCount} · compact×${liveSession.summary.compactCount}\n`,
            );
          }
          return;
        }
        // `/think` and `/expand` now expand the newest matching block IN PLACE
        // (flow 109) instead of appending a second copy of the text as a system
        // line; `/copy` puts a block's retained payload on the clipboard (AC6).
        if (command.name === "/think") {
          const thought = newestBlock("thought");
          if (thought === undefined) {
            io.onSystem?.("No reasoning yet.\n");
            return;
          }
          setBlockCollapsed(thought.id, false);
          return;
        }
        if (command.name === "/expand") {
          const target = newestBlock("output") ?? newestBlock();
          if (target === undefined) {
            io.onSystem?.("Nothing to expand — no tool output yet.\n");
            return;
          }
          setBlockCollapsed(target.id, false);
          return;
        }
        if (command.name === "/copy") {
          // Always the newest block: a slash command can only be submitted from
          // the composer, and in nav mode the composer is blurred — so there is
          // no reachable "focused block wins" case to honor here (`y` covers it).
          const target = newestBlock();
          if (target === undefined || !copyBlock(target.id)) {
            io.onSystem?.("Nothing to copy yet.\n");
          }
          return;
        }
        if (command.name === "/model") {
          void (async () => {
            const detected = opts.redetect !== undefined ? await opts.redetect() : opts.detected;
            const prov = detected.find((d) => d.name === currentSel.provider);
            // Registered providers fetch their live, filterable list; others use detected.
            const models = prov !== undefined ? await modelsForPicker(prov) : [];
            const chosen = await withOverlay(() => pickModelInTui(otui, r, models));
            if (chosen !== undefined) {
              await switchTo(
                currentSel.baseUrl === undefined
                  ? { provider: currentSel.provider, model: chosen }
                  : { provider: currentSel.provider, model: chosen, baseUrl: currentSel.baseUrl },
              );
            } else {
              input.focus();
            }
          })();
          return;
        }
        if (command.name === "/connect") {
          void (async () => {
            const detected = opts.redetect !== undefined ? await opts.redetect() : opts.detected;
            const ns = await withOverlay(() => selectProviderModelInTui(otui, r, detected));
            if (ns !== undefined) {
              await switchTo(ns);
            } else {
              input.focus();
            }
          })();
          return;
        }
        io.onSystem?.(helpText()); // /help
        return;
      }
      if (line.startsWith("/")) {
        io.onSystem?.(`Unknown command: ${line}\n`);
        io.onSystem?.(helpText());
        return;
      }
      const userBox = new otui.BoxRenderable(r, {
        id: `ub${uid++}`,
        borderStyle: "rounded",
        border: true,
        borderColor: "#3a4a4a", // muted (was bright cyan)
        paddingLeft: 1,
        paddingRight: 1,
        marginTop: 1,
        alignSelf: "flex-start",
      });
      userBox.add(new otui.TextRenderable(r, { id: `u${uid++}`, content: otui.t`${otui.dim(`❯ ${line}`)}` }));
      transcript.add(userBox);
      transcript.add(
        new otui.TextRenderable(r, {
          id: `h${uid++}`,
          content: otui.t`${otui.cyan("●")} ${otui.bold("keryx")}  ${otui.dim(hhmm())}`,
          marginTop: 1,
        }),
      );

      // Hard pre-router: "обогати вики" → list pages + interactive plan, then run
      // wikiEnrich in-process (no model thrash on search_code).
      if (isWikiEnrichIntent(line)) {
        const startedAt = Date.now();
        busy = true;
        void (async () => {
          try {
            startBusy("planning wiki enrich…");
            const plan = await planWikiEnrich(process.cwd());
            stopBusy();

            const maxList = 40;
            const draftLines = plan.drafts.slice(0, maxList).map((p) => `  · ${p.relativePath}`);
            const moreDrafts =
              plan.drafts.length > maxList ? `  · … +${plan.drafts.length - maxList} more drafts` : "";
            transcript.add(
              new otui.TextRenderable(r, {
                id: `we-list${uid++}`,
                content: otui.t`${otui.dim(
                  [
                    `Wiki enrich plan: ${plan.drafts.length} draft · ${plan.accepted.length} accepted · ${plan.forceTargets.length} total`,
                    ...(plan.drafts.length > 0 ? ["Drafts:", ...draftLines, ...(moreDrafts ? [moreDrafts] : [])] : ["Drafts: (none)"]),
                    plan.accepted.length > 0
                      ? `Accepted (need --force): ${plan.accepted.length} page(s)`
                      : "Accepted: (none)",
                  ].join("\n"),
                )}`,
                marginTop: 1,
              }),
            );

            if (plan.forceTargets.length === 0) {
              transcript.add(
                new otui.TextRenderable(r, {
                  id: `we-empty${uid++}`,
                  content: otui.t`${otui.yellow("No wiki pages found. Run `keryx wiki collect` first.")}`,
                }),
              );
              return;
            }

            const choice = await pickWikiEnrichMode(otui, r, choiceDock, {
              draftCount: plan.drafts.length,
              acceptedCount: plan.accepted.length,
              total: plan.forceTargets.length,
            });
            input.focus();

            if (choice === "cancel") {
              transcript.add(
                new otui.TextRenderable(r, {
                  id: `we-cancel${uid++}`,
                  content: otui.t`${otui.dim("Wiki enrich cancelled.")}`,
                }),
              );
              return;
            }

            if (choice === "drafts" && plan.drafts.length === 0) {
              transcript.add(
                new otui.TextRenderable(r, {
                  id: `we-nodraft${uid++}`,
                  content: otui.t`${otui.yellow("No draft pages. Choose force enrich all, or collect new drafts.")}`,
                }),
              );
              return;
            }

            const force = choice === "force";
            const targets = force ? plan.forceTargets : plan.drafts;
            // Keep side workers; drop previous enrich page slots only.
            fleet.clearMatching((w) => w.id !== MAIN_AGENT_ID && !isSideWorkerId(w.id));
            setMainAgent("running", force ? "force-all" : "drafts");
            for (const p of targets) {
              fleet.upsert({
                id: p.relativePath,
                label: shortWorkerLabel(p.relativePath),
                status: "queued",
                detail: "queued",
                model: `${currentSel.provider}/${currentSel.model}`,
              });
            }
            paintFleet();

            startBusy(`wiki enrich ${force ? "(force all)" : "(drafts)"}…`);
            const result = await wikiEnrich({
              cwd: process.cwd(),
              all: true,
              force,
              provider: currentSel.provider,
              model: currentSel.model,
              concurrency: 2, // small parallel swarm; raise via CLI for larger batches
              onPage: (info) => {
                setBusyPhase(`enrich ${info.index}/${info.total} [${info.phase}] ${info.path}`);
                setMainAgent("running", `${info.index}/${info.total}`);
                const status =
                  info.phase === "done" ? "done" : info.phase === "failed" ? "failed" : "running";
                fleet.upsert({
                  id: info.path,
                  label: shortWorkerLabel(info.path),
                  status,
                  detail: info.phase,
                  model: `${currentSel.provider}/${currentSel.model}`,
                });
              },
            });
            stopBusy();
            setMainAgent(
              result.failed > 0 && result.enriched === 0 ? "failed" : "done",
              `${result.enriched}ok/${result.failed}fail`,
            );
            // Leave final fleet state visible; clear on next enrich run.

            const lines = [
              `provider: ${result.provider} (${result.model})`,
              `credential: ${result.credentialAvailable ? "yes" : "no"}`,
              `mode: ${force ? "force (all statuses)" : "drafts only"}`,
              `enriched: ${result.enriched}  skipped: ${result.skipped}  failed: ${result.failed}`,
            ];
            for (const entry of result.pages.slice(0, 30)) {
              lines.push(`- ${entry.action}: ${entry.path}${entry.reason ? ` — ${entry.reason}` : ""}`);
            }
            if (result.pages.length > 30) {
              lines.push(`- … +${result.pages.length - 30} more`);
            }
            transcript.add(
              new otui.TextRenderable(r, {
                id: `we-res${uid++}`,
                content: otui.t`${otui.dim(lines.join("\n"))}`,
                marginTop: 1,
              }),
            );
            history.push({ role: "user", content: line, provenance: "project" });
            history.push({
              role: "assistant",
              content: lines.join("\n"),
              provenance: "model",
            });
            try {
              saveSession();
            } catch {
              // best-effort
            }
          } catch (cause) {
            stopBusy();
            transcript.add(
              new otui.TextRenderable(r, {
                id: `we-err${uid++}`,
                content: otui.t`${otui.red(`wiki enrich failed: ${cause instanceof Error ? cause.message : String(cause)}`)}`,
              }),
            );
          } finally {
            const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
            transcript.add(
              new otui.TextRenderable(r, {
                id: `w${uid++}`,
                content: otui.t`${otui.dim(`worked for ${secs}s`)}`,
                marginTop: 1,
              }),
            );
            busy = false;
            focusComposer(); // never steal focus from an active block-nav mode (R3)
          }
        })();
        return;
      }

      // Clear enrich/page workers only — keep concurrent side workers visible.
      fleet.clearMatching((w) => w.id !== MAIN_AGENT_ID && !isSideWorkerId(w.id));
      setMainAgent("running", "waiting");
      startBusy("waiting for model");
      const startedAt = Date.now();
      let turnFailed = false;
      const prevOnSystem = io.onSystem;
      io.onSystem = (text) => {
        if (/\[error\]|\[budget\]|\[stopped\]/i.test(text)) {
          turnFailed = true;
        }
        prevOnSystem?.(text);
      };
      const beforeLen = history.length;
      void runAgentTurn(io, deps, history, line).finally(() => {
        const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
        stopBusy();
        setMainAgent(turnFailed ? "failed" : "done", turnFailed ? "error" : "idle");
        for (let i = beforeLen; i < history.length; i++) {
          const m = history[i];
          if (m !== undefined) {
            archive.push(m);
          }
        }
        try {
          saveSession();
        } catch {
          // best-effort persist
        }
        transcript.add(
          new otui.TextRenderable(r, { id: `w${uid++}`, content: otui.t`${otui.dim(`worked for ${secs}s`)}`, marginTop: 1 }),
        );
        // No exact provider usage → show an estimated context size (never stuck at 0).
        if (!hasExactUsage) {
          const est = estimateContextTokens(history);
          tokenText.content = otui.t`${otui.dim(`~${fmtTokens(est)}`)}`;
          sbContext.content = otui.t`${otui.dim(`~${est.toLocaleString()} tokens (est)`)}`;
        }
        focusComposer(); // never steal focus from an active block-nav mode (R3)
      });
    };

    // Route ↑/↓/Enter/Esc to the `/` command dropdown when it is open — via the
    // GLOBAL internal key handler, which runs BEFORE the focused Input, so a
    // handled key does not also move the Input's cursor / submit a turn.
    // Selecting a command from the dropdown (Enter on the focused menu) runs it
    // and returns focus to the composer.
    menu.on(otui.SelectRenderableEvents.ITEM_SELECTED, () => {
      const opt = menu.getSelectedOption();
      menuNav = false;
      menu.visible = false;
      input.value = "";
      input.focus();
      if (opt !== null) {
        runLine(opt.name);
      }
    });
    // The dropdown is FOCUSED from the moment it opens (`refilter`), so the native
    // SelectRenderable handles ↑/↓/Enter immediately. Here we only re-route
    // printable keys / Backspace back into the composer value so typing still
    // filters live, and Esc to close. Runs before the focused menu via onInternal.
    r._internalKeyInput.onInternal("keypress", (key) => {
      if (!menu.visible || !menuNav) {
        return;
      }
      if (key.name === "escape") {
        menu.visible = false;
        menuNav = false;
        input.value = "";
        input.focus();
        key.preventDefault();
        key.stopPropagation();
        return;
      }
      if (key.name === "backspace") {
        input.value = input.value.slice(0, -1);
        refilter();
        key.preventDefault();
        key.stopPropagation();
        return;
      }
      // A printable single character (no modifiers) → append to the filter query.
      const ch = key.sequence;
      if (!key.ctrl && !key.meta && typeof ch === "string" && ch.length === 1 && ch >= " ") {
        input.value += ch;
        refilter();
        key.preventDefault();
        key.stopPropagation();
      }
      // ↑/↓/Enter fall through → the focused SelectRenderable handles them.
    });

    // --- block navigation mode (Ctrl+O … Esc) — flow 109 D-3 ----------------
    // The mode itself is `createBlockNavController` (transcript-blocks.ts); all
    // that is left here is subscribing it. Registered through the `onKeypress`
    // wrapper rather than by reaching for the private `_internalKeyInput` symbol
    // directly (risk R2); the `/`-menu router above is the pre-existing direct
    // consumer.
    onKeypress(r, (key) => {
      nav.handleKey(key);
    });

    const submitComposer = (): void => {
      // Legacy y/N fallback if an approval is still pending on the composer
      // (interactive picker is the primary path and resolves itself).
      if (pendingApproval !== undefined) {
        const ok = isShellApproved(input.value);
        input.value = "";
        menu.visible = false;
        const resolve = pendingApproval;
        pendingApproval = undefined;
        transcript.add(
          new otui.TextRenderable(r, {
            id: `av${uid++}`,
            content: ok ? otui.t`${otui.green("approved")}` : otui.t`${otui.red("denied")}`,
          }),
        );
        resolve(ok);
        return;
      }
      const line = input.value.trim();
      input.value = "";
      menu.visible = false;
      syncComposerHeight();
      runLine(line);
    };
    textarea.onSubmit = () => {
      submitComposer();
    };

    await done;
    return true;
  } catch {
    return false;
  } finally {
    try {
      renderer?.destroy();
    } catch {
      // best-effort teardown
    }
  }
}
