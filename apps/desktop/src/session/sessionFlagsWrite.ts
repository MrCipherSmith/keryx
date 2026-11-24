import { RpcError, type AcpClient } from "../acp/client";
import { SESSION_FLAGS, type SessionFlags } from "../acp/types";

/** The reason keryx gave in a JSON-RPC refusal (`error.data.reason`), when it gave one as text. */
export function refusalReason(error: unknown): string | undefined {
  if (!(error instanceof RpcError)) return undefined;
  const reason = (error.data as { reason?: unknown } | undefined)?.reason;
  return typeof reason === "string" && reason.trim() ? reason : undefined;
}

export interface SessionFlagsChange {
  archived?: boolean;
  pinned?: boolean;
  flow?: string | null;
}

/**
 * One `_keryx/session_flags` write. The flags keryx answers go to `onFlags` for the session even when the
 * connection was replaced while the write ran: the write was stored, so the session list must show it.
 * Throws when keryx is not connected or refuses. keryx answers a store refusal (a held flags lock, a session
 * trashed since it was listed) as "Invalid request" with the reason in `error.data.reason`; that reason,
 * without its method prefix, is the thrown message. Each caller chooses how to handle a failure.
 */
export async function writeSessionFlags(
  live: { readonly current: { readonly client: Pick<AcpClient, "request"> | null } },
  cwd: string,
  sessionId: string,
  change: SessionFlagsChange,
  onFlags: (sessionId: string, flags: SessionFlags) => void,
): Promise<SessionFlags> {
  const client = live.current.client;
  if (!client) throw new Error("keryx is not connected.");
  let flags: SessionFlags;
  try {
    flags = (await client.request<SessionFlags | null>(SESSION_FLAGS, { sessionId, cwd, ...change })) ?? {};
  } catch (error) {
    const reason = refusalReason(error);
    if (reason === undefined) throw error;
    throw new Error(reason.replace(new RegExp(`^${SESSION_FLAGS}:\\s*`), ""));
  }
  onFlags(sessionId, flags);
  return flags;
}
