// OpenTUI interactive agent shell (flows 060 skeleton + 061 chrome parity).
//
// A new IO implementation of the existing `AgentIO` hook surface (src/commands/
// agent.ts): it renders into an OpenTUI transcript and drives `runAgentTurn` from
// a `split-footer` composer (a fixed footer input over a scrolling main region —
// the Pi/grok layout). Chrome parity with the readline shell: assistant text →
// one sibling renderable per markdown segment, styled by the worker-free
// `markdownToChunks` (the native `MarkdownRenderable` is deliberately NOT used —
// flow 109 decision D-2); `● keryx` role header; `⚙ tool(args)` (via the pure
// `summarizeToolArgs`); collapsed tool output (`collapseToolOutput`); reasoning
// as a bounded `▸ thought (n lines)` block. The deterministic driver and the
// pure helpers are unchanged. Gutter = the transcript box `padding`.
//
// Usage is rendered TWICE, on purpose, because the two readings answer different
// questions. `createTuiAgentIo.onUsage` appends the per-turn `↑in ↓out tokens`
// transcript line flow 050 shipped — what THIS turn cost, the point of a metered
// provider — and `attachUsageIo` WRAPS that hook (it does not replace it) to add
// the cumulative header + sidebar counter, which tracks the context budget across
// the session. `launchTuiAgentShell` used to ASSIGN `io.onUsage`, which deleted
// the per-turn line from the running shell while leaving its code in place and
// apparently working; that was gap G-1 in the feature-parity checklist, now
// closed. Assigning the hook again would silently reopen it.
//
// The working directory the agent acts on is the sidebar `Directory` panel
// (`mountCwdPanel`), shortened to the sidebar's fixed 26-column text budget by
// the pure `shortenCwd`. It was absent from the TUI entirely — gap G-2, also
// closed: an agent holding `shell_exec` acts on a directory, and the operator
// approving that command has to be able to see which one.
//
// Since flow 112 the LAYOUT itself is not built here: `launchTuiAgentShell`
// mounts `createShellChrome` (./shell-chrome) and keeps only what knows what a
// tool is — approval, ask_user, the worker fleet, side workers, the wiki-enrich
// pre-router, the block registry/nav and the `runAgentTurn` call site. The chat
// driver mounts the same chrome, so the two surfaces cannot drift apart.
//
// `@opentui/core` is an OPTIONAL dependency (ADR-0005) loaded ONLY via a dynamic
// `import()` — never a top-level import (keryx's zero-`dependencies` floor + lazy
// optional-import guard, src/capability/no-optional-imports). `launchTuiAgentShell`
// is defensive: it returns `false` (caller falls back to the readline shell)
// whenever there is no TTY, the package is absent, or the renderer fails to init.
import type { AgentDeps, AgentIO } from "../commands/agent";
import { runAgentTurn } from "../commands/agent";
import { buildApprovalContext } from "../commands/agent-approval-context";
import {
  closeSlateSession,
  mintTimestampAttemptId,
  recordSlateTouch,
  type SlateSessionRef,
} from "../session/slate-lifecycle";
import { renderAnchorsBlock } from "../session/slate";
import { runGoalCommand } from "../commands/goal-command";
import { spawnSync } from "node:child_process";
import { createMetaprojectAdapter } from "../harness/tool/metaproject-adapter";
import type { MetaprojectPort } from "../harness/tool/metaproject-port";
import type { NormalizedMessage, NormalizedUsage } from "../harness/provider/types";
import packageJson from "../../package.json" with { type: "json" };
import { isFlowsCommand, openFlows } from "./flow-inspector";
import { loadInspectorFlows, loadInspectorWorkspaces } from "./inspector-sources";
import {
  buildSessionInfoSnapshot,
  isSessionInfoCommand,
  openSessionInfo,
} from "./session-info";
import { createDefaultSearchProviderController } from "../harness/search";
import type { SearchProviderDescriptor, SearchProviderId } from "../harness/search";
import {
  commandsForMode,
  describeUnavailableCommand,
  filterCommands,
  findAgentCommand,
  renderCommandHelp,
} from "../commands/agent-commands";
import {
  applyThemeId,
  formatThemeList,
  getTheme,
  getThemeId,
  loadPersistedThemeId,
  parseThemeId,
  persistThemeId,
  themeLabel,
} from "./theme";
import { openThemePicker } from "./theme-picker";
import type { DetectedProvider } from "../commands/select";
import {
  MODELS_FETCH_TIMEOUT_MS,
  fetchOpenAiCompatModelsDetailed,
  providerByName,
  resolveModelsForPicker,
} from "../commands/providers";
import { collapseToolOutput, summarizeToolArgs } from "../lib/ui";
import { collapseHome } from "../lib/statusbar";
import { saveApiKey, saveProviderBaseUrl, saveShellConfig } from "../lib/shell-config";
import {
  allowShellPattern,
  parseShellExecCommand,
  shellPermissionsFingerprint,
  shellPermissionsPath,
  loadShellPermissions,
  suggestShellPatterns,
} from "../lib/shell-permissions";
import { evaluateShellApproval } from "../commands/shell-approval";
import { getProjectPermissionMode, setProjectPermissionMode } from "../lib/permission-mode-config";
import {
  DEFAULT_PERMISSION_MODE,
  isPermissionMode,
  PERMISSION_MODES,
  type PermissionMode,
} from "../commands/permission-mode";
import { isWikiEnrichIntent, planWikiEnrich, wikiEnrich } from "../wiki/enrich";
import {
  compactSession,
  createSession,
  findSession,
  type SessionSummary,
  listSessions,
  openSession,
  persistHistory,
  shortSessionId,
  type SessionHandle,
} from "../session";
import { setAskUserHost } from "./ask-user-bridge";
import { createHerdrReporter, herdrStateFor } from "./herdr-report";
import { showComposerChoice, type ChoiceOption } from "./composer-choice";
import { createShellChrome, createShellRenderer, SIDEBAR_TEXT_WIDTH, type ShellChrome } from "./shell-chrome";
import {
  buildSideWorkerPrompt,
  buildSideWorkerSystemInstruction,
  isSideWorkerId,
  SIDE_WORKER_ID_PREFIX,
  sideWorkerLabel,
} from "./side-worker";
import type { QueuedMainQuestion } from "./main-queue";
import {
  formatMainQueueMarker,
  parseQueueCommand,
  removeMainQueueItem,
  editMainQueueItem,
  reinsertMainQueueItem,
} from "./main-queue";

import { killAllBackgroundJobs } from "../harness/tool/builtin/background-job-tool";
import { setJobFleetListener } from "./job-bridge";
import { setSubagentFleetListener } from "./subagent-bridge";
import { openSubagentInspector, paintSubagentSidebar } from "./subagent-inspector";
import { SubagentSessionStore } from "./subagent-session";
import { formatFleetSidebar, MAIN_AGENT_ID, shortWorkerLabel, WorkerFleet } from "./worker-fleet";
import type { VersionCheckResult } from "../lib/version-check";
import {
  appendUserEcho,
  clearTranscriptChildren,
  createAssistantMessageStream,
  createBlockMount,
  createBlockNavController,
  createBlockRegistry,
  MAX_THOUGHT_LINES,
  type BlockState,
  type BlockViewOptions,
} from "./transcript-blocks";

/** Result of a cheap git + gh lookup for sidebar metadata. */
interface SidebarRepoMetadata {
  branch?: string;
  prUrl?: string;
}

const SESSION_PREVIEW_MESSAGE_COUNT = 200;

