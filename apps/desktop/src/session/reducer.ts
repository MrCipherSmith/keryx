import type {
  AvailableCommand,
  CommandView,
  ConfigOption,
  ContentBlock,
  PlanEntry,
  SessionFlags,
  SessionInfo,
  SessionModeState,
  SessionUpdate,
  ToolCallContent,
  ToolCallFields,
  ToolCallStatus,
  ToolKind,
} from "../acp/types";
import type { TaskInfo } from "../acp/providers";
import { applySubagentEvent, runningSubagents, type Subagent } from "./activity";

export type Item =
  | { kind: "user"; id: number; text: string; messageId?: string | null }
  | { kind: "agent"; id: number; text: string; messageId?: string | null }
  | { kind: "thought"; id: number; text: string; messageId?: string | null }
  | {
      kind: "tool";
      id: number;
      toolCallId: string;
      title: string;
      toolKind: ToolKind;
      status: ToolCallStatus;
      content: ToolCallContent[];
      rawInput?: unknown;
      rawOutput?: unknown;
      autoApproved: boolean;
      /** ms timestamps from the client clock, for a derived duration. */
      startedAt: number;
      endedAt: number | null;
    }
  | { kind: "notice"; id: number; level: "info" | "warn" | "error"; text: string }
  | DelegateResultItem
  | CommandItem;

/**
 * A `/delegate` terminal run finished a turn: its answer as keryx put it in the parent's history, shown
 * as a collapsed card. Untrusted text (rendered verbatim, never as markup). Client-only, like a command card.
 */
export interface DelegateResultItem {
  kind: "delegate";
  id: number;
  runId: string;
  agentId: string;
  turn: number;
  text: string;
}

/**
 * The card a slash command leaves in the transcript. Client-only: it is never sent to the model and a
 * session/load replay does not bring it back.
 */
export interface CommandItem {
  kind: "command";
  id: number;
  /** The command line as shown (a secret field's value is already masked). */
  line: string;
  text: string;
  /** keryx (or the app, while a turn runs) refused the command: shown as a notice. */
  refused: boolean;
  view: CommandView | null;
}

/** A prompt typed while the turn runs; sent in order when it ends. */
export interface QueuedPrompt {
  id: number;
  text: string;
}

export interface Banner {
  id: number;
  level: "info" | "warn" | "error";
  text: string;
}

export interface TokenPair {
  inputTokens: number;
  outputTokens: number;
}

export interface Usage {
  /** This model call's input + output tokens. */
  used: number;
  /** Context window; 0 when unknown. */
  size: number;
  cost?: { amount: number; currency: string } | null;
  call: TokenPair | null;
  turn: TokenPair | null;
  session: TokenPair | null;
}

export type Phase = "starting" | "ready" | "exited";

// ---- one session ----------------------------------------------------------

/** Everything the window keeps for one session it holds (or held: see `held`). */
export interface ConvState {
  sessionId: string;
  items: Item[];
  nextId: number;
  busy: boolean;
  /** Its session/load replay is running. */
  replaying: boolean;
  commands: AvailableCommand[];
  modes: SessionModeState | null;
  configOptions: ConfigOption[];
  plan: PlanEntry[];
  usage: Usage | null;
  title: string | null;
  /** Prompts waiting for the running turn to end. Client-side only. */
  queue: QueuedPrompt[];
  /** keryx holds it on this connection. False after `_keryx/session_released` or a lost connection: read-only until reloaded. */
  held: boolean;
  /** Why it is not held: keryx's idle cap released it, or the connection was lost. Null while held. */
  lostReason: LostReason | null;
  /** Subagents of this session, kept until a new session (not cleared per turn). Not persisted: empty after session/load. */
  subagents: readonly Subagent[];
  /** Background tasks, as last listed by keryx. */
  tasks: readonly TaskInfo[];
}

export type LostReason = "idle-cap" | "connection";

