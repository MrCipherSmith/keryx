// SLATE-16: workspace resolve-or-create (flow 166, Phase 3).
//
// The FIRST real integration between a session's Slate opening and Shared
// Agent Context: when a slate opens with no `workspaceId` bound yet (a bare
// `/goal` or the default action-intent open — see `agent.ts`/
// `goal-command.ts`'s call sites), this decides whether the session's work
// belongs in an EXISTING team workspace or needs a NEW one, and binds it —
// without asking the user, matching the explicit design intent that this be
// fully autonomous.
//
// Scope note (this phase): trigger point (a) from the spec table ("flow
// creation") is NOT wired here. `slate.course.flowRef` has no write path
// anywhere in this codebase yet — nothing ever sets it, only
// `slate-course.ts`/`session-wrap-up.ts` read it — so "resolve at flow
// creation" has no real flow↔slate linkage to hang off yet, and building one
// is out of scope for this phase. Only trigger point (b), slate-open without
// an already-bound `workspaceId`, is implemented — which already covers both
// sub-cases the spec groups under it (bare `/goal` and the default
// action-intent open).
//
// AC-24's evidence requirement ("no code path may bind an id the model
// asserted without evidence of having listed existing workspaces first") is
// satisfied structurally: `workspaceListTool` (SLATE-19) is ALWAYS the first
// step below, unconditionally, before any bind or create decision — the
// model is never asked to name a workspace id it hasn't been shown.
//
// "No new similarity/embedding service — same tool-calling judgment pattern
// as ask_user/spawn_subagent" (spec): the judgment itself is delivered via
// ONE bounded, structured single-shot model turn (mirrors
// `machine-wrap-up.ts`'s `resolveMachineWrapUp` — same
// `runModelTurn`/`Promise.race`/timeout shape), not a live multi-round
// tool-calling loop from the model and not a hardcoded text-similarity
// heuristic. Fails CLOSED on no credential, timeout, or an unparseable
// response — an unresolved `workspaceId` simply retries at the next
// action-intent open; it never blocks or degrades the user's actual turn.
import { redactSensitiveText } from "../security/redact";
import { workspaceCreateTool, workspaceListTool } from "../harness/tool/builtin/workspace-lifecycle-tool";
import { runModelTurn, type ModelTurnResult, type ProviderFactory } from "../harness/provider/single-turn";

/**
 * Shorter than `machine-wrap-up.ts`'s 30s: this runs at the START of a turn,
 * synchronously blocking the user's actual request, not at a natural
 * completion point — a slow judgment must give up quickly rather than make
 * every first message in a session feel sluggish.
 */
const DEFAULT_MODEL_TURN_TIMEOUT_MS = 15_000;

/** Workspace title/topic text is truncated to this before it becomes either
 * a fallback workspace title or model-prompt context — generous for a
 * one-line topic, bounded against an unbounded user message. */
const TOPIC_HINT_MAX_LENGTH = 200;

export type ResolveOrCreateInput = {
  cwd: string;
  /** The text that triggered this open — the user's message, or the /goal
   * text. Redacted and truncated before use as judgment context or as a
   * fallback workspace title. */
  topicHint: string;
  /**
   * The session's ALREADY-ACTIVE provider/model (`AgentDeps.providerId`/
   * `.modelId` at the real call site). Passed through to `runModelTurn`
   * verbatim so this judgment reuses the exact credential the session is
   * already authenticated with — never `runModelTurn`'s own independent
   * `resolveAutoProvider` auto-selection, which could silently pick a
   * DIFFERENT provider than the one the user actually selected for this
   * session. Omitted only by tests that inject their own `providerFactory`.
   */
  provider?: string;
  model?: string;
  env?: Record<string, string | undefined>;
  providerFactory?: ProviderFactory;
  modelTurnTimeoutMs?: number;
};

export type ResolveOrCreateResult =
  | { ok: true; workspaceId: string; action: "bound-existing" | "created" }
  | { ok: false; reason: "no_credential" | "ambiguous" | "error" };

type ExistingWorkspace = { id: string; title: string; status: string };

function parseWorkspaceList(output: string): ExistingWorkspace[] {
  const parsed = JSON.parse(output) as Array<{ id: string; title: string; status: string }>;
  return parsed.map((w) => ({ id: w.id, title: w.title, status: w.status }));
}