/** Parse a GitHub remote URL into `owner/repo` (if possible). */
function parseGitHubRemote(remote: string): string | undefined {
  const trimmed = remote.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    try {
      const url = new URL(trimmed);
      if (url.hostname !== "github.com") {
        return undefined;
      }
      const [owner, repo] = url.pathname.split("/").filter(Boolean);
      if (!owner || !repo) {
        return undefined;
      }
      return `${owner}/${repo.replace(/\.git$/, "")}`;
    } catch {
      return undefined;
    }
  }

  const sshMatch = trimmed.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (sshMatch?.[1] && sshMatch[2]) {
    return `${sshMatch[1]}/${sshMatch[2].replace(/\.git$/, "")}`;
  }

  const sshUrlMatch = trimmed.match(/^ssh:\/\/(?:[^@/]+@)?github\.com(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (sshUrlMatch?.[1] && sshUrlMatch[2]) {
    return `${sshUrlMatch[1]}/${sshUrlMatch[2]}`;
  }

  return undefined;
}

function runGitText(args: string[], cwd: string): string | undefined {
  try {
    const proc = spawnSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 1200,
    });
    if (proc.status !== 0 || proc.error !== undefined) {
      return undefined;
    }
    const out = typeof proc.stdout === "string" ? proc.stdout.trim() : "";
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

function runGhJson(repo: string, branch: string, cwd: string): string | undefined {
  try {
    const proc = spawnSync("gh", ["pr", "view", branch, "--repo", repo, "--json", "url"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 1800,
    });
    if (proc.status !== 0 || proc.error !== undefined) {
      return undefined;
    }
    return typeof proc.stdout === "string" ? proc.stdout.trim() : undefined;
  } catch {
    return undefined;
  }
}

export function resolveSidebarMetadata(
  cwd: string,
  git: (args: string[], cwd: string) => string | undefined = runGitText,
): SidebarRepoMetadata {
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  if (branch === undefined || branch === "HEAD") {
    return {};
  }

  const remote = git(["config", "--get", "remote.origin.url"], cwd);
  const repo = parseGitHubRemote(remote ?? "");
  if (repo === undefined) {
    return { branch };
  }

  const rawPr = runGhJson(repo, branch, cwd);
  if (rawPr === undefined) {
    return { branch };
  }

  try {
    const parsed = JSON.parse(rawPr) as { url?: unknown };
    if (typeof parsed.url === "string" && parsed.url.length > 0) {
      return { branch, prUrl: parsed.url };
    }
  } catch {
    // fall through
  }
  return { branch };
}

/** A resolved provider/model selection. */
export interface TuiSelection {
  provider: string;
  model: string;
  baseUrl?: string;
}

export interface SelectProviderModelOptions {
  /**
   * When true, only providers considered "connected" are shown: OpenAI-compatible
   * providers with required keys present and successful live `/models` checks.
   */
  onlyConnected?: boolean;
  /** Test/injected fetch for provider validation; defaults to global fetch. */
  fetch?: typeof fetch;
  /** Test/injected environment for env-key checks; defaults to process.env. */
  env?: Record<string, string | undefined>;
}

/**
 * Keep only already-connected providers for `/connect`:
 * - hosted providers need a configured key AND a live `/models` list;
 * - local OpenAI-compat providers (no key) need a successful live probe;
 * - non-registry entries (ollama/anthropic/fake) stay as detection left them.
 */
export async function filterConnectedDetectedProviders(
  detected: readonly DetectedProvider[],
  options: SelectProviderModelOptions = {},
): Promise<DetectedProvider[]> {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const env = options.env ?? process.env;

  const connected: DetectedProvider[] = [];
  for (const prov of detected) {
    const registry = providerByName(prov.name);
    if (registry === undefined) {
      connected.push(prov);
      continue;
    }

    const requiresApiKey = registry.requiresApiKey ?? true;
    const envKey = prov.envKey ?? registry.envKey;
    const raw = envKey !== undefined ? env[envKey] : undefined;
    if (requiresApiKey && (raw === undefined || raw.length === 0)) {
      continue;
    }

    const compat = {
      ...registry,
      ...(prov.baseUrl !== undefined ? { baseUrl: prov.baseUrl } : {}),
      ...(prov.chatPath !== undefined ? { chatPath: prov.chatPath } : {}),
      ...(prov.modelsPath !== undefined ? { modelsPath: prov.modelsPath } : {}),
    };
    const result = await fetchOpenAiCompatModelsDetailed(fetchFn, compat, raw ?? "", {
      timeoutMs: MODELS_FETCH_TIMEOUT_MS,
    });
    if (result.source !== "live" || result.models.length === 0) {
      continue;
    }

    connected.push({ ...prov, models: result.models });
  }
  return connected;
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
export type TuiAgentIo = AgentIO & {
  /** Drop an in-flight assistant stream so the next turn starts a new container. */
  resetStream(): void;
};

export function createTuiAgentIo(otui: OpenTui, renderer: Renderer, transcript: Box): TuiAgentIo {
  let seq = 0;
  const append = (content: StyledContent): void => {
    transcript.add(new otui.TextRenderable(renderer, { id: `n${seq++}`, content }));
  };

  // An assistant message is a COLUMN of sibling renderables — one per markdown
  // segment (flow 109 / AC5) — so a fenced block can be framed with its language
  // tag instead of being flattened into one dim `TextRenderable`. The mechanism
  // itself lives in `transcript-blocks.ts` (flow 112) so the chat driver renders
  // replies through the SAME object rather than a lookalike.
  const messages = createAssistantMessageStream(otui, renderer, transcript);

  return {
    // Assistant text streams into per-segment renderables: worker-free markdown
    // chunks for prose (parity with the readline `renderMarkdown`) and a framed
    // language-tagged box per fence.
    write: (s) => {
      messages.push(s);
    },
    onAssistantText: (text) => {
      messages.finalize(text);
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
    resetStream: () => {
      messages.reset();
    },
  };
}

/** Registers a block and mounts its view; returns the new block id. */
export type BlockSink = (
  input: { kind: string; summary: string; fullText: string; lineCount: number },
  options?: BlockViewOptions,
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
    // Reasoning is SECONDARY: dim, bounded to a short preview, and reversible
    // from the composer (flow 115). The registry still holds the whole payload,
    // so `y` / `/copy` remain lossless.
    addBlock(
      { kind: "thought", summary: "", fullText: body, lineCount },
      {
        hint: "/think · ctrl+o",
        expandedHint: "/think collapse · y copy",
        dim: true,
        maxLines: MAX_THOUGHT_LINES,
      },
    );
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

/**
 * Mount the sidebar's `Directory` panel — the working directory the agent's
 * `shell_exec` and write tools actually act on (gap G-2).
 *
 * The readline header prints it (`src/commands/shell.ts`, `◆ keryx … · <cwd>`);
 * the TUI showed model / context / tools / status and no directory at all, so an
 * operator approving a shell command could not see where it would run. That is
 * the reason this exists — not symmetry with the old header.
 *
 * It goes in the SIDEBAR rather than the header because the header is a single
 * row already carrying the session title, the short id, the compaction count and
 * the provider/model on the left with the token counter on the right, all inside
 * `terminal width - 30`; a path there would either push that identity line out or
 * be truncated to nothing. The sidebar's panels are exactly the persistent facts
 * about the session, its width is a known constant, and one more label/value pair
 * costs two rows in a column that has spare height.
 *
 * Exported so the headless test mounts the SHIPPED panel — including the budget
 * it is shortened to — instead of a replica.
 */
export function mountCwdPanel(
  otui: OpenTui,
  r: Renderer,
  sidebarTop: Box,
  cwd: string,
  metadata: SidebarRepoMetadata = resolveSidebarMetadata(cwd),
): void {
  sidebarTop.add(new otui.TextRenderable(r, { id: "sb-cwd-k", content: otui.t`${otui.dim("Directory")}`, marginTop: 1 }));
  sidebarTop.add(
    new otui.TextRenderable(r, {
      id: "sb-cwd-v",
      content: otui.t`${otui.dim(shortenCwd(cwd, SIDEBAR_TEXT_WIDTH))}`,
    }),
  );

  if (metadata.branch !== undefined) {
    sidebarTop.add(new otui.TextRenderable(r, { id: "sb-branch-k", content: otui.t`${otui.dim("Branch")}`, marginTop: 1 }));
    sidebarTop.add(
      new otui.TextRenderable(r, {
        id: "sb-branch-v",
        content: otui.t`${otui.dim(shortenCwd(metadata.branch, SIDEBAR_TEXT_WIDTH))}`,
      }),
    );
  }

  if (metadata.prUrl !== undefined) {
    sidebarTop.add(new otui.TextRenderable(r, { id: "sb-pr-k", content: otui.t`${otui.dim("PR")}`, marginTop: 1 }));
    sidebarTop.add(
      new otui.TextRenderable(r, {
        id: "sb-pr-v",
        content: otui.t`${otui.dim(shortenCwd(metadata.prUrl, SIDEBAR_TEXT_WIDTH))}`,
      }),
    );
  }
}

/** Cumulative-counter sinks the shell owns; `attachUsageIo` drives them. */
export interface UsageChrome {
  /** Header right slot, e.g. `↑1.2K ↓340`. */
  setHeaderMeta: (text: string) => void;
  /** Sidebar Context panel: the running in+out total. */
  setContextTotal: (total: number) => void;
  /** Called once a provider reports real numbers (retires the estimate). */
  onExactUsage?: () => void;
}

/**
 * Add the shell's CUMULATIVE token counter on top of `io.onUsage` without
 * destroying the per-turn transcript line underneath it (gap G-1).
 *
 * The shell used to ASSIGN `io.onUsage`, which silently deleted the per-turn
 * `↑in ↓out tokens` line flow 050 shipped. The two are not alternatives and
 * neither replaces the other: the cumulative counter tracks the CONTEXT BUDGET
 * across a session, while the per-turn line is the only place an operator can
 * see what THIS turn cost — flow 050's stated motivation (a metered provider).
 * So the base hook is called through, not over-written.
 *
 * Two guards, and both are load-bearing:
 *
 *  - A `0/0` report is dropped BEFORE either sink. It is not usable for the
 *    counter (it would retire a working estimate in favour of zero) and it is
 *    not worth a transcript line reading `↑0 ↓0 tokens`, so the guard is placed
 *    ahead of the call-through rather than duplicated inside it.
 *  - The base hook's own guard — print only the fields the provider actually
 *    reported — survives untouched, so a usage event carrying just
 *    `inputTokens` still renders `↑5 tokens` and never `↓undefined`.
 *
 * Exported, and the shell's ONLY wiring for this, so a headless test can drive
 * `runAgentTurn` through the real composition and see both outputs in one frame
 * rather than proving a replica.
 */
export function attachUsageIo(io: AgentIO, chrome: UsageChrome): AgentIO & { resetUsage(): void } {
  const base = io.onUsage?.bind(io);
  let totalIn = 0;
  let totalOut = 0;
  io.onUsage = (usage) => {
    if ((usage.inputTokens ?? 0) === 0 && (usage.outputTokens ?? 0) === 0) {
      return; // a 0/0 report is not usable — keep the estimate, print nothing
    }
    base?.(usage); // per-turn `↑in ↓out tokens` transcript line (flow 050)
    chrome.onExactUsage?.();
    totalIn += usage.inputTokens ?? 0;
    totalOut += usage.outputTokens ?? 0;
    chrome.setHeaderMeta(`↑${fmtTokens(totalIn)} ↓${fmtTokens(totalOut)}`);
    chrome.setContextTotal(totalIn + totalOut);
  };
  return Object.assign(io, {
    resetUsage(): void {
      totalIn = 0;
      totalOut = 0;
      chrome.setHeaderMeta("↑0 ↓0");
      chrome.setContextTotal(0);
    },
  });
}

/**
 * True only for an explicit `y`/`yes` (case-insensitive). Default-deny otherwise.
 * The TUI itself no longer has a typed y/N approval path — every approval goes
 * through the interactive dock picker — so this is kept as the shared
 * default-deny predicate (and its test) rather than as live shell wiring.
 */
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

/** Resolves the short advisory approval context for a proposed shell command. */
export type ApprovalContextLoader = (command: string) => Promise<string>;

/**
 * The default loader: the flow-041 advisory context (graph blast radius + the top
 * memory note) for `cwd`, the same string the readline shell prints above its
 * `Run …? [y/N]` prompt. The metaproject adapter is built LAZILY on first use and
 * then reused, so an operator who never hits an approval never pays for it.
 */
export function createApprovalContextLoader(cwd: string): ApprovalContextLoader {
  let port: MetaprojectPort | undefined;
  return async (command) => {
    port ??= createMetaprojectAdapter(cwd);
    return buildApprovalContext(port, command);
  };
}

/**
 * Shell permission menu (composer-dock, above input — same band as `/` commands).
 *
 * `loadContext` is REQUIRED rather than optional so the flow-041 context cannot be
 * dropped from a call site without changing this signature (the readline shell had
 * it; the TUI is now the default surface and must not be less informative). It is
 * started here and NOT awaited: the menu renders on the first frame and the dim
 * context line appears later, if at all. A throwing loader, a rejected promise, or
 * one that never settles therefore costs nothing — the user can still answer, and
 * Esc / cancel still means deny.
 */
export async function pickShellApproval(
  otui: OpenTui,
  r: Renderer,
  dock: Box,
  command: string,
  loadContext: ApprovalContextLoader,
  destructive = false,
  credentials = false,
): Promise<ShellApprovalChoice> {
  let context: Promise<string> | undefined;
  try {
    context = loadContext(command);
  } catch {
    context = undefined; // a loader that throws synchronously simply has no context
  }
  const { exact, prefix, offerExact, offerPrefix } = suggestShellPatterns(command);
  // A grant that cannot be given safely is not shown at all: an "always" option
  // the user picks and that is then silently refused would be worse than absent.
  // Destructive commands offer neither (ADR-0009).
  const options = [
    {
      id: "once",
      label: "Allow once",
      description: "Run only this time",
      recommended: true,
    },
    ...(offerExact
      ? [
          {
            id: "always-exact",
            label: `Always allow “${exact.length > 40 ? `${exact.slice(0, 37)}…` : exact}”`,
            description: "Remember exact command (permissions.json)",
          },
        ]
      : []),
    ...(offerPrefix
      ? [
          {
            id: "always-prefix",
            label: `Always allow “${prefix}”`,
            description: "Remember this prefix (permissions.json)",
          },
        ]
      : []),
    {
      id: "deny",
      label: "Deny",
      description: "Do not run",
    },
  ];
  const id = await showComposerChoice(otui, r, dock, {
    title: credentials
      ? "⚠ touches keryx's OWN permissions/credentials — allow?"
      : destructive
        ? "⚠ DESTRUCTIVE command — allow?"
        : "Allow shell command?",
    // Untruncated: `showComposerChoice` renders this in a scrollable, ctrl+o-
    // focusable box (its own defensive char cap), not a single collapsed line.
    subtitle: command,
    ...(context !== undefined ? { context } : {}),
    cancelId: "deny",
    options,
  });
  if (id === "once" || id === "always-exact" || id === "always-prefix" || id === "deny") {
    return id;
  }
  return "deny";
}

/**
 * SLATE-2a `/model`-switch Anchors auto-inject (AC4). The `/model` handler
 * (`command.name === "/model"`, below) is a giant closure inline in
 * `launchTuiAgentShell` with no headless test harness — every OTHER helper
 * in this file is either a PURE function or renders through the scripted
 * `runAgentTurn`/`createTuiAgentIo` harness, and neither shape fits "drive
 * the real OpenTUI model picker". This is the extracted, independently
 * testable seam instead: everything the `/model` handler needs to do to
 * update Anchors, with the picker UI itself left in the closure.
 *
 * Reuses the SAME `recordSlateTouch` touched-tracking + change-detection
 * helper (`src/session/slate-lifecycle.ts`) the per-tool-call injection path
 * in `commands/agent.ts` uses — a `/model` switch is just another harness
 * effect that can change `anchors.runtime`, so it goes through the identical
 * "only inject when something actually changed" path rather than a bespoke
 * one that could drift from it.
 *
 * A no-op (`false`, `params.history` untouched) when there is no open slate
 * to update at all — `slateSession` absent or `slateSession.opened ===
 * false` — mirroring `closeSlateSession`'s own `undefined`-safe contract:
 * `/model` is usable before any slate has ever opened this attempt (no
 * action-intent turn has run yet), and that must cost nothing. `changed ===
 * false` (picking the SAME provider/model again) is also a no-op: `history`
 * is shared, provider-bound state, and re-announcing information the model
 * has already seen is exactly the history-bloat failure mode flow 161's
 * plan.md Risks section calls out.
 *
 * `params.onHistoryChange` (review finding 6): this function used to push
 * its Anchors-block message into `history` and stop there, unlike both other
 * Anchors-injection sites in `agent.ts` (its per-tool-call and fresh-open
 * triggers), which call `io.onHistoryChange?.("tool")` immediately after
 * their own push. `onHistoryChange` drives `syncArchive()`/session-
 * checkpoint persistence (this file's `launchTuiAgentShell`, where
 * `io.onHistoryChange` is assigned) — without it, the `/model`-switch
 * Anchors entry was not archived/persisted until some UNRELATED later event
 * happened to fire `onHistoryChange`, so a session that ended/crashed before
 * that lost the entry from the persisted archive. Optional (not `io`
 * itself) so this function stays testable in isolation the way it already
 * is above, with no IO dependency required when a caller does not need it;
 * `"tool"` matches the `kind` used at the sibling harness-written-history-
 * push call sites in `agent.ts`.
 */
export async function applyRuntimeSwitchToSlate(params: {
  slateSession: SlateSessionRef | undefined;
  runtime: { provider: string; model: string };
  history: NormalizedMessage[];
  onHistoryChange?: ((kind: "user" | "assistant_delta" | "assistant_final" | "tool") => void) | undefined;
}): Promise<boolean> {
  if (params.slateSession === undefined || !params.slateSession.opened) {
    return false;
  }
  const result = await recordSlateTouch(params.slateSession.dir, [], { runtime: params.runtime });
  if (!result.changed) {
    return false;
  }
  params.history.push({
    role: "user",
    content: renderAnchorsBlock(result.slate.anchors),
    provenance: "project",
  });
  params.onHistoryChange?.("tool");
  return true;
}

/** Compact token count for the header counter: 1234 → "1.2K", else the number. */
export function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}

/**
 * Fit a working directory into `max` columns for the sidebar's Directory panel.
 *
 * Two reductions, in order, both of which discard the LEAST identifying part
 * first:
 *
 *  1. `$HOME` → `~` (the shared `collapseHome`, so the TUI and the readline
 *     header spell the same path the same way).
 *  2. Drop whole leading segments behind a `…/` marker until the rest fits. The
 *     TAIL is what identifies a directory — `…/keryx/src/tui` tells an operator
 *     where the agent's `shell_exec` will land; `/Users/someone/dev/proj…` tells
 *     them almost nothing. Middle-truncation (what `formatStatusBar` does for a
 *     much wider bar) would keep a useless head at the cost of the tail, so it is
 *     deliberately not reused here.
 *
 * A pathological single segment longer than the budget has no separator to cut
 * at, so its own tail is kept behind the same marker. Never returns more than
 * `max` chars; `max <= 0` returns "". Pure.
 */
export function shortenCwd(cwd: string, max: number): string {
  if (max <= 0) {
    return "";
  }
  const full = collapseHome(cwd);
  if (full.length <= max) {
    return full;
  }
  const segments = full.split("/").filter((s) => s.length > 0);
  for (let i = 1; i < segments.length; i++) {
    const candidate = `…/${segments.slice(i).join("/")}`;
    if (candidate.length <= max) {
      return candidate;
    }
  }
  // Even the last segment alone overflows (no separator left to cut at): keep
  // its tail, which is still the most specific thing available.
  const last = segments[segments.length - 1] ?? full;
  return `…${last.slice(last.length - (max - 1))}`;
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
    backgroundColor: getTheme().bg,
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

type SearchProviderConfigInput = {
  providerId: string | undefined;
  fields: Record<string, string>;
  credential: string | undefined;
};

function parseSearchProviderArgs(line: string): SearchProviderConfigInput {
  const parts = line.trim().length === 0 ? [] : line.trim().split(/\s+/);
  const [providerId, ...tail] = parts;
  const fields: Record<string, string> = {};
  let credential: string | undefined;
  for (const token of tail) {
    const splitAt = token.indexOf("=");
    if (splitAt <= 0) {
      continue;
    }
    const key = token.slice(0, splitAt).trim();
    const value = token.slice(splitAt + 1).trim();
    if (key === "key" || key === "credential" || key === "token" || key === "apiKey") {
      credential = value;
      continue;
    }
    fields[key] = value;
  }
  return { providerId, fields, credential };
}

function describeSearchProviderList(
  title: string,
  providers: readonly SearchProviderDescriptor[],
): string {
  const rows = providers.map((provider) => `  ${provider.id} (${provider.displayName})`);
  return `${title}${rows.length > 0 ? `\n${rows.join("\n")}` : "\n  (none)"}\n`;
}

/** Ask for a local provider endpoint, keeping its configured value editable. */
function promptBaseUrlStep(otui: OpenTui, r: Renderer, label: string, baseUrl: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const box = overlayBox(otui, r, "base-url-picker");
    r.root.add(box);
  box.add(new otui.TextRenderable(r, { id: "bp-title", content: otui.t`${otui.bold(`${label} endpoint URL`)} ${otui.dim("(Enter · Esc to go back)")}` }));
    box.add(new otui.TextRenderable(r, { id: "bp-note", content: otui.t`${otui.dim("Edit host and port before discovering models")}`, marginTop: 1 }));
    const input = new otui.InputRenderable(r, { id: "bp-input", value: baseUrl, marginTop: 1 });
    box.add(input);
    input.focus();
    const cleanup = (): void => { unsub(); r.root.remove(box); };
    const unsub = onKeypress(r, (key) => {
      if (key.name === "escape") { cleanup(); resolve(undefined); key.preventDefault(); key.stopPropagation(); }
    });
    input.on(otui.InputRenderableEvents.ENTER, () => { const value = input.value.trim(); cleanup(); resolve(value.length > 0 ? value : undefined); });
  });
}

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
export async function modelsForPicker(prov: DetectedProvider): Promise<string[]> {
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
 * In-TUI provider → model → key wizard with BACK navigation. `/provider` and
 * startup prompt + persist a key and may edit a local endpoint. `/connect`
 * (`onlyConnected`) only lists live providers and their live `/models` list —
 * no key or URL setup. Absolute overlay. Resolves the selection or `undefined`.
 *
 * Exported since flow 112 so the CHAT shell injects this very wizard as
 * `ShellDeps.selectProviderModel`: `/provider` must open an overlay instead of
 * `pickProviderModel`'s numbered text menu, which would read the next composer
 * submissions as its answers.
 */
export function selectProviderModelInTui(
  otui: OpenTui,
  r: Renderer,
  detected: DetectedProvider[],
  options: SelectProviderModelOptions = {},
): Promise<TuiSelection | undefined> {
  return new Promise((resolve) => {
    if (detected.length === 0) {
      resolve(undefined);
      return;
    }
    const candidatesPromise = options.onlyConnected
      ? filterConnectedDetectedProviders(detected, {
          ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
          ...(options.env !== undefined ? { env: options.env } : {}),
        })
      : Promise.resolve(detected);
    void (async () => {
      const candidates = await candidatesPromise;
      if (candidates.length === 0) {
        resolve(undefined);
        return;
      }

      // Provider ← Esc cancels.
      // Key (when required) ← Esc backs to provider.
      // Model ← Esc backs to provider.
      // IMPORTANT: prompt for the API key BEFORE fetching /models — Z.AI and most
      // OpenAI-compat gateways return 401 without a Bearer key, and we would
      // otherwise show only the short curated fallback (e.g. stale glm-4.5/4.6).
      while (true) {
        const prov = await pickProviderStep(otui, r, candidates);
        if (prov === undefined) {
          resolve(undefined);
          return;
        }

        // `/connect` only switches: never edit the endpoint or collect a key.
        const selectedBaseUrl =
          options.onlyConnected || prov.baseUrl === undefined
            ? prov.baseUrl
            : await promptBaseUrlStep(otui, r, prov.label ?? prov.name, prov.baseUrl);
        if (!options.onlyConnected && prov.baseUrl !== undefined && selectedBaseUrl === undefined) {
          continue;
        }
        if (!options.onlyConnected && selectedBaseUrl !== undefined) saveProviderBaseUrl(prov.name, selectedBaseUrl);
        const selectedProvider = selectedBaseUrl === undefined ? prov : { ...prov, baseUrl: selectedBaseUrl };

        const envKey = prov.envKey;
        if (!options.onlyConnected && envKey !== undefined) {
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
        const models = await modelsForPicker(selectedProvider);
        const model = await pickModelInTui(otui, r, models);
        if (model === undefined) {
          continue; // Esc at the model step → re-pick the provider
        }
        resolve(
          selectedBaseUrl === undefined
            ? { provider: prov.name, model }
            : { provider: prov.name, model, baseUrl: selectedBaseUrl },
        );
        return;
      }
    })();
  });
}

/**
 * Adaptive height (rows) for a `SelectRenderable`: when the item `count` is small
 * the box is at least a quarter of the available `per`-rows budget; when the list is
 * large it stretches up to the full available height (overflow then scrolls). This
 * replaces the fixed model-picker height so a big OpenRouter list uses the whole
 * overlay instead of a small window.
 */
export function adaptiveSelectHeight(count: number, available: number, per = 1): number {
  const min = Math.max(1, Math.floor(available / 4));
  return Math.min(available, Math.max(min, count * per));
}

/**
 * In-TUI model picker with TYPE-TO-FILTER (search by name, e.g. `free`). Absolute
 * overlay; the SelectRenderable is focused (↑/↓/Enter native) while printable keys
 * and Backspace edit a live filter over the (potentially large) model list. Resolves
 * the chosen model, or `undefined` on Esc / no match. Removes its key handler on close.
 * Exported since flow 112: chat's `/models` opens this same picker.
 */
export function pickModelInTui(otui: OpenTui, r: Renderer, models: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    const all = models;
    const NO_MODELS = "(no models found)";
    const box = overlayBox(otui, r, "model-picker");
    r.root.add(box);
    box.add(new otui.TextRenderable(r, { id: "mp-title", content: otui.t`${otui.bold("Select a model")}` }));
    const filterLine = new otui.TextRenderable(r, { id: "mp-filter", content: otui.t`${otui.dim("type to filter · ↑/↓ Enter · Esc to go back")}` });
    box.add(filterLine);
    const NO_MATCH = "(no match)";
    // Adaptive height: the overlay is full-screen (overlayBox), so "parent height"
    // = renderer height minus the title + filter + padding rows it consumes.
    const rHeight = (r as { height?: number }).height;
    const available = typeof rHeight === "number" && rHeight > 0 ? Math.max(4, rHeight - 4) : 16;
    const height = adaptiveSelectHeight(all.length, available);
    const sel = new otui.SelectRenderable(r, {
      id: "mp-sel",
      width: 72,
      showDescription: false,
      height,
      showScrollIndicator: true,
      wrapSelection: true,
      options: (all.length > 0 ? all : [NO_MODELS]).map((m) => ({ name: m, description: "" })),
      selectedTextColor: "#ffd166",
    });
    box.add(sel);
    sel.focus();

    let filter = "";
    const apply = (): void => {
      const q = filter.trim().toLowerCase();
      const matches = q.length > 0 ? all.filter((m) => m.toLowerCase().includes(q)) : all;
      sel.options = matches.length > 0 ? matches.map((m) => ({ name: m, description: "" })) : [{ name: NO_MATCH, description: "" }];
      filterLine.content = otui.t`${otui.dim(q.length > 0 ? `filter: ${filter}  (${matches.length}/${all.length})` : "type to filter · ↑/↓ Enter · Esc to go back")}`;
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
      resolve(chosen === null || chosen.name === NO_MATCH || chosen.name === NO_MODELS ? undefined : chosen.name);
    });
  });
}

interface SessionPickerOption {
  value: string;
  label: string;
  description: string;
  search: string;
}

function formatSessionDate(iso: string): string {
  const short = iso.trim().replace("T", " ");
  return short.length >= 16 ? short.slice(0, 16) : short;
}

/**
 * In-TUI session picker with TYPE-TO-FILTER. Shows id / project / title / created / updated
 * in one list, and resolves the selected session id, or `undefined` on Esc / no match.
 */
export function pickSessionInTui(
  otui: OpenTui,
  r: Renderer,
  sessions: SessionSummary[],
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const all: SessionPickerOption[] = sessions.map((s) => {
      const created = formatSessionDate(s.createdAt);
      const updated = formatSessionDate(s.updatedAt);
      const short = shortSessionId(s.id);
      const title = s.title.length > 52 ? `${s.title.slice(0, 49)}…` : s.title;
      return {
        value: s.id,
        label: `${short} · ${title}`,
        description: `${s.projectPath} · created ${created} · updated ${updated}`,
        search: `${s.id} ${short} ${s.projectPath} ${s.title} ${created} ${updated}`.toLowerCase(),
      };
    });
    const box = overlayBox(otui, r, "session-picker");
    r.root.add(box);
    box.add(new otui.TextRenderable(r, { id: "sp-title", content: otui.t`${otui.bold("Open session")} ${otui.dim("↑/↓ Enter · Esc to cancel")}` }));
    const filterLine = new otui.TextRenderable(r, {
      id: "sp-filter",
      content: otui.t`${otui.dim("type to filter by id, title, project, created, updated")}`,
    });
    box.add(filterLine);
    const NO_MATCH = "(no match)";
    const sel = new otui.SelectRenderable(r, {
      id: "sp-sel",
      width: "100%",
      showDescription: true,
      height: 14,
      showScrollIndicator: true,
      wrapSelection: true,
      options: [],
      selectedTextColor: "#ffd166",
    });
    box.add(sel);
    sel.focus();

    let filter = "";
    let matches: SessionPickerOption[] = all;
    const apply = (): void => {
      const q = filter.trim().toLowerCase();
      matches = q.length > 0 ? all.filter((row) => row.search.includes(q)) : all;
      const items = matches.length > 0 ? matches : [
        {
          value: "",
          label: NO_MATCH,
          description: "",
          search: "",
        },
      ];
      sel.options = items.map((row) => ({ name: row.label, description: row.description, value: row.value }));
      filterLine.content = otui.t`${otui.dim(q.length > 0 ? `filter: ${filter}  (${matches.length})` : "type to filter · ↑/↓ Enter · Esc to cancel")}`;
      sel.selectedIndex = 0;
    };
    apply();

    const onKey = (key: {
      name: string;
      ctrl: boolean;
      meta: boolean;
      sequence: string;
      preventDefault: () => void;
      stopPropagation: () => void;
    }): void => {
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
      if (chosen === null || chosen.value === "" || chosen.name === NO_MATCH) {
        resolve(undefined);
        return;
      }
      const matched = matches.find((row) => row.value === chosen.value);
      resolve(matched?.value);
    });
  });
}