/** What the window says about a session it no longer holds. */
export function lostText(reason: LostReason | null): string {
  return reason === "connection" ? "The connection to keryx was lost" : "keryx closed this idle session to save memory";
}

const NO_SUBAGENTS: readonly Subagent[] = [];
const NO_TASKS: readonly TaskInfo[] = [];

export function newConv(
  sessionId: string,
  opts: { replaying: boolean; modes?: SessionModeState | null; configOptions?: ConfigOption[] | null },
): ConvState {
  return {
    sessionId,
    items: [],
    nextId: 1,
    busy: false,
    replaying: opts.replaying,
    commands: [],
    modes: opts.modes ?? null,
    configOptions: opts.configOptions ?? [],
    plan: [],
    usage: null,
    title: null,
    queue: [],
    held: true,
    lostReason: null,
    subagents: NO_SUBAGENTS,
    tasks: NO_TASKS,
  };
}

export interface QueuedUpdate {
  update: SessionUpdate;
  at: number;
}

/** A session/update with the session it names. */
export interface RoutedUpdate extends QueuedUpdate {
  sessionId: string;
}

export function blockText(block: ContentBlock): string {
  switch (block.type) {
    case "text":
      return typeof block.text === "string" ? block.text : "";
    case "image":
      return "\n[image]\n";
    case "resource_link":
      return `\n[${String((block as { name?: unknown }).name ?? "resource")}]\n`;
    case "resource": {
      const r = (block as { resource?: { uri?: string } }).resource;
      return `\n[${r?.uri ?? "resource"}]\n`;
    }
    default:
      return "";
  }
}

/**
 * The update helpers below mutate a draft: a shallow copy of the conversation whose `items` array is
 * already a private copy. Item objects themselves are never mutated (memoised rows compare them).
 */
function appendChunk(
  d: ConvState,
  kind: "user" | "agent" | "thought",
  text: string,
  messageId: string | null | undefined,
): boolean {
  if (text === "") return false;
  const items = d.items;
  const last = items[items.length - 1];
  if (last && last.kind === kind && (messageId == null || last.messageId == null || last.messageId === messageId)) {
    items[items.length - 1] = { ...last, text: last.text + text, messageId: last.messageId ?? messageId };
    return true;
  }
  items.push({ kind, id: d.nextId, text, messageId });
  d.nextId += 1;
  return true;
}

function isAutoApproved(meta: unknown): boolean {
  const keryx = (meta as { keryx?: { autoApproved?: unknown } } | undefined)?.keryx;
  return keryx?.autoApproved === true;
}

export function findTool(items: readonly Item[], toolCallId: string): number {
  // Updates almost always touch a recent call: search from the end.
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it?.kind === "tool" && it.toolCallId === toolCallId) return i;
  }
  return -1;
}

function upsertTool(d: ConvState, u: ToolCallFields, isNew: boolean, at: number): true {
  const idx = findTool(d.items, u.toolCallId);
  const prev = idx >= 0 ? (d.items[idx] as Extract<Item, { kind: "tool" }>) : null;
  const next: Extract<Item, { kind: "tool" }> = {
    kind: "tool",
    id: prev?.id ?? d.nextId,
    toolCallId: u.toolCallId,
    title: u.title ?? prev?.title ?? u.toolCallId,
    toolKind: u.kind ?? prev?.toolKind ?? "other",
    status: u.status ?? prev?.status ?? (isNew ? "pending" : "in_progress"),
    content: u.content ?? prev?.content ?? [],
    rawInput: u.rawInput !== undefined ? u.rawInput : prev?.rawInput,
    rawOutput: u.rawOutput !== undefined ? u.rawOutput : prev?.rawOutput,
    autoApproved: (prev?.autoApproved ?? false) || isAutoApproved(u._meta),
    startedAt: prev?.startedAt ?? at,
    endedAt: prev?.endedAt ?? null,
  };
  // A replayed call has no real timing; leave its duration unknown.
  if (!d.replaying && next.endedAt === null && (next.status === "completed" || next.status === "failed")) next.endedAt = at;
  if (prev) {
    d.items[idx] = next;
    return true;
  }
  d.items.push(next);
  d.nextId += 1;
  return true;
}