/**
 * First `BIND <id>`/`CREATE <title>` line wins; `id` must be one of
 * `knownIds` (the exact list just shown to the model) — a hallucinated id is
 * treated as no decision at all (AC-24: never bind an unlisted id), not
 * silently coerced to the nearest real one.
 */
function parseDecision(
  text: string,
  knownIds: ReadonlySet<string>,
): { action: "bind"; workspaceId: string } | { action: "create"; title: string } | undefined {
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    const bind = line.match(/^BIND\s+(\S+)$/i);
    if (bind?.[1] !== undefined && knownIds.has(bind[1])) return { action: "bind", workspaceId: bind[1] };
    const create = line.match(/^CREATE\s+(.+)$/i);
    if (create?.[1] !== undefined && create[1].trim().length > 0) return { action: "create", title: create[1].trim() };
  }
  return undefined;
}

export async function resolveOrCreateWorkspace(input: ResolveOrCreateInput): Promise<ResolveOrCreateResult> {
  const topicHint = redactSensitiveText(input.topicHint).trim().slice(0, TOPIC_HINT_MAX_LENGTH) || "Untitled session";

  // AC-24: workspace_list is ALWAYS the first step, unconditionally — no
  // path below can bind an id without this call having happened first.
  const listed = await workspaceListTool(input.cwd).invoke({});
  if (listed.isError) return { ok: false, reason: "error" };
  let existing: ExistingWorkspace[];
  try {
    existing = parseWorkspaceList(listed.output).filter((w) => w.status === "active");
  } catch {
    return { ok: false, reason: "error" };
  }

  // Nothing to compare against — create directly, no model call needed (no
  // judgment is possible or useful over an empty list).
  if (existing.length === 0) {
    const created = await workspaceCreateTool(input.cwd).invoke({ title: topicHint });
    if (created.isError) return { ok: false, reason: "error" };
    const { id } = JSON.parse(created.output) as { id: string };
    return { ok: true, workspaceId: id, action: "created" };
  }

  const knownIds = new Set(existing.map((w) => w.id));
  const system =
    "You are deciding whether a new task belongs in an EXISTING team workspace or needs a NEW one. " +
    "Respond with EXACTLY one line: `BIND <id>` (an id copied EXACTLY from the list below) if an " +
    "existing workspace already covers this topic, or `CREATE <short title>` if none do. Never invent " +
    "an id that is not in the list below.";
  const user = `--- new task ---\n${topicHint}\n\n--- existing workspaces ---\n${existing.map((w) => `${w.id}: ${w.title}`).join("\n")}`;

  let modelResult: ModelTurnResult | undefined;
  const modelTurnTimeoutMs = input.modelTurnTimeoutMs ?? DEFAULT_MODEL_TURN_TIMEOUT_MS;
  const turn = runModelTurn({
    system,
    user,
    requestId: "workspace-resolve",
    maxOutputTokens: 64,
    ...(input.provider !== undefined ? { provider: input.provider } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.env !== undefined ? { env: input.env } : {}),
    ...(input.providerFactory !== undefined ? { providerFactory: input.providerFactory } : {}),
  }).then((result) => {
    modelResult = result;
    return "done" as const;
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), modelTurnTimeoutMs);
  });
  let raceOutcome: "done" | "timeout";
  try {
    raceOutcome = await Promise.race([turn, expired]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }

  if (raceOutcome === "timeout") {
    // Abandoned model-turn promise — safely ignored, never an unhandled
    // rejection (mirrors machine-wrap-up.ts's identical `void turn.catch`).
    void turn.catch(() => {});
    return { ok: false, reason: "ambiguous" };
  }

  const result = modelResult!;
  if (!result.credentialAvailable && result.text.trim().length === 0) {
    return { ok: false, reason: "no_credential" };
  }

  const decision = parseDecision(result.text, knownIds);
  if (decision === undefined) return { ok: false, reason: "ambiguous" };

  if (decision.action === "bind") {
    return { ok: true, workspaceId: decision.workspaceId, action: "bound-existing" };
  }

  const created = await workspaceCreateTool(input.cwd).invoke({ title: decision.title });
  if (created.isError) return { ok: false, reason: "error" };
  const { id } = JSON.parse(created.output) as { id: string };
  return { ok: true, workspaceId: id, action: "created" };
}