/** `/mode` picker copy — one line per {@link PermissionMode}, kept beside the type it describes. */
const MODE_PICKER_DESCRIPTIONS: Readonly<Record<PermissionMode, string>> = {
  ask: "Every mutating action asks first (today's default)",
  trust: "Auto-approves safe actions; still asks for destructive/credential ones",
  auto: "Skips confirmation for everything except credential-touching commands",
};

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
  /**
   * Widened from a bare `getSessionDir: () => string | undefined` (fix
   * round, code review of PR #306, Finding 1): `createSpawnSubagentTool`'s
   * `SpawnSubagentToolDeps.getSlateSession` needs the FULL live
   * `SlateSessionRef`, not just its `.dir` string, to fold a dispatched
   * child's ephemeral slate into `parent.slate.childDispatches`. Exposing
   * only `.dir` here (the old shape) meant `commands/shell.ts`'s
   * `makeAgentDeps` closure had no way to hand a real `SlateSessionRef`
   * through to `createSpawnSubagentTool` at all — SLATE-6's fold mechanism
   * silently never fired for any real `keryx shell` TUI session. Both real
   * call sites below (around lines 1419/2203) already hold the full
   * `slateSession` local — this just widens the contract to pass it
   * through instead of narrowing it to `.dir` first.
   */
  makeAgentDeps: (sel: TuiSelection, getSlateSession: () => SlateSessionRef | undefined) => Promise<AgentDeps>;
  /** Re-probe providers for `/connect` and `/model` (fresh detection). */
  redetect?: () => Promise<DetectedProvider[]>;
  versionCheck?: Promise<VersionCheckResult>;
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
  /**
   * The CLI-flag override only (`--permission-mode` / `--ask`/`--trust`/
   * `--auto`, see `parseShellCliFlags` in `commands/shell.ts`). `undefined`
   * means no flag was passed — the session then falls back to the project's
   * stored default (`getProjectPermissionMode(sessionCwd)`) and finally
   * `DEFAULT_PERMISSION_MODE`.
   */
  initialPermissionMode?: PermissionMode;
}): Promise<boolean> {
  if (!process.stdout.isTTY) {
    return false;
  }
  applyThemeId(loadPersistedThemeId());
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
  let uid = 0;
  // Surfaces this pane's lifecycle to a herdr workspace (working/idle/blocked).
  // No-op unless the shell was launched inside a herdr pane.
  const herdr = createHerdrReporter();
  /** Session-scoped allow patterns (plus persisted permissions.json). */
  const sessionShellAllow = new Set<string>(loadShellPermissions().allow);
  /** The stored-permission migration warning is shown at most once per session. */
  let permissionMigrationShown = false;
  /**
   * Fingerprint of permissions.json as it was when the session started. If it
   * changes mid-session the allowlist was rewritten by something other than the
   * approval UI — the self-grant path — and the user is told before the next
   * auto-approve acts on it.
   */
  let permissionsFingerprintAtStart = shellPermissionsFingerprint();
  let permissionTamperShown = false;
  const searchProviderController = createDefaultSearchProviderController();
  // The chrome can only be mounted once a provider/model is chosen (the startup
  // picker runs on the bare renderer), yet `onDestroy` may fire before that —
  // Ctrl+C at the picker. A nullable handle is the honest shape for that window;
  // it is never rebound to a placeholder no-op (flow 112, AC2).
  let mountedChrome: ShellChrome | undefined;
  try {
    // Stable non-nullable handle for the closures below (the outer `renderer`
    // stays `Renderer | undefined` for the `finally` teardown).
    const r = (renderer = await createShellRenderer(otui, {
      onDestroy: () => {
        mountedChrome?.destroy(); // stops the live spinner if a turn is mid-flight
        setAskUserHost(undefined);
        setSubagentFleetListener(undefined);
        setJobFleetListener(undefined);
        // No orphaned background jobs/watchers survive the shell (flow 174).
        // Fire-and-forget, not awaited: `onDestroy` is typed `() => void`
        // (shell-chrome.ts) — readline's equivalent (`shell.ts`'s `finally`)
        // DOES await this same call, which is the stronger guarantee. Safe
        // today because nothing on this path calls `process.exit()`, so the
        // event loop stays alive for `killAll()`'s SIGKILL grace timer; if
        // that ever changes, widen `onDestroy` to `() => void | Promise<void>`
        // and await it here (flow 174 security review, F-003).
        void killAllBackgroundJobs();
        resolveDone();
      },
    }));
    applyThemeId(getThemeId(), r.themeMode);
    // Review finding: unregistered on destroy, unlike every other renderer-
    // level subscription in this file — named so `.off()` at every exit path
    // below can find the same reference `.on()` registered.
    const onThemeMode = (mode: "dark" | "light"): void => {
      if (getThemeId() === "auto") {
        applyThemeId("auto", mode);
      }
    };
    r.on("theme_mode", onThemeMode);

    // Resolve the provider/model — from flags, or an in-TUI picker.
    const sel = opts.initial ?? (await selectProviderModelInTui(otui, r, opts.detected));
    if (sel === undefined) {
      r.off("theme_mode", onThemeMode);
      r.destroy();
      return true; // could not select; treat as a clean exit (do not fall back)
    }
    // Persist the chosen provider/model (opencode-style) so the next launch reuses it.
    saveShellConfig(sel.baseUrl === undefined ? { provider: sel.provider, model: sel.model } : { provider: sel.provider, model: sel.model, baseUrl: sel.baseUrl });
    // Mutable: `/connect` and `/model` rebuild these mid-session.
    let currentSel: TuiSelection = sel;
    // SLATE-3a (flow 161, AC5): the session-tracking variable this closure
    // reads is declared further down in this same function body. The getter
    // only runs once a turn actually executes a tool call, well after that
    // declaration has run, so referencing it here (textually earlier) is
    // safe — TDZ is a call-time concern for a closure, not a
    // closure-creation-time one.
    // Finding 1 fix: pass the FULL live `slateSession` ref through, not just
    // `.dir` — `makeAgentDeps`'s widened contract (see `opts.makeAgentDeps`
    // doc comment above) needs it to wire `createSpawnSubagentTool`'s new
    // `getSlateSession` getter so a dispatched subagent's Seeds actually
    // fold into this session's slate once it opens.
    let deps = await opts.makeAgentDeps(sel, () => slateSession);

    const FOOTER_IDLE = "/ commands · Ctrl+O blocks · Ctrl+C to exit";
    const FOOTER_NAV = "blocks · ↑/↓ move · Enter toggle · y copy · Esc exit";

    // The mode-agnostic chrome (flow 112, S1): layout, header, transcript,
    // choice dock, `/`-menu, composer, footer/spinner, toast, overlay guard and
    // copy-on-select. Everything below is agent-specific and mounts ON it.
    const chrome = await createShellChrome(otui, r, {
      title: `keryx · agent · ${sel.provider}/${sel.model}`,
      status: `${sel.provider}/${sel.model}`,
      footerHint: FOOTER_IDLE,
      placeholder: "type a task or / for commands · Enter send · Shift+Enter newline",
      commands: commandsForMode("agent"),
      headerMeta: "↑0 ↓0",
      // The shared registry stays the single source of truth for the dropdown,
      // resolved through THIS surface's mode so the wording is agent-mode's.
      filterCommands: (query) => filterCommands(query, "agent"),
      ...(opts.versionCheck !== undefined ? { versionCheck: opts.versionCheck } : {}),
    });
    mountedChrome = chrome;
    const transcript = chrome.transcript;
    const input = chrome.input;

    // The chrome owns the spinner; the closure mirrors only the phase and the
    // start time, which it still needs for the side-worker context snapshot and
    // which the chrome deliberately does not expose.
    let busyPhase = "waiting for model";
    let busyStartedAt = 0;
    const setBusyPhase = (phase: string): void => {
      busyPhase = phase;
      chrome.setBusyPhase(phase);
    };
    const startBusy = (phase = "waiting for model"): void => {
      busyPhase = phase;
      busyStartedAt = Date.now();
      chrome.startBusy(phase);
    };
    const stopBusy = (): void => {
      chrome.stopBusy();
    };
    let mainTurnAbortController: AbortController | undefined;

    // Sidebar panels (model, context, tools, workers) go in `sidebarTop`, NOT
    // `sidebar`: the chrome pins the toast to the bottom with a flexGrow spacer,
    // so anything added to `sidebar` itself would land beside the toast.
    const sidebar = chrome.sidebarTop;
    sidebar.add(new otui.TextRenderable(r, { id: "sb-title", content: otui.t`${otui.bold("keryx")}` }));
    sidebar.add(new otui.TextRenderable(r, { id: "sb-model-k", content: otui.t`${otui.dim("Model")}`, marginTop: 1 }));
    const sbModelV = new otui.TextRenderable(r, { id: "sb-model-v", content: otui.t`${otui.dim(`${sel.provider}/${sel.model}`)}` });
    sidebar.add(sbModelV);
    // The directory the agent's tools act on — directly under Model, matching the
    // readline header's `provider/model … · <cwd>` order (gap G-2).
    mountCwdPanel(otui, r, sidebar, opts.session?.cwd ?? process.cwd());
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
    // Hug-content box, not a flexGrow ScrollBox: a growing viewport inside
    // flexShrink-0 sidebarTop covers the Model/Tools labels on a real pty
    // (shell-pty-launch O-6). Empty list is zero height; rows add as children spawn.
    const sbSubagents = new otui.BoxRenderable(r, {
      id: "sb-subagents",
      flexDirection: "column",
      flexShrink: 0,
      marginTop: 1,
    });
    sidebar.add(sbSubagents);
    const fleet = new WorkerFleet();
    const sessions = new SubagentSessionStore();
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
    const paintSubagents = (hint?: { kind: string }): void => {
      if (hint?.kind === "log") {
        return;
      }
      paintSubagentSidebar(otui, r, sbSubagents, sessions.list(), {
        width: SIDEBAR_TEXT_WIDTH,
        onOpen: (id) => {
          openSubagentInspector(otui, chrome, { store: sessions, id, renderer: r });
        },
      });
    };
    fleet.subscribe(paintFleet);
    sessions.subscribe(paintSubagents);
    // MAE spawn_subagent → inspectable session list only (never dual-write to fleet).
    setSubagentFleetListener((ev) => {
      sessions.apply(ev);
    });
    // start_job/watch_job (flow 174) → the same Activity panel side workers use.
    setJobFleetListener((ev) => {
      if (ev.kind === "remove") {
        fleet.remove(ev.id);
        return;
      }
      fleet.upsert({
        id: ev.id,
        label: ev.label,
        status: ev.status,
        ...(ev.detail !== undefined ? { detail: ev.detail } : {}),
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
      herdr.report(herdrStateFor(status));
    };
    // Idle main agent visible from launch.
    setMainAgent("queued", "ready");

    const io = createTuiAgentIo(otui, r, transcript);
    // Cumulative token usage → the header counter + sidebar. Prefer the provider's
    // EXACT `usage`; fall back to an estimate (see the turn `finally` below) for
    // providers that report nothing (e.g. local Ollama models). `attachUsageIo`
    // WRAPS the base hook rather than replacing it, so the per-turn transcript
    // line survives alongside the cumulative counter (gap G-1 — the two answer
    // different questions).
    let hasExactUsage = false;
    const baseWrite = io.write.bind(io);
    const baseOnSystem = io.onSystem?.bind(io);
    // `setBusyPhase` / `setMainAgent` are both defined above, so the hooks below
    // close over live bindings rather than placeholders that get rewired later.

    // --- collapsible transcript blocks (flow 109) --------------------------
    // Reasoning, tool calls and tool results become addressable blocks that
    // RETAIN their full text (bounded — D-4) instead of discarding it, so they
    // can be expanded in place, navigated with the keyboard and copied.
    const blocks = createBlockRegistry({
      onEvict: (dropped) => {
        if (dropped.length === 1) {
          const kind = dropped[0]?.kind ?? "block";
          chrome.showToast(`Dropped oldest ${kind} output`);
          return;
        }
        chrome.showToast(`Dropped ${dropped.length} oldest outputs`);
      },
    });
    const blockMount = createBlockMount(otui, r, transcript, blocks);
    // The whole modal navigation mode (focus guard, key dispatch, sticky-scroll
    // suspension) lives in `transcript-blocks.ts` so it is reachable from a
    // headless test; the closure keeps only wiring (risk R5). Everything the
    // controller needs from the chrome — the menu/overlay guard, the composer,
    // the status repaint — is already mounted above.
    const nav = createBlockNavController({
      registry: blocks,
      view: (id) => blockMount.view(id),
      scroll: chrome.scroll,
      isBlocked: () => chrome.menuActive() || chrome.overlayActive(),
      focusComposer: () => input.focus(),
      blurComposer: () => chrome.blurComposer(),
      copyText: (text) => r.copyToClipboardOSC52(text),
      toast: (message) => chrome.showToast(message),
      onChange: () => chrome.repaintStatus(),
    });
    // Block-nav mode owns the footer hint even mid-turn: the chrome's 120ms
    // spinner interval would otherwise repaint over it.
    chrome.setFooterOverride(() => (nav.active() ? otui.t`${otui.yellow(FOOTER_NAV)}` : undefined));
    const focusComposer = (): void => nav.restoreComposerFocus();
    const newestBlock = (kind?: string): BlockState | undefined => nav.newest(kind);
    const toggleNewestBlock = (kind?: string): BlockState | undefined => nav.toggleNewest(kind);
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
    const usage = attachUsageIo(io, {
      setHeaderMeta: (text) => chrome.setHeaderMeta(text),
      setContextTotal: (total) => {
        sbContext.content = otui.t`${otui.dim(`${total.toLocaleString()} tokens`)}`;
      },
      onExactUsage: () => {
        hasExactUsage = true;
      },
    });
    let lastUsage: NormalizedUsage | undefined;
    const recordedUsage = io.onUsage?.bind(io);
    io.onUsage = (usage) => {
      lastUsage = usage;
      recordedUsage?.(usage);
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

    // Approval gate: `shell_exec` (remembered patterns) + `spawn_subagent` (MAE).
    // Default-deny for shell on cancel; read_only subagents auto-approve.
    // The flow-041 advisory context (blast radius + memory note) is loaded through
    // this loader — the same information the readline shell shows above its prompt.
    const approvalContext = createApprovalContextLoader(opts.session?.cwd ?? process.cwd());
    io.requestApproval = async (tool, inputJson, meta) => {
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
          // Auto-approved without a prompt, so the transcript line is the ONLY
          // record that a child was started and at what privilege. It is not
          // dimmed: an auto-approval the user cannot notice is an auto-approval
          // they cannot object to.
          transcript.add(
            new otui.TextRenderable(r, {
              id: `ap${uid++}`,
              content: otui.t`${otui.cyan("◇ subagent auto-approved")} ${otui.dim(`mode=read_only (no shell) · ${taskPreview}`)}`,
            }),
          );
          return true;
        }
        chrome.hideMenu(); // hide the dropdown AND release menuNav before the dock takes over
        setMainAgent("blocked", "approval");
        const id = await showComposerChoice(otui, r, chrome.dock, {
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

      const ev = evaluateShellApproval({
        inputJson,
        ...(meta !== undefined ? { meta } : {}),
        sessionAllow: sessionShellAllow,
        fingerprintAtStart: permissionsFingerprintAtStart,
      });
      const cmd = ev.command;
      const destructive = ev.destructive;
      if (!permissionMigrationShown && ev.rejected.length > 0) {
        permissionMigrationShown = true;
        transcript.add(
          new otui.TextRenderable(r, {
            id: `ap${uid++}`,
            content: otui.t`${otui.yellow(
              `⚠ ${ev.rejected.length} saved shell permission(s) are no longer honoured — they granted arbitrary execution:`,
            )}`,
          }),
        );
        for (const rej of ev.rejected) {
          transcript.add(
            new otui.TextRenderable(r, {
              id: `ap${uid++}`,
              content: otui.t`${otui.dim(`    “${rej.pattern}” — ${rej.reason}`)}`,
            }),
          );
        }
        transcript.add(
          new otui.TextRenderable(r, {
            id: `ap${uid++}`,
            content: otui.t`${otui.dim(
              `    They are still in ${shellPermissionsPath()} — edit or remove them there.`,
            )}`,
          }),
        );
      }
      if (!permissionTamperShown && ev.tampered) {
        permissionTamperShown = true;
        transcript.add(
          new otui.TextRenderable(r, {
            id: `ap${uid++}`,
            content: otui.t`${otui.red(
              "⚠ the saved shell permissions changed outside this approval UI — review them before trusting an auto-approve",
            )}`,
          }),
        );
      }
      if (ev.autoApprove) {
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
      chrome.hideMenu(); // hide the dropdown AND release menuNav before the dock takes over
      const choice = await pickShellApproval(
        otui,
        r,
        chrome.dock,
        cmd,
        approvalContext,
        destructive,
        meta?.credentials === true,
      );
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
        // Refused grants return "" — the command still runs this once, but the
        // transcript must never claim a grant that was not stored.
        const stored = allowShellPattern(pattern);
        if (stored.length > 0) {
          sessionShellAllow.add(stored);
          permissionsFingerprintAtStart = shellPermissionsFingerprint();
        }
        transcript.add(
          new otui.TextRenderable(r, {
            id: `av${uid++}`,
            content:
              stored.length > 0
                ? otui.t`${otui.green(`approved · remembered “${stored}”`)}`
                : otui.t`${otui.yellow(`approved once · “${pattern}” cannot be remembered`)}`,
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
      chrome.hideMenu(); // hide the dropdown AND release menuNav before the dock takes over
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
      const chosen = await showComposerChoice(otui, r, chrome.dock, {
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

    const helpText = (): string => renderCommandHelp("agent");

    // --- Per-project session (isolated by git root / cwd) --------------------
    const sessionCwd = opts.session?.cwd ?? process.cwd();

    // Fallback chain: CLI flag > this project's stored default > the global
    // default (`ask`, unchanged behavior for anyone who never opts in) —
    // parity with `runAgentRepl` in `commands/shell.ts`. `/mode` below only
    // ever reassigns the `let`, never re-derives this chain.
    let permissionMode: PermissionMode =
      opts.initialPermissionMode ?? getProjectPermissionMode(sessionCwd) ?? DEFAULT_PERMISSION_MODE;
    io.permissionMode = () => permissionMode;
    io.onAutoApproved = (tool, input, meta) => {
      // NOT dimmed — same principle as the read_only subagent auto-approval
      // above: a mode-driven auto-approval was never okayed action-by-action,
      // only the mode itself was chosen, once, so the transcript line is the
      // only record of it.
      const preview = tool === "shell_exec" ? parseShellExecCommand(input) : tool;
      // `meta.credentials` never reaches here — resolveApprovalDecision's hard
      // floor means a credentials-touching call is never `auto`, in any mode.
      const label = meta.destructive
        ? `◇ auto-approved (${permissionMode}) [destructive]`
        : `◇ auto-approved (${permissionMode})`;
      transcript.add(
        new otui.TextRenderable(r, {
          id: `ap${uid++}`,
          content: otui.t`${otui.yellow(label)} ${otui.dim(preview)}`,
        }),
      );
    };

    // Definite assignment: every control-flow path calls `applyOpened` before
    // paint/save; `!` satisfies TS2454 (assignments inside nested closures are
    // invisible to control-flow analysis).
    let liveSession!: SessionHandle;
    let history: NormalizedMessage[] = [];
    let archive: NormalizedMessage[] = [];
    let nextArchiveIndex = 0;
    let sessionPersistTimer: ReturnType<typeof setTimeout> | undefined;
    /**
     * SLATE-5 open/close wiring (parity with `runAgentRepl` in
     * `src/commands/shell.ts`) — a fresh, never-opened ref per live session
     * dir, reassigned on `/new`/`/clear`. The TUI always has a live session
     * (no sessions-off path here, unlike the REPL), so this is unconditional
     * once `liveSession` is set below.
     */
    let slateSession: SlateSessionRef | undefined;

    const applyOpened = (
      opened: {
        handle: SessionHandle;
        history: NormalizedMessage[];
        archive: NormalizedMessage[];
        resumed: boolean;
      },
      previewHistory?: boolean,
    ): void => {
      liveSession = opened.handle;
      history = previewHistory === true ? opened.history.slice(-SESSION_PREVIEW_MESSAGE_COUNT) : opened.history;
      archive = opened.archive.length > 0 ? [...opened.archive] : [...opened.history];
      nextArchiveIndex = history.length;
    };

    const pickRecentSession = async (): Promise<SessionSummary | undefined> => {
      const rows = listSessions(sessionCwd);
      if (rows.length === 0) {
        io.onSystem?.("No saved sessions in this project.\n");
        return undefined;
      }
      chrome.hideMenu(); // hide the dropdown AND release menuNav before the dock takes over
      const pickId = await chrome.withOverlay(() => pickSessionInTui(otui, r, rows));
      input.focus();
      if (pickId === undefined) {
        return undefined;
      }
      const found = findSession(sessionCwd, pickId);
      if (found === undefined) {
        io.onSystem?.("Session not found in this project.\n");
        return undefined;
      }
      return found;
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
          chrome.hideMenu(); // hide the dropdown AND release menuNav before the dock takes over
          const pickId = await showComposerChoice(otui, r, chrome.dock, {
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
        if (opened.archiveDegraded !== undefined) {
          transcript.add(
            new otui.TextRenderable(r, {
              id: `sessdeg${uid++}`,
              content: otui.t`${otui.yellow(`archive unavailable — resumed from the active context (${opened.archiveDegraded})`)}`,
              marginTop: 1,
            }),
          );
        }
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
    slateSession = { dir: liveSession.dir, cwd: sessionCwd, opened: false };

    const paintSessionHeader = (): void => {
      const label = `${currentSel.provider}/${currentSel.model}`;
      const sid = shortSessionId(liveSession.summary.id);
      const title =
        liveSession.summary.title.length > 24
          ? `${liveSession.summary.title.slice(0, 21)}…`
          : liveSession.summary.title;
      const cx = liveSession.summary.compactCount > 0 ? ` · c×${liveSession.summary.compactCount}` : "";
      chrome.setTitle(`keryx · ${title} · ${sid}${cx} · ${label}`);
    };

    const saveSession = (): void => {
      liveSession = persistHistory(liveSession, history, {
        archive,
        provider: currentSel.provider,
        model: currentSel.model,
      });
      paintSessionHeader();
    };

    const syncArchive = (): void => {
      while (nextArchiveIndex < history.length) {
        const message = history[nextArchiveIndex];
        if (message !== undefined) {
          archive.push(message);
        }
        nextArchiveIndex += 1;
      }
    };
    const flushSessionCheckpoint = (): void => {
      if (sessionPersistTimer !== undefined) {
        clearTimeout(sessionPersistTimer);
        sessionPersistTimer = undefined;
      }
      syncArchive();
      saveSession();
    };
    io.onHistoryChange = (kind) => {
      syncArchive();
      if (kind === "assistant_delta") {
        if (sessionPersistTimer === undefined) {
          sessionPersistTimer = setTimeout(() => {
            sessionPersistTimer = undefined;
            saveSession();
          }, 300);
        }
        return;
      }
      flushSessionCheckpoint();
    };
    const resetSessionSurface = (): void => {
      nav.exit();
      chrome.stopBusy();
      io.resetStream();
      blockMount.clear();
      clearTranscriptChildren(transcript);
      chrome.scroll.scrollTop = 0;
      chrome.scroll.stickyScroll = true;
      fleet.clearMatching((w) => w.id !== MAIN_AGENT_ID);
      setMainAgent("queued", "ready");
      hasExactUsage = false;
      lastUsage = undefined;
      usage.resetUsage();
    };

    const startNewSession = (note?: string): void => {
      resetSessionSurface();
      liveSession = createSession({
        cwd: sessionCwd,
        provider: currentSel.provider,
        model: currentSel.model,
      });
      history = [];
      archive = [];
      nextArchiveIndex = 0;
      paintSessionHeader();
      if (note !== undefined && note.length > 0) {
        io.onSystem?.(`${note}\n`);
      }
    };

    const resumeSessionInteractive = async (): Promise<void> => {
      const found = await pickRecentSession();
      if (found === undefined) {
        return;
      }
      // Guarded, and deliberately NOT by falling back to a new session the way
      // the startup path does. The operator asked to resume a specific session;
      // losing the live one as a side effect of that request would be a second
      // failure on top of the first. Unguarded, the throw escaped an async
      // handler with no rejection boundary.
      let opened: ReturnType<typeof openSession>;
      try {
        opened = openSession({
          cwd: sessionCwd,
          resumeId: found.id,
          provider: currentSel.provider,
          model: currentSel.model,
        });
      } catch (cause) {
        io.onSystem?.(
          `Could not resume ${shortSessionId(found.id)}: ${cause instanceof Error ? cause.message : String(cause)}\n` +
            `Staying in the current session.\n`,
        );
        return;
      }
      applyOpened(opened, true);
      paintSessionHeader();
      if (opened.archiveDegraded !== undefined) {
        io.onSystem?.(`Archive unavailable — resumed from the active context (${opened.archiveDegraded})\n`);
      }
      io.onSystem?.(
        `Resumed ${shortSessionId(liveSession.summary.id)} · ${liveSession.summary.title} (ctx ${history.length} · archive ${archive.length})\n`,
      );
    };

    paintSessionHeader();

    const inspectorKeys = { onKeypress: (handler: (key: { name: string; sequence: string }) => void) => onKeypress(r, (key) => handler(key)) };
    const inspectorCwd = (): string => opts.session?.cwd ?? liveSession.summary.projectPath;
    const showSessionInfo = (): void => {
      void (async () => {
        const cwd = inspectorCwd();
        const [workspaces, flows] = await Promise.all([loadInspectorWorkspaces(cwd), loadInspectorFlows(cwd)]);
        const snapshot = buildSessionInfoSnapshot({
          summary: liveSession.summary,
          selection: currentSel,
          version: packageJson.version,
          usage: lastUsage,
          estimateTokens: estimateContextTokens(history),
          sessionText: history.map((message) => message.content).join("\n"),
          workspaces,
          flows,
        });
        openSessionInfo(otui, chrome, {
          snapshot,
          copyText: (text) => r.copyToClipboardOSC52(text),
          toast: (message) => chrome.showToast(message),
          renderer: r,
          ...inspectorKeys,
        });
      })();
    };
    const showFlows = (): void => {
      void (async () => {
        const items = await loadInspectorFlows(inspectorCwd());
        openFlows(otui, chrome, {
          items,
          renderer: r,
          ...inspectorKeys,
        });
      })();
    };

    // `/model` and `/connect` rebuild `deps` mid-session and refresh the labels.
    const updateModelLabels = (): void => {
      paintSessionHeader();
      const label = `${currentSel.provider}/${currentSel.model}`;
      sbModelV.content = otui.t`${otui.dim(label)}`;
      chrome.setStatus(label);
    };
    const switchTo = async (ns: TuiSelection): Promise<void> => {
      currentSel = ns;
      // Finding 1 fix: same widened contract as the initial `makeAgentDeps`
      // call above — pass the live `slateSession` ref, not just `.dir`.
      deps = await opts.makeAgentDeps(ns, () => slateSession);
      saveShellConfig(
        ns.baseUrl === undefined ? { provider: ns.provider, model: ns.model } : { provider: ns.provider, model: ns.model, baseUrl: ns.baseUrl },
      );
      updateModelLabels();
      input.focus();
      chrome.showToast(`Switched to ${ns.provider}/${ns.model}`);
    };

    // Side workers while main is busy (automatic — no special slash command).
    const SIDE_WORKER_ID = `${SIDE_WORKER_ID_PREFIX}1`;
    const sideWorkerLabelText = sideWorkerLabel(1);
    type QueuedSideQuestion = {
      question: string;
      displayQuestion: string;
    };
    const sideQueue: QueuedSideQuestion[] = [];

    // QueuedMainQuestion type imported from ./main-queue (pure helpers).
    let mainQueue: QueuedMainQuestion[] = [];
    let mainQueueSeq = 0;
    // Set by `editMainQueue`: the NEXT plain-text submit while busy re-queues
    // this item at its original position instead of opening the recipient
    // selector again (AC5 — edit must preserve position).
    let pendingQueueEdit: { id: string; at: number } | undefined;
    // Set by `forceMainQueue` when a turn is in flight: `abort()` only signals
    // cancellation, it does not synchronously stop the turn, so the item is
    // handed to the turn's `finally` to run next once it has settled (AC6).
    let priorityMainQuestion: QueuedMainQuestion | undefined;
    let sideWorkerRunning = false;
    let sideClearTimeout: ReturnType<typeof setTimeout> | undefined;

    const showSideQueueStatus = (): void => {
      if (sideQueue.length === 0) {
        if (!sideWorkerRunning) {
          return;
        }
        fleet.upsert({ id: SIDE_WORKER_ID, label: sideWorkerLabelText, status: "running", detail: "side Q" });
        return;
      }
      fleet.upsert({
        id: SIDE_WORKER_ID,
        label: sideWorkerLabelText,
        status: sideWorkerRunning ? "running" : "queued",
        detail: `queued ×${sideQueue.length}`,
      });
    };

    let mainQueueBlocks: Array<{ id: string; box: Box }> = [];
    const paintMainQueue = (): void => {
      // Remove stale blocks.
      for (const entry of mainQueueBlocks) {
        try {
          transcript.remove(entry.box);
        } catch {
          // ignore
        }
      }
      mainQueueBlocks = [];
      for (let i = 0; i < mainQueue.length; i++) {
        const item = mainQueue[i];
        if (item === undefined) continue;
        const box = appendUserEcho(otui, r, transcript, {
          id: `mq-${item.id}`,
          line: `${formatMainQueueMarker(i)} ${item.displayQuestion}`,
          borderColor: getTheme().highlight,
          marginTop: 0,
        });
        mainQueueBlocks.push({ id: item.id, box });
      }
      // Fleet/status counter.
      if (mainQueue.length > 0) {
        fleet.upsert({ id: "agent:queue", label: "mainQ", status: "queued", detail: `queued \u00d7${mainQueue.length}` });
      } else {
        fleet.remove("agent:queue");
      }
    };

    const removeMainQueue = (index: number): void => {
      if (index < 0 || index >= mainQueue.length) return;
      mainQueue = removeMainQueueItem(mainQueue, index);
      paintMainQueue();
    };

    const editMainQueue = (index: number): void => {
      const edited = editMainQueueItem(mainQueue, index);
      if (edited === undefined) return;
      mainQueue = edited.rest;
      pendingQueueEdit = { id: edited.removed.id, at: index };
      input.value = edited.text;
      input.focus();
      paintMainQueue();
    };

    const forceMainQueue = (index: number): void => {
      const item = mainQueue[index];
      if (item === undefined) return;
      mainQueue = removeMainQueueItem(mainQueue, index);
      paintMainQueue();
      if (mainTurnAbortController !== undefined && !mainTurnAbortController.signal.aborted) {
        // `abort()` only signals cancellation — it does NOT synchronously stop
        // the turn (`chrome.isBusy()` is still true right after this call), so
        // running the item here would drop it. Stash it; the main turn's
        // `finally` below runs it next, ahead of anything already queued.
        priorityMainQuestion = item;
        mainTurnAbortController.abort();
        mainTurnAbortController = undefined;
        io.onSystem?.(`◇ main turn interrupted — q${index + 1} will run next.\n`);
        return;
      }
      // No turn in flight (e.g. forced right as the previous one settled).
      runLine(item.question);
    };

    const clearSideWorkerSlot = (): void => {
      if (sideClearTimeout !== undefined) {
        clearTimeout(sideClearTimeout);
      }
      sideClearTimeout = setTimeout(() => {
        if (sideWorkerRunning || sideQueue.length > 0) {
          return;
        }
        try {
          fleet.remove(SIDE_WORKER_ID);
        } catch {
          // ignore
        }
      }, 12_000);
    };

    const summarizeSubmittedLine = (line: string): string => {
      const normalized = line.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      const count = normalized.split("\n").filter((linePart) => linePart.length > 0).length;
      if (count <= 1) {
        return line;
      }
      return `[pasted ${count} lines]`;
    };

    const spawnSideWorker = (question: string, displayQuestion = question): void => {
      sideQueue.push({ question, displayQuestion });
      if (sideQueue.length > 1 || sideWorkerRunning) {
        transcript.add(
          new otui.TextRenderable(r, {
            id: `side-max${uid++}`,
            content: otui.t`${otui.yellow(`◦ side-1 queued (${sideQueue.length - 1} pending)`)} ${
              otui.dim(`· while main: ${busyPhase}`)
            }`,
            marginTop: 1,
          }),
        );
        showSideQueueStatus();
        return;
      }

      void (async () => {
        while (sideQueue.length > 0) {
          const next = sideQueue.shift();
          if (next === undefined) {
            break;
          }
          const currentQuestion = next.question;
          sideWorkerRunning = true;
          if (sideClearTimeout !== undefined) {
            clearTimeout(sideClearTimeout);
            sideClearTimeout = undefined;
          }

          const mainSlot = fleet.list().find((w) => w.id === MAIN_AGENT_ID);
          const elapsedSec = busyStartedAt > 0 ? (Date.now() - busyStartedAt) / 1000 : undefined;

          fleet.upsert({
            id: SIDE_WORKER_ID,
            label: sideWorkerLabelText,
            status: "running",
            detail: sideQueue.length > 0 ? `side Q (${sideQueue.length} queued)` : "side Q",
            model: `${currentSel.provider}/${currentSel.model}`,
          });

          transcript.add(
            new otui.TextRenderable(r, {
              id: `side-h${uid++}`,
              content: otui.t`${otui.magenta("──")} ${otui.bold(sideWorkerLabelText)} ${otui.magenta("──")} ${
                otui.dim(`while main: ${busyPhase}`)
              }`,
              marginTop: 1,
            }),
          );

          const prompt = buildSideWorkerPrompt({
            question: currentQuestion,
            snapshot: {
              phase: busyPhase,
              ...(mainSlot?.detail !== undefined ? { mainDetail: mainSlot.detail } : {}),
              ...(elapsedSec !== undefined ? { elapsedSec } : {}),
            },
            recentHistory: history,
          });

          let answer = "";
          try {
            // Finding 1 fix: same widened contract as the other two
            // `opts.makeAgentDeps` call sites in this file — pass the live
            // `slateSession` ref, not just `.dir`.
            const base = await opts.makeAgentDeps(currentSel, () => slateSession);
            // Read-only: never allow shell/mutations from a side worker.
            const tools = base.tools.filter((t) => t.definition.risk === "read");
            const sideDeps: AgentDeps = {
              ...base,
              tools,
              systemInstruction: buildSideWorkerSystemInstruction(currentSel.provider, currentSel.model),
              maxToolCalls: 4,
              idSeq: () => `${SIDE_WORKER_ID}-${base.idSeq()}`,
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
                  id: SIDE_WORKER_ID,
                  label: sideWorkerLabelText,
                  status: "running",
                  detail: name.length > 12 ? `${name.slice(0, 10)}…` : name,
                });
              },
              onToolResult: () => {
                fleet.upsert({ id: SIDE_WORKER_ID, label: sideWorkerLabelText, status: "running", detail: "waiting" });
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
            appendUserEcho(otui, r, transcript, {
              id: `side-a${uid++}`,
              line: body,
              marker: "◇",
              borderColor: getTheme().side,
              marginTop: 0,
            });
            fleet.upsert({
              id: SIDE_WORKER_ID,
              label: sideWorkerLabelText,
              status: sideQueue.length > 0 ? "running" : "done",
              detail: "answered",
            });
          } catch (cause) {
            const msg = cause instanceof Error ? cause.message : String(cause);
            transcript.add(
              new otui.TextRenderable(r, {
                id: `side-err${uid++}`,
                content: otui.t`${otui.red(`◇ ${sideWorkerLabelText} failed: ${msg}`)}`,
              }),
            );
            fleet.upsert({ id: SIDE_WORKER_ID, label: sideWorkerLabelText, status: "failed", detail: "error" });
          } finally {
            sideWorkerRunning = false;
            if (sideQueue.length > 0) {
              showSideQueueStatus();
              continue;
            }
            clearSideWorkerSlot();
          }
        }
      })();
    };

    // Run a submitted line: a slash command, an unknown-slash notice, a main turn,
    // or (when main is busy) an automatic side worker — no special command needed.
    const runLine = (line: string): void => {
      if (line.length === 0) {
        return;
      }
      const displayLine = summarizeSubmittedLine(line);
      // Reuses `/status`'s and `/flows`'s own single-source-of-truth command
      // matchers instead of a second, separately-maintained name list that
      // could silently drift from them.
      const isBusyReadonlyCommand = isSessionInfoCommand(line) || isFlowsCommand(line);

      // While main is in progress: control slash still works; anything else → side worker.
      // "In progress" is the chrome's own spinner state, which `startBusy` /
      // `stopBusy` below are the only things that move.
      if (chrome.isBusy()) {
        const command = findAgentCommand(line, "agent");
        if (command?.name === "/exit") {
          // SLATE-5 close trigger: shell exit (explicit command, while busy).
          void (async () => {
            await closeSlateSession(slateSession, mintTimestampAttemptId);
            r.off("theme_mode", onThemeMode);
            r.destroy();
          })();
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
              "(sees main status + recent context; read-only). /status и /flows still open info panels. /exit still works.\n",
          );
          return;
        }
        if (command?.name === "/interrupt") {
          if (mainTurnAbortController !== undefined && !mainTurnAbortController.signal.aborted) {
            mainTurnAbortController.abort();
            io.onSystem?.("◇ main turn interrupted.\n");
            return;
          }
          io.onSystem?.("◇ no active main turn to interrupt.\n");
          return;
        }
        if (command?.name === "/queue") {
          const parsed = parseQueueCommand(line.trim().split(/\s+/).slice(1).join(" "));
          if (parsed === undefined) {
            io.onSystem?.("◇ usage: /queue <remove|edit|force> [N]  (N = qN position, default 1)\n");
            return;
          }
          const index = parsed.position - 1;
          if (index < 0 || index >= mainQueue.length) {
            io.onSystem?.(`◇ queue: no item q${parsed.position}.\n`);
            return;
          }
          if (parsed.action === "remove") {
            removeMainQueue(index);
            io.onSystem?.(`◇ removed q${parsed.position} from the main queue.\n`);
            return;
          }
          if (parsed.action === "edit") {
            editMainQueue(index);
            io.onSystem?.(`◇ q${parsed.position} moved to the composer — edit and submit to re-queue at the same position.\n`);
            return;
          }
          forceMainQueue(index);
          return;
        }
        if (isBusyReadonlyCommand && isSessionInfoCommand(line)) {
          showSessionInfo();
          return;
        }
        if (isBusyReadonlyCommand && isFlowsCommand(line)) {
          showFlows();
          return;
        }
        // /new /resume /sessions /compact /model while busy: refuse (avoid racing main session).
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
        // Recipient selector: post the message to the MAIN queue (default) or
        // the read-only side-1 worker. Shown only while main is busy. `runLine`
        // is sync, so the async choice is run in a detached IIFE (choice is
        // synchronous UI; the callback below stays fire-and-forget).
        // AC5: a pending `/queue edit` re-queues at its ORIGINAL position on
        // the very next busy submit, skipping the recipient selector entirely
        // (the item is already committed to the main queue by definition).
        if (pendingQueueEdit !== undefined) {
          const edit = pendingQueueEdit;
          pendingQueueEdit = undefined;
          mainQueue = reinsertMainQueueItem(mainQueue, edit.at, {
            id: edit.id,
            question: line,
            displayQuestion: displayLine,
          });
          paintMainQueue();
          return;
        }
        void (async () => {
          const chosen = await showComposerChoice(otui, r, chrome.dock, {
            title: "Main agent is busy",
            subtitle: line,
            options: [
              { id: "main", label: "Main queue", description: "queue for the main agent; remove/edit/force later", recommended: true },
              { id: "side", label: "Side-1", description: "read-only answer, outside main history (as before)" },
            ],
            cancelId: "side",
          });
          if (chosen === "main") {
            const id = `mq${mainQueueSeq++}`;
            mainQueue.push({ id, question: line, displayQuestion: displayLine });
            paintMainQueue();
          } else {
            appendUserEcho(otui, r, transcript, {
              id: `side-q${uid++}`,
              line: displayLine,
              borderColor: getTheme().side,
              marginTop: 0,
            });
            spawnSideWorker(line, displayLine);
          }
        })();
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
      const command = findAgentCommand(line, "agent");
      if (command !== undefined) {
        if (command.name === "/exit") {
          // SLATE-5 close trigger: shell exit (explicit command).
          void (async () => {
            await closeSlateSession(slateSession, mintTimestampAttemptId);
            r.off("theme_mode", onThemeMode);
            r.destroy();
          })();
          return;
        }
        if (command.name === "/clear" || command.name === "/new") {
          // SLATE-5 close trigger: `/new`/`/clear` abandon the current session
          // dir for a fresh one — archive whatever slate it was building
          // before switching away (parity with runAgentRepl in shell.ts).
          void (async () => {
            await closeSlateSession(slateSession, mintTimestampAttemptId);
            // Creates a NEW session id; previous transcript stays on disk for /resume.
            startNewSession();
            slateSession = { dir: liveSession.dir, cwd: sessionCwd, opened: false };
            // The old session's subagents (sidebar list + inspector) belong to
            // the transcript that just left — a fresh session starts with none.
            sessions.clear();
            deps.resetSubagentBudget?.();
            io.onSystem?.(
              `New session ${shortSessionId(liveSession.summary.id)} (previous kept on disk · /resume)\n`,
            );
          })();
          return;
        }
        if (command.name === "/goal") {
          // SLATE-15 (flow 161, AC1/AC2): deterministic slate-open entry point.
          void (async () => {
            await runGoalCommand({
              raw: line.slice(command.name.length).trim(),
              cwd: sessionCwd,
              io,
              deps,
              history,
              slateSession,
              mintAttemptId: mintTimestampAttemptId,
            });
          })();
          return;
        }
        if (command.name === "/resume" || command.name === "/sessions") {
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
          nextArchiveIndex = history.length;
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
        if (command.name === "/search-provider") {
          void (async () => {
            const args = parseSearchProviderArgs(line.slice(16));
            const all = searchProviderController.configurable();
            if (args.providerId === undefined) {
              io.onSystem?.(
                describeSearchProviderList("Search providers (use /search-provider <id> [key=...]):", all),
              );
              return;
            }
            const descriptor = all.find((candidate) => candidate.id === args.providerId);
            if (descriptor === undefined) {
              io.onSystem?.(`Unknown provider '${args.providerId}'. Available: ${all.map((provider) => provider.id).join(", ")}\n`);
              return;
            }
            const providerId: SearchProviderId = descriptor.id;
            searchProviderController.configure(
              providerId,
              { ...descriptor.defaults, ...args.fields },
              args.credential,
            );
            const tested = await searchProviderController.test(providerId);
            if (!tested.ok) {
              const reason = tested.reason === "missing-credential" ? "missing credential" : "connection validation failed";
              io.onSystem?.(
                `Configured '${providerId}' but it is not connected yet: ${reason}. Run /search-provider ${providerId} key=<value> to re-test.\n`,
              );
              return;
            }
            io.onSystem?.(
              `Configured and tested '${providerId}' successfully. Use /search-connect ${providerId} to make it active.\n`,
            );
          })();
          return;
        }
        if (command.name === "/search-connect") {
          void (async () => {
            const args = parseSearchProviderArgs(line.slice(15));
            const providerId = args.providerId;
            if (providerId === undefined) {
              const selectable = searchProviderController.selectable();
              io.onSystem?.(
                describeSearchProviderList("Connected search providers (use /search-connect <id> to select):", selectable),
              );
              if (selectable.length === 0) {
                io.onSystem?.("No connected search providers found. Run /search-provider first.\n");
              }
              return;
            }
            const normalizedProviderId = searchProviderController.configurable().find((candidate) => candidate.id === providerId)?.id;
            if (normalizedProviderId === undefined) {
              io.onSystem?.(`Unknown provider '${providerId}'.\n`);
              return;
            }
            const result = await searchProviderController.select(normalizedProviderId);
            if (!result.ok) {
              if (result.reason === "not-configured") {
                io.onSystem?.(`Cannot select '${providerId}': provider is not configured.\n`);
              } else if (result.reason === "not-connected") {
                io.onSystem?.(
                  `Cannot select '${providerId}': provider is not connected (run /search-provider ${providerId} <params> to test).\n`,
                );
              } else {
                io.onSystem?.(`Cannot select '${providerId}': ${result.reason}.\n`);
              }
              return;
            }
            io.onSystem?.(`Search provider '${providerId}' selected.\n`);
          })();
          return;
        }
        // `/think` and `/expand` TOGGLE the newest matching block in place
        // (flow 109 expanded it; flow 115 made it reversible — a one-way expand
        // leaves a screenful of reasoning with no advertised way back). `/copy`
        // puts a block's retained payload on the clipboard (AC6).
        if (command.name === "/think") {
          if (toggleNewestBlock("thought") === undefined) {
            io.onSystem?.("No reasoning yet.\n");
          }
          return;
        }
        if (command.name === "/expand") {
          if (toggleNewestBlock("output") === undefined && toggleNewestBlock() === undefined) {
            io.onSystem?.("Nothing to expand — no tool output yet.\n");
          }
          return;
        }
        if (isSessionInfoCommand(command.name)) {
          showSessionInfo();
          return;
        }
        if (isFlowsCommand(command.name)) {
          showFlows();
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
        if (command.name === "/theme") {
          const arg = line.trim().split(/\s+/).slice(1).join(" ").trim();
          if (arg.length > 0) {
            const next = parseThemeId(arg);
            if (next === undefined) {
              io.onSystem?.(`Unknown theme '${arg}'.\n${formatThemeList(getThemeId())}`);
              return;
            }
            applyThemeId(next, r.themeMode);
            persistThemeId(next);
            chrome.showToast(`Theme: ${themeLabel(next)}`);
            return;
          }
          openThemePicker(otui, chrome, {
            current: getThemeId(),
            mode: r.themeMode,
            renderer: r,
            ...inspectorKeys,
            onApply: (id) => {
              applyThemeId(id, r.themeMode);
              persistThemeId(id);
              chrome.showToast(`Theme: ${themeLabel(id)}`);
            },
          });
          return;
        }
        if (command.name === "/mode") {
          const modeArgs = line.trim().split(/\s+/).slice(1).filter((p) => p.length > 0);
          const wanted = modeArgs[0] ?? "";
          const saveFlag = modeArgs.includes("save");

          const applyMode = async (next: PermissionMode): Promise<void> => {
            if (next === "auto") {
              // `auto` skips confirmation for EVERY action, including
              // destructive ones (only credential-touching commands still
              // ask — a hard floor no mode lifts). One-time explicit
              // confirmation before it takes effect, never a silent flip.
              chrome.hideMenu();
              const confirmId = await chrome.withOverlay(() =>
                showComposerChoice(otui, r, chrome.dock, {
                  title: "Switch to auto mode?",
                  subtitle:
                    "Skips confirmation for EVERY action, including destructive commands. " +
                    "Only credential-touching commands still ask.",
                  cancelId: "cancel",
                  options: [
                    { id: "confirm", label: "Confirm", description: "I understand the risk" },
                    { id: "cancel", label: "Cancel", description: "Keep the current mode", recommended: true },
                  ],
                }),
              );
              input.focus();
              if (confirmId !== "confirm") {
                chrome.showToast("Cancelled — mode unchanged.");
                return;
              }
            }
            permissionMode = next;
            chrome.showToast(`Permission mode: ${next}`);
            if (saveFlag) {
              const saved = setProjectPermissionMode(sessionCwd, next);
              chrome.showToast(saved ? "Saved as this project's default." : "Could not save the project default.");
            }
          };

          if (wanted === "clear") {
            setProjectPermissionMode(sessionCwd, undefined);
            chrome.showToast(`Cleared project default. Session stays on: ${permissionMode}`);
            return;
          }
          if (wanted.length > 0) {
            if (!isPermissionMode(wanted)) {
              io.onSystem?.(`Unknown mode '${wanted}'. Choose one of: ${PERMISSION_MODES.join(", ")}\n`);
              return;
            }
            void applyMode(wanted);
            return;
          }
          // No arg: a picker, same shape as `/theme`'s.
          const stored = getProjectPermissionMode(sessionCwd);
          chrome.hideMenu();
          void (async () => {
            const id = await chrome.withOverlay(() =>
              showComposerChoice(otui, r, chrome.dock, {
                title: `Permission mode (current: ${permissionMode})`,
                subtitle: stored !== undefined ? `Project default: ${stored}` : "No project default set.",
                cancelId: permissionMode,
                options: PERMISSION_MODES.map((m) => ({
                  id: m,
                  label: m,
                  description: MODE_PICKER_DESCRIPTIONS[m],
                  recommended: m === permissionMode,
                })),
              }),
            );
            input.focus();
            if (isPermissionMode(id) && id !== permissionMode) {
              await applyMode(id);
            }
          })();
          return;
        }
        if (command.name === "/model") {
          void (async () => {
            const detected = opts.redetect !== undefined ? await opts.redetect() : opts.detected;
            const prov = detected.find((d) => d.name === currentSel.provider);
            // Registered providers fetch their live, filterable list; others use detected.
            const models = prov !== undefined ? await modelsForPicker(prov) : [];
            const chosen = await chrome.withOverlay(() => pickModelInTui(otui, r, models));
            if (chosen !== undefined) {
              await switchTo(
                currentSel.baseUrl === undefined
                  ? { provider: currentSel.provider, model: chosen }
                  : { provider: currentSel.provider, model: chosen, baseUrl: currentSel.baseUrl },
              );
              // SLATE-2a `/model`-switch Anchors auto-inject (AC4). `switchTo`
              // already reassigned `currentSel` above, so it carries the NEW
              // provider/model here. Wrapped so a slate read/write failure
              // degrades silently rather than aborting a model switch that
              // already succeeded (mirrors the `closeSlateSession` close
              // triggers elsewhere in this file, which are similarly
              // best-effort bookkeeping around a real user-visible action).
              try {
                await applyRuntimeSwitchToSlate({
                  slateSession,
                  runtime: { provider: currentSel.provider, model: currentSel.model },
                  history,
                  // Review finding 6: without this, the pushed Anchors-block
                  // message is not archived/persisted until some UNRELATED
                  // later event happens to fire `onHistoryChange`.
                  onHistoryChange: io.onHistoryChange,
                });
              } catch (err) {
                io.onSystem?.(
                  `slate anchors update failed (ignored): ${err instanceof Error ? err.message : String(err)}\n`,
                );
              }
            } else {
              input.focus();
            }
          })();
          return;
        }
        if (command.name === "/interrupt") {
          io.onSystem?.("◇ no active main turn to interrupt.\n");
          return;
        }
        if (command.name === "/queue") {
          // The queue only exists while main is busy (FIFO-drain empties it
          // the instant a turn frees up), so outside a busy turn it is empty.
          io.onSystem?.("◇ main queue is empty.\n");
          return;
        }
        if (command.name === "/connect" || command.name === "/provider") {
          void (async () => {
            const detected = opts.redetect !== undefined ? await opts.redetect() : opts.detected;
            const ns = await chrome.withOverlay(() =>
              command.name === "/connect"
                ? selectProviderModelInTui(otui, r, detected, { onlyConnected: true, env: process.env })
                : selectProviderModelInTui(otui, r, detected),
            );
            if (ns !== undefined) {
              await switchTo(ns);
            } else {
              if (command.name === "/connect") {
                chrome.showToast("No connected providers found. Run /provider to configure one first.");
              }
              input.focus();
            }
          })();
          return;
        }
        io.onSystem?.(helpText()); // /help
        return;
      }
      if (line.startsWith("/")) {
        // A real command belonging to the OTHER mode (`/models`, `/provider`)
        // says so; only a genuinely unknown token is "unknown" (S4 parity with
        // the readline surfaces).
        io.onSystem?.(describeUnavailableCommand(line, "agent") ?? `Unknown command: ${line}\n`);
        io.onSystem?.(helpText());
        return;
      }
      appendUserEcho(otui, r, transcript, { id: `ub${uid++}`, line: displayLine });
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
        // The busy flag is `startBusy`/`stopBusy` now (the chrome owns it); the
        // first statement of the IIFE below runs synchronously, so the shell is
        // marked busy before `runLine` returns, exactly as it was.
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

            const choice = await pickWikiEnrichMode(otui, r, chrome.dock, {
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
            // Belt and braces: the paths above are believed to have stopped the
            // spinner already, but `stopBusy()` is idempotent and a missed one
            // leaves a live 120ms interval painting over an idle shell.
            stopBusy();
            focusComposer(); // never steal focus from an active block-nav mode (R3)
          }
        })();
        return;
      }

      // Clear enrich/page workers only — keep concurrent side workers visible.
      fleet.clearMatching((w) => w.id !== MAIN_AGENT_ID && !isSideWorkerId(w.id));
      // A fresh turn starts with a clean subagent sidebar (and a fresh child
      // tool-call/runtime budget) instead of piling this turn's spawns on top
      // of whatever the previous turn(s) left behind.
      sessions.clear();
      deps.resetSubagentBudget?.();
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
      const controller = new AbortController();
      mainTurnAbortController = controller;
      void runAgentTurn(io, deps, history, line, {
        signal: controller.signal,
        ...(slateSession !== undefined ? { slateSession } : {}),
      }).finally(() => {
        mainTurnAbortController = undefined;
        const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
        stopBusy();
        setMainAgent(turnFailed ? "failed" : "done", turnFailed ? "error" : "idle");
        try {
          flushSessionCheckpoint();
        } catch {
          // best-effort persist
        }
        transcript.add(
          new otui.TextRenderable(r, { id: `w${uid++}`, content: otui.t`${otui.dim(`worked for ${secs}s`)}`, marginTop: 1 }),
        );
        // No exact provider usage → show an estimated context size (never stuck at 0).
        if (!hasExactUsage) {
          const est = estimateContextTokens(history);
          chrome.setHeaderMeta(`~${fmtTokens(est)}`);
          sbContext.content = otui.t`${otui.dim(`~${est.toLocaleString()} tokens (est)`)}`;
        }
        focusComposer(); // never steal focus from an active block-nav mode (R3)
        // A forced item (AC6) wins over FIFO order — it is the reason the
        // turn just settled. Otherwise FIFO-drain the head of the main queue
        // (AC7), once the current one has fully settled (stopBusy/setMainAgent
        // already ran).
        if (priorityMainQuestion !== undefined) {
          const next = priorityMainQuestion;
          priorityMainQuestion = undefined;
          runLine(next.question);
        } else if (mainQueue.length > 0) {
          const next = mainQueue.shift();
          paintMainQueue();
          if (next !== undefined) runLine(next.question);
        }
      });
    };

    // --- block navigation mode (Ctrl+O … Esc) — flow 109 D-3 ----------------
    // The mode itself is `createBlockNavController` (transcript-blocks.ts); all
    // that is left here is subscribing it. Registered through the `onKeypress`
    // wrapper rather than by reaching for the private `_internalKeyInput` symbol
    // directly (risk R2); the chrome's `/`-menu router is the other consumer.
    onKeypress(r, (key) => {
      nav.handleKey(key);
    });

    // Both a composer Enter and a `/`-menu selection arrive here: the chrome has
    // already trimmed the line, cleared the composer and closed the dropdown.
    chrome.onSubmit((line) => {
      runLine(line);
    });

    await done;
    return true;
  } catch {
    return false;
  } finally {
    await herdr.release(); // hand the pane back to herdr (no-op outside herdr)
    try {
      renderer?.destroy();
    } catch {
      // best-effort teardown
    }
  }
}