interface ChunkUpdate {
  content: ContentBlock;
  messageId?: string | null;
}

function tokenPair(v: unknown): TokenPair | null {
  const o = v as { inputTokens?: unknown; outputTokens?: unknown } | null | undefined;
  if (!o || typeof o.inputTokens !== "number" || typeof o.outputTokens !== "number") return null;
  return { inputTokens: o.inputTokens, outputTokens: o.outputTokens };
}

/**
 * Apply one update to the draft. False only when the update certainly changed nothing; the branches
 * that replace a whole field (plan, commands, config options, usage) report true without comparing.
 */
function applyUpdate(d: ConvState, u: SessionUpdate, at: number): boolean {
  switch (u.sessionUpdate) {
    case "user_message_chunk": {
      if (!d.replaying) return false; // live user text is added locally on send
      const c = u as ChunkUpdate;
      return appendChunk(d, "user", blockText(c.content), c.messageId);
    }
    case "agent_message_chunk": {
      const c = u as ChunkUpdate;
      return appendChunk(d, "agent", blockText(c.content), c.messageId);
    }
    case "agent_thought_chunk": {
      const c = u as ChunkUpdate;
      return appendChunk(d, "thought", blockText(c.content), c.messageId);
    }
    case "tool_call":
      return upsertTool(d, u as ToolCallFields, true, at);
    case "tool_call_update":
      return upsertTool(d, u as ToolCallFields, false, at);
    case "plan":
      d.plan = (u as { entries?: PlanEntry[] }).entries ?? [];
      return true;
    case "available_commands_update":
      d.commands = (u as { availableCommands?: AvailableCommand[] }).availableCommands ?? [];
      return true;
    case "current_mode_update": {
      const id = (u as { currentModeId: string }).currentModeId;
      if (!d.modes || d.modes.currentModeId === id) return false;
      d.modes = { ...d.modes, currentModeId: id };
      return true;
    }
    case "config_option_update":
      d.configOptions = (u as { configOptions?: ConfigOption[] }).configOptions ?? [];
      return true;
    case "session_info_update": {
      const t = (u as { title?: string | null }).title;
      if (t === undefined || t === d.title) return false;
      d.title = t;
      return true;
    }
    case "usage_update": {
      const x = u as { used?: number; size?: number; cost?: Usage["cost"]; _meta?: { keryx?: Record<string, unknown> } };
      const k = x._meta?.keryx;
      d.usage = {
        used: typeof x.used === "number" ? x.used : 0,
        size: typeof x.size === "number" ? x.size : 0,
        cost: x.cost,
        call: tokenPair(k?.call),
        turn: tokenPair(k?.turn) ?? d.usage?.turn ?? null,
        session: tokenPair(k?.session) ?? d.usage?.session ?? null,
      };
      return true;
    }
    default:
      return false; // an update kind this client does not know: ignore
  }
}

/** A batch of updates for one session in one render; the same conversation back when none of them changed anything. */
export function applyUpdates(conv: ConvState, updates: readonly QueuedUpdate[]): ConvState {
  if (updates.length === 0) return conv;
  // One copy of the item list per batch, however many updates it carries.
  const d: ConvState = { ...conv, items: conv.items.slice() };
  let changed = false;
  for (const q of updates) if (applyUpdate(d, q.update, q.at)) changed = true;
  return changed ? d : conv;
}

/**
 * The queued prompt to send now: the front one, once the session is idle (no turn, held, not replaying).
 * One per call: sending it makes the session busy again, so the next waits for that turn to end.
 */
