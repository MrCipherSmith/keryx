import type {
  AvailableCommand,
  ConfigOption,
  ContentBlock,
  PlanEntry,
  SessionInfo,
  SessionModeState,
  SessionUpdate,
  ToolCallContent,
  ToolCallFields,
  ToolCallStatus,
  ToolKind,
} from "../acp/types";

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
  | { kind: "notice"; id: number; level: "info" | "warn" | "error"; text: string };

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

export interface SessionState {
  phase: Phase;
  exit: { code: number | null; stderrTail: string } | null;
  profile: "shell" | "editor";
  agentVersion: string | null;
  items: Item[];
  nextId: number;
  sessionId: string | null;
  busy: boolean;
  replaying: boolean;
  /** A session switch (new or load) is in flight; the composer must not send. */
  switching: boolean;
  commands: AvailableCommand[];
  modes: SessionModeState | null;
  configOptions: ConfigOption[];
  plan: PlanEntry[];
  usage: Usage | null;
  title: string | null;
  sessions: SessionInfo[];
  banners: Banner[];
}

export const initialState: SessionState = {
  phase: "starting",
  exit: null,
  profile: "editor",
  agentVersion: null,
  items: [],
  nextId: 1,
  sessionId: null,
  busy: false,
  replaying: false,
  switching: false,
  commands: [],
  modes: null,
  configOptions: [],
  plan: [],
  usage: null,
  title: null,
  sessions: [],
  banners: [],
};

export type Action =
  | { t: "update"; update: SessionUpdate; at?: number }
  /** Session updates coalesced into one render (one per animation frame, and at replay end). */
  | { t: "updates"; updates: QueuedUpdate[] }
  | { t: "switching"; on: boolean }
  | { t: "userSent"; text: string }
  | { t: "notice"; level: "info" | "warn" | "error"; text: string }
  | { t: "banner"; level: Banner["level"]; text: string }
  | { t: "clearBanners" }
  | { t: "dismissBanner"; id: number }
  | { t: "phase"; phase: Phase; exit?: SessionState["exit"] }
  | { t: "agent"; profile: "shell" | "editor"; version: string | null }
  | {
      t: "session";
      sessionId: string;
      modes?: SessionModeState | null;
      configOptions?: ConfigOption[] | null;
      replaying: boolean;
    }
  | { t: "meta"; modes?: SessionModeState | null; configOptions?: ConfigOption[] | null }
  | { t: "replayDone" }
  | { t: "sessionLost" }
  | { t: "busy"; busy: boolean }
  | { t: "config"; configOptions: ConfigOption[] }
  | { t: "sessions"; sessions: SessionInfo[] };

export interface QueuedUpdate {
  update: SessionUpdate;
  at: number;
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
 * The update helpers below mutate a draft: a shallow copy of the state whose `items` array is
 * already a private copy. Item objects themselves are never mutated (memoised rows compare them).
 */
function appendChunk(
  d: SessionState,
  kind: "user" | "agent" | "thought",
  text: string,
  messageId: string | null | undefined,
): void {
  if (text === "") return;
  const items = d.items;
  const last = items[items.length - 1];
  if (last && last.kind === kind && (messageId == null || last.messageId == null || last.messageId === messageId)) {
    items[items.length - 1] = { ...last, text: last.text + text, messageId: last.messageId ?? messageId };
    return;
  }
  items.push({ kind, id: d.nextId, text, messageId });
  d.nextId += 1;
}

function isAutoApproved(meta: unknown): boolean {
  const keryx = (meta as { keryx?: { autoApproved?: unknown } } | undefined)?.keryx;
  return keryx?.autoApproved === true;
}

function findTool(items: Item[], toolCallId: string): number {
  // Updates almost always touch a recent call: search from the end.
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it?.kind === "tool" && it.toolCallId === toolCallId) return i;
  }
  return -1;
}

function upsertTool(d: SessionState, u: ToolCallFields, isNew: boolean, at: number): void {
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
    return;
  }
  d.items.push(next);
  d.nextId += 1;
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

