// Wire types and helpers for the M2a extension methods: providers (spec 3.9.3), subagents (3.9.4)
// and background tasks (3.9.5). The methods a keryx serves are listed in
// `initialize._meta.keryx.extensions`; the client hides a feature whose methods are missing (3.9.6).

import type { InitializeResult } from "./types";

export const PROVIDERS_LIST = "_keryx/providers/list";
export const PROVIDERS_TEST = "_keryx/providers/test";
export const PROVIDERS_DISCONNECT = "_keryx/providers/disconnect";
export const PROVIDERS_CONNECT = "_keryx/providers/connect";
export const PROVIDERS_LOGIN = "_keryx/providers/login";
export const PROVIDERS_LOGIN_CANCEL = "_keryx/providers/login_cancel";
export const PROVIDERS_LOGIN_CHALLENGE = "_keryx/providers/login_challenge";
export const SEARCH_PROVIDERS_LIST = "_keryx/search_providers/list";
export const SEARCH_PROVIDERS_CONNECT = "_keryx/search_providers/connect";
export const SEARCH_PROVIDERS_SELECT = "_keryx/search_providers/select";

export const SUBAGENT_NOTIFICATION = "_keryx/subagent";
export const TASKS_EVENT = "_keryx/tasks/event";
export const TASKS_LIST = "_keryx/tasks/list";
export const TASKS_OUTPUT = "_keryx/tasks/output";
export const TASKS_KILL = "_keryx/tasks/kill";

export type Extensions = readonly string[];

export function extensionsOf(init: InitializeResult): string[] {
  const list = init._meta?.keryx?.extensions;
  return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
}

export function hasExtension(ext: Extensions, method: string): boolean {
  return ext.includes(method);
}

/** Every method the Providers dialog needs for its main modes. */
export function supportsProviders(ext: Extensions): boolean {
  return [PROVIDERS_LIST, PROVIDERS_TEST, PROVIDERS_DISCONNECT, PROVIDERS_CONNECT].every((m) => ext.includes(m));
}

export function supportsDeviceLogin(ext: Extensions): boolean {
  return ext.includes(PROVIDERS_LOGIN) && ext.includes(PROVIDERS_LOGIN_CANCEL);
}

export function supportsSearchProviders(ext: Extensions): boolean {
  return [SEARCH_PROVIDERS_LIST, SEARCH_PROVIDERS_CONNECT, SEARCH_PROVIDERS_SELECT].every((m) => ext.includes(m));
}

export function supportsTasks(ext: Extensions): boolean {
  return ext.includes(TASKS_LIST) && ext.includes(TASKS_OUTPUT);
}

export type AuthMethod = "api-key" | "device-code" | "none";

export interface ProviderInfo {
  id: string;
  label: string;
  connected: boolean;
  authMethods: AuthMethod[];
  needsBaseUrl: boolean;
  baseUrl?: string;
  /** Why this provider cannot be connected from the app. */
  refusal?: string;
}

export interface ProvidersListResult {
  providers: ProviderInfo[];
}
export interface ProviderTestResult {
  ok: boolean;
  models?: number;
  error?: string;
}
export interface ProviderDisconnectResult {
  sharedEnvWith?: string[];
}
export interface ProviderConnectResult {
  ok: boolean;
  error?: string;
  retry?: "credential" | "base-url";
}
export interface ProviderLoginResult {
  outcome: "connected" | "cancelled" | "failed";
  error?: string;
}
export interface LoginChallenge {
  loginId: string;
  providerId: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  instructions?: string;
}

/** The URL the "Open browser" button opens: the one that already carries the code, when keryx sent it. */
export function loginUrl(c: Pick<LoginChallenge, "verificationUri" | "verificationUriComplete">): string {
  return c.verificationUriComplete || c.verificationUri;
}

/**
 * `_keryx/search_providers/*` wire. Spec 3.9.3 names the methods only; these shapes are the client's
 * assumption (see the report): list `{ providers: [{ id, label, connected, selected?, needsKey?, refusal? }] }`,
 * connect `{ providerId, apiKey }` -> `{ ok, error? }`, select `{ providerId }` -> `{ ok?, error? }`.
 */
export interface SearchProviderInfo {
  id: string;
  label: string;
  connected: boolean;
  selected?: boolean;
  needsKey?: boolean;
  refusal?: string;
}

// ---- background tasks --------------------------------------------------------------------------

export interface TaskInfo {
  id: string;
  command: string;
  status: string;
  phase: string | null;
  description: string | null;
  startedAt: number | null;
  endedAt: number | null;
  exitCode: number | null;
}

function ms(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

/** One `BackgroundJobInfo` from `_keryx/tasks/list` (jobId, command, status, phase, startedAt ISO, endedAt?, exitCode?). */
export function toTask(raw: unknown): TaskInfo | null {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== "object") return null;
  const id = typeof r.jobId === "string" ? r.jobId : typeof r.id === "string" ? r.id : typeof r.taskId === "string" ? r.taskId : null;
  if (!id) return null;
  return {
    id,
    command: typeof r.command === "string" ? r.command : id,
    status: typeof r.status === "string" ? r.status : "running",
    phase: typeof r.phase === "string" ? r.phase : null,
    description: typeof r.description === "string" ? r.description : null,
    startedAt: ms(r.startedAt),
    endedAt: ms(r.endedAt),
    exitCode: typeof r.exitCode === "number" ? r.exitCode : null,
  };
}

export function toTasks(result: unknown): TaskInfo[] {
  const list = (result as { tasks?: unknown } | null)?.tasks;
  if (!Array.isArray(list)) return [];
  return list.map(toTask).filter((t): t is TaskInfo => t !== null);
}

export const isRunning = (t: Pick<TaskInfo, "status">): boolean => t.status === "running";

export interface TaskOutputResult {
  output: string;
  nextCursor: string | number | null;
  missed?: boolean | number;
  status?: string;
}
