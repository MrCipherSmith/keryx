// The slice of ACP v1 the desktop client uses. Mirrors src/acp/protocol.ts in
// the keryx repo (the wire is the contract, so these are copies, not imports).
// Everything keryx may omit is optional: the client degrades instead of failing.

export type Meta = Record<string, unknown>;

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "resource_link"; name: string; uri: string }
  | { type: "resource"; resource: { uri: string; text?: string } }
  | { type: string; [k: string]: unknown };

export type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed";
export type ToolKind =
  | "read" | "edit" | "delete" | "move" | "search" | "execute"
  | "think" | "fetch" | "switch_mode" | "other";

export type ToolCallContent =
  | { type: "content"; content: ContentBlock }
  | { type: "diff"; path: string; newText: string; oldText?: string | null }
  | { type: "terminal"; terminalId: string };

export interface ToolCallFields {
  toolCallId: string;
  title?: string | null;
  kind?: ToolKind | null;
  status?: ToolCallStatus | null;
  content?: ToolCallContent[] | null;
  rawInput?: unknown;
  rawOutput?: unknown;
  _meta?: Meta;
}

export interface PlanEntry {
  content: string;
  priority: "high" | "medium" | "low";
  status: "pending" | "in_progress" | "completed";
  /** keryx's own item id and status (proposed/blocked map to pending, skipped to completed). */
  _meta?: { keryx?: { id?: string; status?: string } } & Meta;
}

/** `_meta.keryx` of an advertised command (shell profile). Absent on an older keryx or the editor profile. */
export interface CommandMeta {
  group?: string;
  /** text: run with _keryx/command; view: the answer carries a view; dialog / client: the app acts alone. */
  surface?: "text" | "view" | "dialog" | "client";
  /** What the shell does while a turn runs: run the command, or refuse it. */
  busy?: "run" | "refuse";
}

export interface AvailableCommand {
  name: string;
  description: string;
  input?: { hint: string } | null;
  _meta?: { keryx?: CommandMeta } & Meta;
}

/** `_keryx/command` request params. */
export interface CommandParams {
  sessionId: string;
  name: string;
  args: string;
}

/** Names of state a command changed, so the client can refresh without parsing text. */
export type CommandEffect = "mode" | "model" | "config" | "plan" | "transcript" | "tasks" | (string & {});

export interface ViewAction {
  label: string;
  /** A command line, sent back through _keryx/command. */
  command: string;
  /** Ask first; the text is the question. */
  confirm?: string;
}

export interface ViewRow {
  id: string;
  label: string;
  detail?: string | null;
  status?: string | null;
  actions?: ViewAction[];
}

export interface ViewField {
  id: string;
  label: string;
  kind: "text" | "secret" | "choice" | "toggle" | (string & {});
  options?: Array<string | { value: string; label?: string }>;
  value?: string | boolean | null;
}

export interface ViewForm {
  fields: ViewField[];
  /** A command line with `{fieldId}` placeholders. */
  submit: string;
  submitLabel?: string;
}

export interface CommandView {
  title: string;
  rows?: ViewRow[];
  body?: string | null;
  form?: ViewForm | null;
}

/** Result of `_keryx/command`. */
export interface CommandResult {
  text?: string;
  _meta?: { keryx?: { effects?: CommandEffect[]; refused?: boolean; view?: CommandView | null } } & Meta;
}

export interface SessionMode { id: string; name: string; description?: string | null }
export interface SessionModeState { currentModeId: string; availableModes: SessionMode[] }

export interface ConfigSelectOption { value: string; name: string; description?: string | null }
export interface ConfigSelectGroup { group: string; name: string; options: ConfigSelectOption[] }
export interface ConfigOption {
  id: string;
  name: string;
  description?: string | null;
  category?: string | null;
  type: "select" | string;
  currentValue: string;
  options: Array<ConfigSelectOption | ConfigSelectGroup>;
}

export interface SessionInfo {
  sessionId: string;
  cwd: string;
  title?: string | null;
  updatedAt?: string | null;
}

export type SessionUpdate =
  | { sessionUpdate: "user_message_chunk" | "agent_message_chunk" | "agent_thought_chunk"; content: ContentBlock; messageId?: string | null }
  | ({ sessionUpdate: "tool_call" } & ToolCallFields)
  | ({ sessionUpdate: "tool_call_update" } & ToolCallFields)
  | { sessionUpdate: "plan"; entries: PlanEntry[] }
  | { sessionUpdate: "available_commands_update"; availableCommands: AvailableCommand[] }
  | { sessionUpdate: "current_mode_update"; currentModeId: string }
  | { sessionUpdate: "config_option_update"; configOptions: ConfigOption[] }
  | { sessionUpdate: "session_info_update"; title?: string | null; updatedAt?: string | null }
  | { sessionUpdate: "usage_update"; used: number; size: number; cost?: { amount: number; currency: string } | null }
  | { sessionUpdate: string; [k: string]: unknown };

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}

export interface PermissionRequest {
  sessionId: string;
  toolCall: ToolCallFields;
  options: PermissionOption[];
}

export type PermissionOutcome =
  | { outcome: "cancelled" }
  | { outcome: "selected"; optionId: string };

export interface AskUserRequest {
  sessionId: string;
  question: string;
  options?: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
  _meta?: {
    keryx?: {
      recommended?: string;
      allowFreeform?: boolean;
      irreversible?: boolean;
      untrustedContent?: boolean;
    };
  } & Meta;
}

export type AskUserResult =
  | { outcome: "answered"; answers: string[] }
  | { outcome: "cancelled" };

export interface InitializeResult {
  protocolVersion: number;
  agentInfo?: { name?: string; version?: string } | null;
  agentCapabilities?: Record<string, unknown>;
  _meta?: { keryx?: { profile?: string; profiles?: string[]; extensions?: string[]; liveSessions?: boolean } } & Meta;
}

/** ext notification: keryx stopped holding a session for this connection (idle cap); a return to it needs session/load. */
export const SESSION_RELEASED = "_keryx/session_released";
/** Notification to keryx: the user switched the shown session locally (counts for its idle-cap LRU). */
export const SESSION_SHOWN = "_keryx/session_shown";
export interface SessionReleasedParams {
  sessionId: string;
  reason: string;
}

/** Why keryx asks before a call: `toolCall._meta.keryx.reasons`, only the fields that are set. */
export interface PermissionReasons {
  untrustedOrigin?: boolean;
  credentials?: boolean;
  destructive?: boolean;
  publishLease?: boolean;
  publishLeaseDetail?: string;
  hcLaunch?: boolean;
  hookAsk?: boolean;
  alwaysAsk?: boolean;
}

/** Whether this keryx keeps every session of a connection alive (`liveSessions`), wherever it advertises it. */
export function hasLiveSessions(init: InitializeResult): boolean {
  if (init._meta?.keryx?.liveSessions === true) return true;
  const caps = init.agentCapabilities?._meta as { keryx?: { liveSessions?: unknown } } | undefined;
  return caps?.keryx?.liveSessions === true;
}

export interface NewSessionResult {
  sessionId: string;
  modes?: SessionModeState | null;
  configOptions?: ConfigOption[] | null;
}

export interface LoadSessionResult {
  modes?: SessionModeState | null;
  configOptions?: ConfigOption[] | null;
}
