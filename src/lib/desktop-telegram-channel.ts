import { ChannelsClient } from "../remote/channels-client";

/** Private stdin contract for the bundled native bridge. Credentials never enter argv or HTTP. */
export type DesktopChannelRequest =
  | { action: "status" }
  | { action: "begin"; token: string; expectedRevision: number | null }
  | { action: "operation-status" | "cancel" | "confirm"; operationId: string; expectedRevision: number | null };

export async function desktopTelegramChannel(value: unknown, client = new ChannelsClient()): Promise<unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { ok: false, code: "invalid" };
  const request = value as Record<string, unknown>;
  const keys = Object.keys(request);
  if (request.action === "status" && keys.length === 1) return client.status();
  const revision = request.expectedRevision;
  if (!(revision === null || (typeof revision === "number" && Number.isSafeInteger(revision) && revision > 0))) return { ok: false, code: "invalid" };
  if (request.action === "begin" && keys.every((key) => ["action", "token", "expectedRevision"].includes(key)) && typeof request.token === "string") {
    const result = await client.beginRevisioned(request.token, revision);
    return result.ok ? result : { ok: false, code: result.code };
  }
  if ((request.action === "operation-status" || request.action === "cancel" || request.action === "confirm") && keys.every((key) => ["action", "operationId", "expectedRevision"].includes(key)) && typeof request.operationId === "string") {
    const result = await client.revisionedOperation(request.action === "operation-status" ? "status" : request.action, request.operationId, revision);
    return result.ok ? result : { ok: false, code: result.code };
  }
  return { ok: false, code: "invalid" };
}

/** Read at most one small JSON payload; errors and logs never contain its contents. */
export async function readDesktopChannelRequest(input: AsyncIterable<Uint8Array | string>): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of input) {
    const part = Buffer.from(chunk);
    bytes += part.length;
    if (bytes > 16_384) throw new Error("Invalid channel request.");
    chunks.push(part);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("Invalid channel request."); }
}