export function pendingQueueSend(conv: ConvState, turnRunning: boolean): QueuedPrompt | null {
  if (conv.busy || turnRunning || !conv.held || conv.replaying) return null;
  return conv.queue[0] ?? null;
}

// ---- the window -----------------------------------------------------------

/**
 * The window over one keryx connection. It keeps a conversation for every session it holds and routes
 * every update by its sessionId; which one is on screen is `shownId`, a local choice.
 */
export interface WindowState {
  phase: Phase;
  exit: { code: number | null; stderrTail: string } | null;
  profile: "shell" | "editor";
  agentVersion: string | null;
  /** keryx serves `_keryx/session_flags` and `_keryx/session_trash`. */
  canOrganize: boolean;
  /** Sessions the window holds, or held and was told it no longer holds (read-only). */
  convs: Readonly<Record<string, ConvState>>;
  /** A session/load in flight: its replay lands here, off screen, and moves to `convs` on success. */
  loading: Readonly<Record<string, ConvState>>;
  /** session/new requests in flight. */
  creating: number;
  shownId: string | null;
  sessions: SessionInfo[];
  banners: Banner[];
  nextBannerId: number;
}

export const initialState: WindowState = {
  phase: "starting",
  exit: null,
  profile: "editor",
  agentVersion: null,
  canOrganize: false,
  convs: {},
  loading: {},
  creating: 0,
  shownId: null,
  sessions: [],
  banners: [],
  nextBannerId: 1,
};

export type Action =
  /** Session updates coalesced into one render, each routed to the session it names. */
  | { t: "updates"; updates: readonly RoutedUpdate[] }
  | { t: "userSent"; sessionId: string; text: string }
  | { t: "notice"; sessionId: string; level: "info" | "warn" | "error"; text: string }
  | { t: "busy"; sessionId: string; busy: boolean }
  /** A command card; with `replaceId` it takes the place of that card (a view acting on itself). */
  /** `_keryx/delegate_result`: a terminal run's turn answer, shown in the session it was delegated from. */
  | { t: "delegateResult"; sessionId: string; runId: string; agentId: string; turn: number; text: string }
  | { t: "command"; sessionId: string; card: Omit<CommandItem, "kind" | "id">; replaceId?: number }
  | { t: "queueAdd"; sessionId: string; text: string }
  | { t: "queueRemove"; sessionId: string; index: number }
  /** The prompt at the front was sent. */
  | { t: "queueShift"; sessionId: string }
  /** Make entry `index` the next one sent. */
  | { t: "queueFront"; sessionId: string; index: number }
  /** A `_keryx/subagent` fleet event for the session it names. */
  | { t: "subagent"; sessionId: string; event: unknown }
  /** The session's task list, as `_keryx/tasks/list` returned it. */
  | { t: "tasks"; sessionId: string; tasks: readonly TaskInfo[] }
  | { t: "config"; sessionId: string; configOptions: ConfigOption[] }
  | { t: "creating"; delta: 1 | -1 }
  | { t: "created"; sessionId: string; modes?: SessionModeState | null; configOptions?: ConfigOption[] | null; show: boolean }
  | { t: "loadStart"; sessionId: string }
  | { t: "loadDone"; sessionId: string; modes?: SessionModeState | null; configOptions?: ConfigOption[] | null; show: boolean }
  | { t: "loadFailed"; sessionId: string }
  /** Show a session the window already has: local, no request. */
  | { t: "show"; sessionId: string }
  | { t: "released"; sessionId: string }
  /** The connection is gone or restarting: every conversation stays visible, read-only. */
  | { t: "connectionReset" }
  | { t: "banner"; level: Banner["level"]; text: string }
  | { t: "clearBanners" }
  | { t: "dismissBanner"; id: number }
  | { t: "phase"; phase: Phase; exit?: WindowState["exit"] }
  | { t: "agent"; profile: "shell" | "editor"; version: string | null; canOrganize: boolean }
  | { t: "sessions"; sessions: SessionInfo[] }
  /** keryx stored new flags (archived, pinned) for a listed session. */
  | { t: "flags"; sessionId: string; flags: SessionFlags }
  /** The session went to the trash. */
  | { t: "removed"; sessionId: string };