function applyUpdate(d: SessionState, u: SessionUpdate, at: number): void {
  switch (u.sessionUpdate) {
    case "user_message_chunk": {
      if (!d.replaying) return; // live user text is added locally on send
      const c = u as ChunkUpdate;
      appendChunk(d, "user", blockText(c.content), c.messageId);
      return;
    }
    case "agent_message_chunk": {
      const c = u as ChunkUpdate;
      appendChunk(d, "agent", blockText(c.content), c.messageId);
      return;
    }
    case "agent_thought_chunk": {
      const c = u as ChunkUpdate;
      appendChunk(d, "thought", blockText(c.content), c.messageId);
      return;
    }
    case "tool_call":
      upsertTool(d, u as ToolCallFields, true, at);
      return;
    case "tool_call_update":
      upsertTool(d, u as ToolCallFields, false, at);
      return;
    case "plan":
      d.plan = (u as { entries?: PlanEntry[] }).entries ?? [];
      return;
    case "available_commands_update":
      d.commands = (u as { availableCommands?: AvailableCommand[] }).availableCommands ?? [];
      return;
    case "current_mode_update":
      if (d.modes) d.modes = { ...d.modes, currentModeId: (u as { currentModeId: string }).currentModeId };
      return;
    case "config_option_update":
      d.configOptions = (u as { configOptions?: ConfigOption[] }).configOptions ?? [];
      return;
    case "session_info_update": {
      const t = (u as { title?: string | null }).title;
      if (t !== undefined) d.title = t;
      return;
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
      return;
    }
    default:
      return; // an update kind this client does not know: ignore
  }
}

function applyUpdates(state: SessionState, updates: readonly QueuedUpdate[]): SessionState {
  if (updates.length === 0) return state;
  // One copy of the item list per batch, however many updates it carries.
  const d: SessionState = { ...state, items: state.items.slice() };
  for (const q of updates) applyUpdate(d, q.update, q.at);
  return d;
}

export function reducer(state: SessionState, a: Action): SessionState {
  switch (a.t) {
    case "update":
      return applyUpdates(state, [{ update: a.update, at: a.at ?? Date.now() }]);
    case "updates":
      return applyUpdates(state, a.updates);
    case "switching":
      return state.switching === a.on ? state : { ...state, switching: a.on };
    case "userSent":
      return {
        ...state,
        nextId: state.nextId + 1,
        items: [...state.items, { kind: "user", id: state.nextId, text: a.text }],
      };
    case "notice":
      return {
        ...state,
        nextId: state.nextId + 1,
        items: [...state.items, { kind: "notice", id: state.nextId, level: a.level, text: a.text }],
      };
    case "banner":
      return {
        ...state,
        nextId: state.nextId + 1,
        banners: [...state.banners.filter((b) => b.text !== a.text), { id: state.nextId, level: a.level, text: a.text }],
      };
    case "clearBanners":
      return { ...state, banners: [] };
    case "dismissBanner":
      return { ...state, banners: state.banners.filter((b) => b.id !== a.id) };
    case "phase":
      return { ...state, phase: a.phase, exit: a.exit ?? null, busy: a.phase === "ready" ? state.busy : false };
    case "agent":
      return { ...state, profile: a.profile, agentVersion: a.version };
    case "session":
      return {
        ...state,
        sessionId: a.sessionId,
        items: [],
        plan: [],
        usage: null,
        title: null,
        commands: [],
        busy: false,
        replaying: a.replaying,
        switching: false,
        modes: a.modes ?? null,
        configOptions: a.configOptions ?? [],
      };
    case "meta":
      return {
        ...state,
        modes: a.modes ?? state.modes,
        configOptions: a.configOptions ?? state.configOptions,
      };
    case "replayDone":
      return { ...state, replaying: false, switching: false };
    case "sessionLost":
      // A load failed and nothing could be restored: no session, so the composer disables itself.
      return { ...state, sessionId: null, items: [], plan: [], usage: null, title: null, commands: [], busy: false, replaying: false, switching: false, modes: null };
    case "busy":
      return { ...state, busy: a.busy };
    case "config":
      return { ...state, configOptions: a.configOptions };
    case "sessions":
      return { ...state, sessions: a.sessions };
  }
}
