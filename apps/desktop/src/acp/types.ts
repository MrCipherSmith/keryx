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
  routingTiers?: true;
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
export type CommandEffect = "mode" | "model" | "config" | "plan" | "transcript" | "tasks" | "startTurn" | "openTerminal" | (string & {});

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
  kind: "text" | "secret" | "choice" | "toggle" | "number" | "time" | (string & {});
  options?: Array<string | { value: string; label?: string }>;
  value?: string | boolean | null;
  /** A hint shown while a text field is empty. */
  placeholder?: string;
  /** Submit stays disabled until the field is non-empty. */
  required?: boolean;
  /** The field exists only while `field` holds one of `equals`; hidden, it is not required, not validated and not sent. */
  showWhen?: { field: string; equals: string[] };
  /** number: smallest accepted value (inclusive). */
  min?: number;
  /** number: step of the input. */
  step?: number;
  /** text: regular expression the whole value must match. A time field is always HH:MM. */
  pattern?: string;
  /** Said under the field when its value fails `min` or `pattern`. */
  error?: string;
}

export interface ViewForm {
  fields: ViewField[];
  /** A command line with `{fieldId}` placeholders; a hidden field's placeholder goes with the `--flag` before it. */
  submit: string;
  submitLabel?: string;
  /** Why the form cannot be submitted right now; Submit stays disabled and this is shown. */
  disabled?: string;
}

export interface CommandView {
  title: string;
  rows?: ViewRow[];
  body?: string | null;
  form?: ViewForm | null;
}

/** "Ask now, then run": the client asks `confirm` at once (one dialog, `label` on its button), then runs `command`. */
export interface ConfirmAction {
  label: string;
  confirm: string;
  command: string;
}

/** Result of `_keryx/command`. */
export interface CommandResult {
  text?: string;
  _meta?: { keryx?: { effects?: CommandEffect[]; refused?: boolean; view?: CommandView | null; prompt?: string; terminal?: { runId: string; agentId: string; title: string; argv: string[]; cwd: string }; confirmAction?: ConfirmAction } } & Meta;
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

/** How the person organised a stored session (`_keryx/session_flags`); ISO times, absent when unset. */
export interface SessionFlags {
  hasIssue?: true;
  archivedAt?: string;
  pinnedAt?: string;
  /** The flow package directory this session works on. */
  flow?: string;
  /** The GitHub pull request or issue this session works on; keryx before subject support never reports it. */
  subject?: SessionSubject;
}

/** A GitHub pull request or issue a session is bound to (`flags.json` `subject`); keryx validates it on write and read. */
export interface SessionSubject {
  kind: "pr" | "issue";
  /** `owner/name`. */
  repo: string;
  number: number;
  /** Its github.com page. */
  url: string;
  repositoryId?: string;
}

/** Whether two subjects name the same PR or issue: same kind and number, repo compared without case as GitHub does. */
export function sameSubject(a: SessionSubject | null | undefined, b: SessionSubject | null | undefined): boolean {
  if (!a || !b) return false;
  return a.kind === b.kind && a.number === b.number && a.repo.toLowerCase() === b.repo.toLowerCase();
}

export interface SessionInfo {
  sessionId: string;
  cwd: string;
  title?: string | null;
  updatedAt?: string | null;
  /** keryx's shell profile reports the flags here, and (0.4.38+) how many messages the session holds. */
  _meta?: { keryx?: SessionFlags & { messageCount?: number } } | null;
}

export function sessionFlags(s: SessionInfo): SessionFlags {
  return s._meta?.keryx ?? {};
}

const unsaved = (s: SessionInfo) => (s.updatedAt ? Date.parse(s.updatedAt) || 0 : Number.POSITIVE_INFINITY);

/**
 * The non-archived sessions bound to `subject`, newest first. A session keryx has not stored yet (no
 * `updatedAt`: its binding is still pending) counts as the newest. Lives here, beside `sameSubject`,
 * so pure models (the issues board, shared with the root tests) reach no platform module.
 */
export function boundSessions(sessions: readonly SessionInfo[], subject: SessionSubject): SessionInfo[] {
  return sessions
    .filter(s => sessionFlags(s).archivedAt === undefined && sameSubject(sessionFlags(s).subject, subject))
    .sort((a, b) => unsaved(b) - unsaved(a));
}

/** Messages the stored session holds; null when this keryx does not report it. */
export function messageCount(s: SessionInfo): number | null {
  const n = s._meta?.keryx?.messageCount;
  return typeof n === "number" ? n : null;
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
      telegramProjectable?: boolean;
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
  _meta?: { keryx?: { profile?: string; profiles?: string[]; extensions?: string[]; liveSessions?: boolean; issuePreparation?: boolean } } & Meta;
}

/** ext notification: keryx stopped holding a session for this connection (idle cap); a return to it needs session/load. */
export const SESSION_RELEASED = "_keryx/session_released";
/** Notification to keryx: the user switched the shown session locally (counts for its idle-cap LRU). */
export const SESSION_SHOWN = "_keryx/session_shown";
/** Notification from keryx: a `/delegate` terminal run finished a turn; `text` is its (capped, untrusted) answer. */
export const DELEGATE_RESULT = "_keryx/delegate_result";
/** Notification to keryx: a `/delegate` run's terminal process ended (it stops watching the run's hook file). */
export const DELEGATE_EXITED = "_keryx/delegate_exited";
/** Notification from keryx: the MODEL started an external run (trust/auto mode); open it in a terminal tab. */
export const DELEGATE_TERMINAL = "_keryx/delegate_terminal";
export interface DelegateResultParams {
  sessionId: string;
  runId: string;
  agentId: string;
  turn: number;
  text: string;
  /** A model-started run: keryx returned the text as the tool result; the tab closes. */
  autoClose?: boolean;
}
/** Request to keryx: archive/unarchive, pin/unpin a stored session; answers the flags as stored. */
export const SESSION_FLAGS = "_keryx/session_flags";
/** Request to keryx: move a stored session to the system trash (a held, idle one is released first). */
export const SESSION_TRASH = "_keryx/session_trash";
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

/** Whether this keryx can archive, pin and trash sessions (`_keryx/session_flags`, `_keryx/session_trash`). */
export function canOrganizeSessions(init: InitializeResult): boolean {
  const ext = init._meta?.keryx?.extensions ?? [];
  return ext.includes(SESSION_FLAGS) && ext.includes(SESSION_TRASH);
}

export interface NewSessionResult {
  sessionId: string;
  modes?: SessionModeState | null;
  configOptions?: ConfigOption[] | null;
}

export interface LoadSessionResult {
  _meta?: { keryx?: { pendingIssueQuestions?: boolean } };
  modes?: SessionModeState | null;
  configOptions?: ConfigOption[] | null;
}