function withConv(state: WindowState, sessionId: string, f: (c: ConvState) => ConvState): WindowState {
  const c = state.convs[sessionId];
  if (!c) return state;
  const next = f(c);
  return next === c ? state : { ...state, convs: { ...state.convs, [sessionId]: next } };
}

function without<T>(rec: Readonly<Record<string, T>>, key: string): Record<string, T> {
  const out = { ...rec };
  delete out[key];
  return out;
}

function routeUpdates(state: WindowState, updates: readonly RoutedUpdate[]): WindowState {
  const bySession = new Map<string, QueuedUpdate[]>();
  for (const u of updates) {
    const list = bySession.get(u.sessionId);
    if (list) list.push(u);
    else bySession.set(u.sessionId, [u]);
  }
  let convs = state.convs;
  let loading = state.loading;
  for (const [sid, list] of bySession) {
    const target = loading[sid] ?? convs[sid];
    // A session the window does not hold, or no longer holds, is not narrated into.
    if (!target || (!loading[sid] && !target.held)) continue;
    const next = applyUpdates(target, list);
    if (next === target) continue;
    if (loading[sid]) loading = { ...loading, [sid]: next };
    else convs = { ...convs, [sid]: next };
  }
  return convs === state.convs && loading === state.loading ? state : { ...state, convs, loading };
}

