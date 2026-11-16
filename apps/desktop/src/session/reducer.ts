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
  | { t: "busy"; busy: boolean }
  | { t: "config"; configOptions: ConfigOption[] }
  | { t: "sessions"; sessions: SessionInfo[] };

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

function appendChunk(
  state: SessionState,
  kind: "user" | "agent" | "thought",
  text: string,
  messageId: string | null | undefined,
): SessionState {
  if (text === "") return state;
  const items = state.items;
  const last = items[items.length - 1];
  if (last && last.kind === kind && (messageId == null || last.messageId == null || last.messageId === messageId)) {
    const merged = { ...last, text: last.text + text, messageId: last.messageId ?? messageId };
    return { ...state, items: [...items.slice(0, -1), merged] };
  }
  return {
    ...state,
    nextId: state.nextId + 1,
    items: [...items, { kind, id: state.nextId, text, messageId }],
  };
}

function isAutoApproved(meta: unknown): boolean {
  const keryx = (meta as { keryx?: { autoApproved?: unknown } } | undefined)?.keryx;
  return keryx?.autoApproved === true;
}

function upsertTool(state: SessionState, u: ToolCallFields, isNew: boolean, at: number): SessionState {
  const idx = state.items.findIndex((i) => i.kind === "tool" && i.toolCallId === u.toolCallId);
  const prev = idx >= 0 ? (state.items[idx] as Extract<Item, { kind: "tool" }>) : null;
  const next: Extract<Item, { kind: "tool" }> = {
    kind: "tool",
    id: prev?.id ?? state.nextId,
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
  if (next.endedAt === null && (next.status === "completed" || next.status === "failed")) next.endedAt = at;
  if (prev) {
    const items = state.items.slice();
    items[idx] = next;
    return { ...state, items };
  }
  return { ...state, nextId: state.nextId + 1, items: [...state.items, next] };
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

function applyUpdate(state: SessionState, u: SessionUpdate, at: number): SessionState {
  switch (u.sessionUpdate) {
    case "user_message_chunk": {
      if (!state.replaying) return state; // live user text is added locally on send
      const c = u as ChunkUpdate;
      return appendChunk(state, "user", blockText(c.content), c.messageId);
    }
    case "agent_message_chunk": {
      const c = u as ChunkUpdate;
      return appendChunk(state, "agent", blockText(c.content), c.messageId);
    }
    case "agent_thought_chunk": {
      const c = u as ChunkUpdate;
      return appendChunk(state, "thought", blockText(c.content), c.messageId);
    }
    case "tool_call":
      return upsertTool(state, u as ToolCallFields, true, at);
    case "tool_call_update":
      return upsertTool(state, u as ToolCallFields, false, at);
    case "plan":
      return { ...state, plan: (u as { entries?: PlanEntry[] }).entries ?? [] };
    case "available_commands_update":
      return { ...state, commands: (u as { availableCommands?: AvailableCommand[] }).availableCommands ?? [] };
    case "current_mode_update": {
      if (!state.modes) return state;
      return { ...state, modes: { ...state.modes, currentModeId: (u as { currentModeId: string }).currentModeId } };
    }
    case "config_option_update":
      return { ...state, configOptions: (u as { configOptions?: ConfigOption[] }).configOptions ?? [] };
    case "session_info_update": {
      const t = (u as { title?: string | null }).title;
      return t === undefined ? state : { ...state, title: t };
    }
    case "usage_update": {
      const x = u as { used?: number; size?: number; cost?: Usage["cost"]; _meta?: { keryx?: Record<string, unknown> } };
      const k = x._meta?.keryx;
      return {
        ...state,
        usage: {
          used: typeof x.used === "number" ? x.used : 0,
          size: typeof x.size === "number" ? x.size : 0,
          cost: x.cost,
          call: tokenPair(k?.call),
          turn: tokenPair(k?.turn) ?? state.usage?.turn ?? null,
          session: tokenPair(k?.session) ?? state.usage?.session ?? null,
        },
      };
    }
    default:
      return state; // an update kind this client does not know: ignore
  }
}

export function reducer(state: SessionState, a: Action): SessionState {
  switch (a.t) {
    case "update":
      return applyUpdate(state, a.update, a.at ?? Date.now());
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
      return { ...state, replaying: false };
    case "busy":
      return { ...state, busy: a.busy };
    case "config":
      return { ...state, configOptions: a.configOptions };
    case "sessions":
      return { ...state, sessions: a.sessions };
  }
}
