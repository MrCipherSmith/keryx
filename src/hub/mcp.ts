import type { Principal } from "./contracts";
import { listHubMcpTools, resolveHubMcpOperation } from "./mcp-tools";

export type HubMcpContext = { actor: Principal; apiFetch: (request: Request) => Promise<Response> };
const MAX_BODY = 32 * 1024 * 1024;
function response(status: number, code: string): Response {
    return Response.json({ error: { code, message: "Hub MCP request could not be processed." } }, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...(status === 405 ? { Allow: "POST" } : {}) } });
}
async function body(request: Request): Promise<{ value: unknown } | { error: Response }> {
    const contentLength = request.headers.get("content-length");
    if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_BODY)) return { error: response(413, "quota-exceeded") };
    if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") return { error: response(415, "json-required") };
    if (!request.body) return { error: response(400, "invalid-json") };
    const reader = request.body.getReader(); const parts: Uint8Array[] = []; let size = 0;
    try {
        while (true) {
            const part = await reader.read(); if (part.done) break;
            size += part.value.byteLength;
            if (size > MAX_BODY) { await reader.cancel(); return { error: response(413, "quota-exceeded") }; }
            parts.push(part.value);
        }
        return { value: JSON.parse(Buffer.concat(parts).toString("utf8")) as unknown };
    } catch { return { error: response(400, "invalid-json") }; }
    finally { reader.releaseLock(); }
}
function toolError(code: string, status?: number) {
    return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ error: { code, message: "Hub operation failed.", ...(status === undefined ? {} : { status }) } }) }] };
}
function secrets(request: Request): string[] {
    return [request.headers.get("authorization")?.slice(7), request.headers.get("cf-access-client-id"), request.headers.get("cf-access-client-secret")]
        .filter((value): value is string => typeof value === "string" && value.length > 0)
        .sort((a, b) => b.length - a.length);
}
function redactString(text: string, values: readonly string[]): string {
    for (const secret of values) {
        const escaped = JSON.stringify(secret).slice(1, -1);
        if (escaped !== secret) text = text.replaceAll(escaped, "[REDACTED]");
        text = text.replaceAll(secret, "[REDACTED]");
    }
    return text;
}
/** Redact decoded string values, then encode. Never mutate serialized JSON escape sequences. */
function serialize(value: unknown, request: Request): string {
    const values = secrets(request);
    return JSON.stringify(value, (_key, item: unknown) => typeof item === "string" ? redactString(item, values) : item);
}
/** Outer Hub boundary authenticates/validates Origin. Per-request SDK state never crosses identities. */
export async function handleHubMcp(request: Request, context: HubMcpContext): Promise<Response> {
    if (context.actor.kind !== "agent" || context.actor.role !== "agent") return response(403, "agent-required");
    if (!request.headers.get("authorization")?.startsWith("Bearer ") || request.headers.get("authorization")!.length <= 7) return response(401, "unauthorized");
    if (request.method !== "POST") return response(405, "method-not-allowed");
    const parsed = await body(request); if ("error" in parsed) return parsed.error;
    // Current Streamable HTTP accepts one JSON-RPC message per POST, not SDK legacy batches.
    if (Array.isArray(parsed.value)) return response(400, "invalid-request");
    // Never echo a credential as a correlation id, nor silently return a different id after execution.
    if (parsed.value && typeof parsed.value === "object" && "id" in parsed.value && typeof parsed.value.id === "string" && redactString(parsed.value.id, secrets(request)) !== parsed.value.id) return response(400, "invalid-request");
    // Verified against installed @modelcontextprotocol/sdk@1.30.0 .d.ts and real SDK round trips.
    // Keep this optional dependency lazy: ordinary REST/UI and unrelated CLI paths never load it.
    const sdk = await Promise.all([
        import("@modelcontextprotocol/sdk/server/index.js"),
        import("@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"),
        import("@modelcontextprotocol/sdk/types.js"),
    ]).catch(() => undefined);
    if (!sdk) return response(503, "mcp-sdk-unavailable");
    const [{ Server }, { WebStandardStreamableHTTPServerTransport }, { ListToolsRequestSchema, CallToolRequestSchema }] = sdk;
    const server = new Server({ name: "keryx-team-hub", version: "0.1.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listHubMcpTools() }));
    server.setRequestHandler(CallToolRequestSchema, async message => {
        const resolved = resolveHubMcpOperation(message.params.name, message.params.arguments ?? {});
        if ("error" in resolved) return toolError(resolved.error);
        try {
            const headers = new Headers({ Authorization: request.headers.get("authorization")! });
            const { operation, operationId } = resolved;
            if (operation.body !== undefined) { headers.set("Content-Type", "application/json"); headers.set("Idempotency-Key", operationId!); }
            const result = await context.apiFetch(new Request(new URL(`/hub/v1${operation.path}`, request.url), { method: operation.body === undefined ? "GET" : "POST", headers, ...(operation.body === undefined ? {} : { body: JSON.stringify(operation.body) }) }));
            const value: unknown = await result.json();
            if (!result.ok) {
                const error = value && typeof value === "object" && "error" in value ? value.error : undefined;
                const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[a-z0-9-]{1,80}$/.test(error.code) ? error.code : "operation-failed";
                return toolError(code, result.status);
            }
            return { content: [{ type: "text" as const, text: serialize(value, request) }] };
        } catch { return toolError("operation-failed"); }
    });
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    try {
        await server.connect(transport);
        const result = await transport.handleRequest(request, { parsedBody: parsed.value });
        // Decode the SDK envelope before redaction so quoted/backslash credentials cannot corrupt JSON.
        const text = await result.text();
        const headers = new Headers(result.headers); headers.set("Cache-Control", "no-store"); headers.set("X-Content-Type-Options", "nosniff"); headers.delete("content-length");
        return new Response(text ? serialize(JSON.parse(text) as unknown, request) : null, { status: result.status, headers });
    } catch { return response(500, "mcp-protocol-error"); }
    finally { await server.close().catch(() => undefined); }
}