export function reducer(state: WindowState, a: Action): WindowState {
  switch (a.t) {
    case "updates":
      return routeUpdates(state, a.updates);
    case "userSent":
      return withConv(state, a.sessionId, (c) => ({ ...c, nextId: c.nextId + 1, items: [...c.items, { kind: "user", id: c.nextId, text: a.text }] }));
    case "notice":
      return withConv(state, a.sessionId, (c) => ({
        ...c,
        nextId: c.nextId + 1,
        items: [...c.items, { kind: "notice", id: c.nextId, level: a.level, text: a.text }],
      }));
    case "command":
      return withConv(state, a.sessionId, (c) => {
        if (a.replaceId !== undefined && c.items.some((i) => i.kind === "command" && i.id === a.replaceId)) {
          return { ...c, items: c.items.map((i) => (i.kind === "command" && i.id === a.replaceId ? { ...a.card, kind: "command" as const, id: i.id } : i)) };
        }
        return { ...c, nextId: c.nextId + 1, items: [...c.items, { ...a.card, kind: "command", id: c.nextId }] };
      });
    case "delegateResult":
      return withConv(state, a.sessionId, (c) => ({
        ...c,
        nextId: c.nextId + 1,
        items: [...c.items, { kind: "delegate", id: c.nextId, runId: a.runId, agentId: a.agentId, turn: a.turn, text: a.text }],
      }));
    case "queueAdd":
      return withConv(state, a.sessionId, (c) =>
        a.text.trim() ? { ...c, nextId: c.nextId + 1, queue: [...c.queue, { id: c.nextId, text: a.text }] } : c,
      );
    case "queueRemove":
      return withConv(state, a.sessionId, (c) => (a.index >= 0 && a.index < c.queue.length ? { ...c, queue: c.queue.filter((_, i) => i !== a.index) } : c));
    case "queueShift":
      return withConv(state, a.sessionId, (c) => (c.queue.length ? { ...c, queue: c.queue.slice(1) } : c));
    case "queueFront":
      return withConv(state, a.sessionId, (c) => {
        if (a.index <= 0 || a.index >= c.queue.length) return c;
        const picked = c.queue[a.index]!;
        return { ...c, queue: [picked, ...c.queue.filter((_, i) => i !== a.index)] };
      });
    case "subagent":
      return withConv(state, a.sessionId, (c) => {
        const next = applySubagentEvent(c.subagents, a.event);
        return next === c.subagents ? c : { ...c, subagents: next };
      });
    case "tasks":
      return withConv(state, a.sessionId, (c) => ({ ...c, tasks: a.tasks }));
    case "busy":
      return withConv(state, a.sessionId, (c) => (c.busy === a.busy ? c : { ...c, busy: a.busy }));
    case "config":
      return withConv(state, a.sessionId, (c) => ({ ...c, configOptions: a.configOptions }));
    case "creating":
      return { ...state, creating: Math.max(0, state.creating + a.delta) };
    case "created": {
      const conv = newConv(a.sessionId, { replaying: false, modes: a.modes, configOptions: a.configOptions });
      return { ...state, convs: { ...state.convs, [a.sessionId]: conv }, shownId: a.show ? a.sessionId : state.shownId };
    }
    case "loadStart":
      return { ...state, loading: { ...state.loading, [a.sessionId]: newConv(a.sessionId, { replaying: true }) } };
    case "loadDone": {
      const loaded = state.loading[a.sessionId];
      if (!loaded) return state;
      const conv: ConvState = {
        ...loaded,
        replaying: false,
        held: true,
        lostReason: null,
        // A reload (after /compact or /rewind) keeps what the window itself holds.
        queue: state.convs[a.sessionId]?.queue ?? [],
        // Tasks live in keryx and survive a replay; subagents are not persisted, so they start empty.
        tasks: state.convs[a.sessionId]?.tasks ?? [],
        modes: a.modes ?? loaded.modes,
        configOptions: a.configOptions ?? loaded.configOptions,
      };
      return {
        ...state,
        loading: without(state.loading, a.sessionId),
        convs: { ...state.convs, [a.sessionId]: conv },
        shownId: a.show ? a.sessionId : state.shownId,
      };
    }
    case "loadFailed":
      // The view, and any read-only copy of the session, stay as they were.
      return state.loading[a.sessionId] ? { ...state, loading: without(state.loading, a.sessionId) } : state;
    case "show":
      return state.convs[a.sessionId] && state.shownId !== a.sessionId ? { ...state, shownId: a.sessionId } : state;
    case "released":
      return withConv(state, a.sessionId, (c) => (c.held || c.busy ? { ...c, held: false, busy: false, lostReason: c.held ? "idle-cap" : c.lostReason } : c));
    case "connectionReset": {
      const convs: Record<string, ConvState> = {};
      for (const [sid, c] of Object.entries(state.convs)) convs[sid] = c.held || c.busy ? { ...c, held: false, busy: false, lostReason: c.held ? "connection" : c.lostReason } : c;
      return { ...state, convs, loading: {}, creating: 0 };
    }
    case "banner":
      return {
        ...state,
        nextBannerId: state.nextBannerId + 1,
        banners: [...state.banners.filter((b) => b.text !== a.text), { id: state.nextBannerId, level: a.level, text: a.text }],
      };
    case "clearBanners":
      return state.banners.length === 0 ? state : { ...state, banners: [] };
    case "dismissBanner":
      return { ...state, banners: state.banners.filter((b) => b.id !== a.id) };
    case "phase":
      return { ...state, phase: a.phase, exit: a.exit ?? null };
    case "agent":
      return { ...state, profile: a.profile, agentVersion: a.version, canOrganize: a.canOrganize };
    case "sessions":
      return { ...state, sessions: a.sessions };
    case "flags":
      return {
        ...state,
        sessions: state.sessions.map((s) => (s.sessionId === a.sessionId ? { ...s, _meta: { ...s._meta, keryx: a.flags } } : s)),
      };
    case "removed": {
      // Moved to the trash: gone from the list and the window. The shown one leaves nothing shown.
      const { [a.sessionId]: _gone, ...convs } = state.convs;
      return {
        ...state,
        convs,
        loading: without(state.loading, a.sessionId),
        sessions: state.sessions.filter((s) => s.sessionId !== a.sessionId),
        shownId: state.shownId === a.sessionId ? null : state.shownId,
      };
    }
  }
}

