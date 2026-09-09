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
// port/`Promise.race`/timeout shape), not a live multi-round
// tool-calling loop from the model and not a hardcoded text-similarity
// heuristic. Fails CLOSED on no port, no credential, timeout, or an
// unparseable response — an unresolved `workspaceId` simply retries at the next
// action-intent open; it never blocks or degrades the user's actual turn.
//
// AFC-19 (flow 239, phase 7): this module used to reach the model through
// `runModelTurn` (`../harness/provider/single-turn`) and the workspace store
// through `workspaceCreateTool`/`workspaceListTool`
// (`../harness/tool/builtin/workspace-lifecycle-tool`). Between them those two
// imports put the whole provider registry — six providers, `make-provider`, the
// SSE reader, the policy engine and `src/commands/providers.ts` — into the
// public SAC facade's shipped graph (measured; see `core-graph.test.ts`). Both
// are gone:
//   * the model turn is now an INJECTED port (`./model-turn-port.ts`), and
//   * the two workspace calls go straight to SAC's own `WorkspaceService`
//     (`./workspace-service.ts`) with the same constructor arguments and the
//     same call arguments the tool used — the tool is a JSON wrapper around
//     exactly this, and `workspace-resolve` never passed it a `getSessionDir`,
//     so its slate-binding branch never ran from here.
// Nothing moved directories; the client-zone modules are simply no longer named.
import { randomUUID } from "node:crypto";
import { redactSensitiveText } from "../security/redact";
import { WorkspaceService, localWorkspaceAuthorizationServer, newWorkspaceId } from "./workspace-service";
import {
  resolveModelTurnPort,
  warnModelTurnUnavailable,
  type ModelTurnOutcome,
  type ModelTurnPort,
} from "./model-turn-port";

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
   * `.modelId` at the real call site). Passed through to the model-turn port
   * verbatim so this judgment reuses the exact credential the session is
   * already authenticated with — never the port's own independent
   * auto-selection, which could silently pick a DIFFERENT provider than the one
   * the user actually selected for this session. Omitted only by tests that
   * inject their own `modelTurn`.
   */
  provider?: string;
  model?: string;
  env?: Record<string, string | undefined>;
  /**
   * The injected single-turn capability (`./model-turn-port.ts`). Core holds no
   * provider registry of its own (AFC-19): without this — and without a
   * process-wide default registered via `setModelTurnPort` — the judgment
   * REFUSES with `no_model_turn` rather than guessing.
   */
  modelTurn?: ModelTurnPort;
  modelTurnTimeoutMs?: number;
};

export type ResolveOrCreateResult =
  | { ok: true; workspaceId: string; action: "bound-existing" | "created" }
  /**
   * `no_model_turn` (no capability was supplied to core at all) is deliberately
   * NOT folded into `no_credential` (a supplied capability reported it has no
   * key): the two have different fixes — wire the client, versus add a key —
   * and every caller so far only reads `ok`, so widening this union is safe.
   */
  | { ok: false; reason: "no_credential" | "no_model_turn" | "ambiguous" | "error" };

type ExistingWorkspace = { id: string; title: string; status: string };

/**
 * SAC's own workspace store, constructed exactly as
 * `harness/tool/builtin/workspace-lifecycle-tool.ts` constructs it — same
 * authorization server, same strict guard, same offline policy revision — so
 * moving off that tool changed the caller, not the behaviour.
 */
function workspaceStore(cwd: string): WorkspaceService {
  return new WorkspaceService({
    workspaceRoot: cwd,
    authorizationServer: localWorkspaceAuthorizationServer(),
    strictGuard: { mode: "strict", availability: "available", decision: "pass", policyRevision: "local-offline-v1" },
  });
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

  const store = workspaceStore(input.cwd);

  // AC-24: the list is ALWAYS the first step, unconditionally — no path below
  // can bind an id without this call having happened first.
  let existing: ExistingWorkspace[];
  try {
    const listed = await store.list({ request: undefined, requestCorrelationId: randomUUID(), includeArchived: false });
    existing = listed
      .filter((w) => w.status === "active")
      .map((w) => ({ id: w.id, title: w.title, status: w.status }));
  } catch {
    return { ok: false, reason: "error" };
  }

  // Nothing to compare against — create directly, no model call needed (no
  // judgment is possible or useful over an empty list).
  if (existing.length === 0) {
    return createWorkspace(store, topicHint);
  }

  const knownIds = new Set(existing.map((w) => w.id));
  const system =
    "You are deciding whether a new task belongs in an EXISTING team workspace or needs a NEW one. " +
    "Respond with EXACTLY one line: `BIND <id>` (an id copied EXACTLY from the list below) if an " +
    "existing workspace already covers this topic, or `CREATE <short title>` if none do. Never invent " +
    "an id that is not in the list below.";
  const user = `--- new task ---\n${topicHint}\n\n--- existing workspaces ---\n${existing.map((w) => `${w.id}: ${w.title}`).join("\n")}`;

  // The judgment needs a model. Core does not have one (AFC-19) — it has a
  // seam. No port supplied means REFUSE, loudly and by its own name: never a
  // silent "ambiguous", which would read like a model that answered unclearly.
  const modelTurn = resolveModelTurnPort(input.modelTurn);
  if (modelTurn === undefined) {
    warnModelTurnUnavailable("workspace-resolve");
    return { ok: false, reason: "no_model_turn" };
  }

  let modelResult: ModelTurnOutcome | undefined;
  const modelTurnTimeoutMs = input.modelTurnTimeoutMs ?? DEFAULT_MODEL_TURN_TIMEOUT_MS;
  const turn = modelTurn({
    system,
    user,
    requestId: "workspace-resolve",
    maxOutputTokens: 64,
    ...(input.provider !== undefined ? { provider: input.provider } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.env !== undefined ? { env: input.env } : {}),
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

  return createWorkspace(store, decision.title);
}

/**
 * Create one workspace and report it, mirroring `workspace_create`'s own
 * arguments (a fresh `newWorkspaceId()`, no `component`). A store failure is an
 * `error` result, exactly as the tool's `isError` output was before.
 */
async function createWorkspace(store: WorkspaceService, title: string): Promise<ResolveOrCreateResult> {
  try {
    const workspace = await store.create({
      request: undefined,
      requestCorrelationId: randomUUID(),
      id: newWorkspaceId(),
      title,
    });
    return { ok: true, workspaceId: workspace.id, action: "created" };
  } catch {
    return { ok: false, reason: "error" };
  }
}
