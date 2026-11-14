// Flow 492 T11: the `/task` slash command's non-visual half. `isQuickStartCommand` is the shell's
// dispatch test; `createQuickStartSender` is the one HTTP call the modal makes (the Hub's
// `POST /hub/work/v1/projects/:id/quick-start`, operation id in `Idempotency-Key`); and
// `resolveQuickStartSender` finds the Hub connection the same way `keryx work` does.
//
// The sender never throws at the modal: every way a request can end is one of the three
// `QuickStartOutcome` kinds the form already knows how to show.

import { HubConnector } from "../hub/connector";
import type { QuickStartOutcome, QuickStartSender } from "./quick-start-form";

export const QUICK_START_COMMAND = "/task";

export function isQuickStartCommand(line: string): boolean {
  const token = line.trim().split(/\s+/)[0] ?? "";
  return token === QUICK_START_COMMAND;
}

const DEFAULT_TIMEOUT_MS = 15000;
const MAX_RESPONSE_CHARS = 1024 * 1024;
const MAX_MESSAGE_CHARS = 240;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export interface QuickStartSenderOptions {
  baseUrl: string;
  projectId: string;
  /** Carries the credential (`Authorization: Bearer ...`); it never appears in an outcome. */
  headers?: HeadersInit;
  fetch?: (request: Request) => Promise<Response>;
  timeoutMs?: number;
}

/** Same rule as the work client: https anywhere, plain http only to this machine, no credentials in the URL. */
function checkedBase(raw: string): URL {
  if ([...raw].some((ch) => ch.charCodeAt(0) < 33 || ch.charCodeAt(0) === 127)) throw new Error("Invalid Hub URL.");
  const base = new URL(raw);
  const plainRemote = base.protocol === "http:" && !LOCAL_HOSTS.has(base.hostname);
  if (!/^https?:$/.test(base.protocol) || base.username !== "" || base.password !== "" || base.search !== "" || base.hash !== "" || plainRemote) {
    throw new Error("The Hub URL must be https (plain http is only allowed for localhost).");
  }
  return base;
}

/** Server text is shown to the operator: strip control characters and bound the length. */
function safeText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\p{Cc}+/gu, " ").trim().slice(0, MAX_MESSAGE_CHARS);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

export function createQuickStartSender(options: QuickStartSenderOptions): QuickStartSender {
  const base = checkedBase(options.baseUrl);
  const fetcher = options.fetch ?? globalThis.fetch;
  const url = new URL(`/hub/work/v1/projects/${encodeURIComponent(options.projectId)}/quick-start`, base);
  return async (operationId, body): Promise<QuickStartOutcome> => {
    const headers = new Headers(options.headers);
    headers.set("Content-Type", "application/json");
    headers.set("Idempotency-Key", operationId);
    let response: Response;
    let text: string;
    try {
      response = await fetcher(
        new Request(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          redirect: "error",
          signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        }),
      );
      text = (await response.text()).slice(0, MAX_RESPONSE_CHARS);
    } catch {
      return { kind: "network", message: "Could not reach the Hub" };
    }
    const value = record(parseJson(text));
    if (response.status >= 400 && response.status < 500) {
      const error = record(value?.error);
      const code = typeof error?.code === "string" && /^[a-z0-9-]{1,200}$/.test(error.code) ? error.code : "request-rejected";
      const message = safeText(error?.message) || `The Hub refused the request (HTTP ${response.status}, ${code})`;
      return { kind: "rejected", status: response.status, code, message };
    }
    if (response.status >= 500) return { kind: "network", message: `The Hub failed (HTTP ${response.status})` };
    if (response.status !== 200 || value === undefined) return { kind: "network", message: "The Hub's answer could not be read" };
    const result = record(value.result);
    const flowId = typeof value.flowId === "string" ? value.flowId : result?.flowId;
    const intentId = typeof value.intentId === "string" ? value.intentId : result?.intentId;
    if (typeof flowId !== "string" || typeof intentId !== "string" || flowId === "" || intentId === "") {
      return { kind: "network", message: "The Hub's answer did not name the new Flow" };
    }
    return { kind: "accepted", flowId, intentId };
  };
}

export type ResolvedQuickStart = { ok: true; send: QuickStartSender } | { ok: false; reason: string };

type Connector = Pick<HubConnector, "status" | "binding">;

export interface ResolveQuickStartOptions {
  cwd: string;
  env?: Record<string, string | undefined>;
  connector?: Connector;
  fetch?: (request: Request) => Promise<Response>;
}

/** The Hub connection `keryx work` uses: this checkout's binding plus the bearer token from its env var. */
export async function resolveQuickStartSender(options: ResolveQuickStartOptions): Promise<ResolvedQuickStart> {
  const connector = options.connector ?? new HubConnector({ cwd: options.cwd });
  const env = options.env ?? process.env;
  try {
    const status = await connector.status();
    if (!status.ok) return { ok: false, reason: "The Hub connection binding for this checkout is invalid or unreadable." };
    if (!status.connection) return { ok: false, reason: "This checkout is not connected to Team Hub. Run keryx hub connect first." };
    const binding = await connector.binding();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(binding.tokenEnv)) return { ok: false, reason: "The Hub token environment variable name is invalid." };
    const token = env[binding.tokenEnv];
    if (!token) return { ok: false, reason: `Set ${binding.tokenEnv} to your Hub token, then run /task again.` };
    return {
      ok: true,
      send: createQuickStartSender({
        baseUrl: status.connection.url,
        projectId: status.connection.projectId,
        headers: { Authorization: `Bearer ${token}` },
        ...(options.fetch ? { fetch: options.fetch } : {}),
      }),
    };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "The Hub connection could not be read." };
  }
}

/** The line the shell prints when the Hub accepts: names the Flow and where to find it. */
export function quickStartAcceptedLine(flowId: string): string {
  return `Started flow ${flowId}. Find it in the work view (/flows).`;
}