// ---- what the UI reads ----------------------------------------------------

/** The sidebar's marks for one session the window has. */
export interface SessionMark {
  busy: boolean;
  /** A permission or ask_user dialog waits for the user. */
  waiting: boolean;
  held: boolean;
  lostReason: LostReason | null;
  title: string | null;
  /** Running subagents plus running tasks. */
  running: number;
  /** The session's subagents (native and external); empty unless the session is held. */
  subagents: readonly Subagent[];
}

/** The shown session flattened with the window's own fields: what SessionView and App render. */
export interface SessionState {
  phase: Phase;
  exit: WindowState["exit"];
  profile: "shell" | "editor";
  agentVersion: string | null;
  /** keryx serves `_keryx/session_flags` and `_keryx/session_trash`. */
  canOrganize: boolean;
  sessions: SessionInfo[];
  banners: Banner[];
  sessionId: string | null;
  items: Item[];
  busy: boolean;
  replaying: boolean;
  /** The shown session is still held by keryx; false means read-only until it is reopened. */
  held: boolean;
  lostReason: LostReason | null;
  commands: AvailableCommand[];
  modes: SessionModeState | null;
  configOptions: ConfigOption[];
  plan: PlanEntry[];
  usage: Usage | null;
  title: string | null;
  queue: QueuedPrompt[];
  subagents: readonly Subagent[];
  tasks: readonly TaskInfo[];
  /** A session/new or session/load is in flight. */
  opening: boolean;
  /** Session ids whose session/load is in flight. */
  loadingIds: readonly string[];
}

const NO_ITEMS: Item[] = [];
const NO_COMMANDS: AvailableCommand[] = [];
const NO_CONFIG: ConfigOption[] = [];
const NO_PLAN: PlanEntry[] = [];
const NO_QUEUE: QueuedPrompt[] = [];

export function shownView(w: WindowState): SessionState {
  const c = w.shownId ? w.convs[w.shownId] : undefined;
  const loadingIds = Object.keys(w.loading);
  return {
    phase: w.phase,
    exit: w.exit,
    profile: w.profile,
    agentVersion: w.agentVersion,
    canOrganize: w.canOrganize,
    sessions: w.sessions,
    banners: w.banners,
    sessionId: c?.sessionId ?? null,
    items: c?.items ?? NO_ITEMS,
    busy: c?.busy ?? false,
    replaying: c?.replaying ?? false,
    held: c?.held ?? false,
    lostReason: c?.lostReason ?? null,
    commands: c?.commands ?? NO_COMMANDS,
    modes: c?.modes ?? null,
    configOptions: c?.configOptions ?? NO_CONFIG,
    plan: c?.plan ?? NO_PLAN,
    usage: c?.usage ?? null,
    title: c?.title ?? null,
    queue: c?.queue ?? NO_QUEUE,
    subagents: c?.subagents ?? NO_SUBAGENTS,
    tasks: c?.tasks ?? NO_TASKS,
    opening: w.creating > 0 || loadingIds.length > 0,
    loadingIds,
  };
}

/** Running subagents plus running tasks of one session. */
export function activityCount(c: Pick<ConvState, "subagents" | "tasks">): number {
  return runningSubagents(c.subagents) + c.tasks.filter((t) => t.status === "running").length;
}

/** Marks for every session the window has, for the sidebar. */
export function sessionMarks(w: WindowState, waiting: ReadonlySet<string>): Record<string, SessionMark> {
  const out: Record<string, SessionMark> = {};
  for (const [sid, c] of Object.entries(w.convs)) out[sid] = { busy: c.busy, waiting: waiting.has(sid), held: c.held, lostReason: c.lostReason, title: c.title, running: activityCount(c), subagents: c.held ? c.subagents : NO_SUBAGENTS };
  return out;
}
