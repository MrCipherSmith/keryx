/** Hub-only MCP bridge. SDK APIs verified against installed SDK 1.30.0 types. */
export type HubMcpBridgeOptions = { endpoint: string; tokenEnv?: string };
type BridgeConfig = { endpoint: URL; headers: Record<string, string>; secrets: string[] };
const ENDPOINT_ERROR = "Invalid Hub MCP endpoint; use HTTPS or loopback HTTP without credentials, query or fragment.";
const CREDENTIAL_ERROR = "Hub MCP credentials are missing or invalid; set the agent token and both optional Cloudflare service variables.";
const REQUEST_TIMEOUT_MS = 30000;

export function resolveHubMcpBridgeConfig(options: HubMcpBridgeOptions, env: Record<string, string | undefined> = process.env): BridgeConfig {
    let endpoint: URL;
    try { endpoint = new URL(options.endpoint); } catch { throw Error(ENDPOINT_ERROR); }
    if (!/^https?:\/\//.test(options.endpoint) || options.endpoint.trim() !== options.endpoint || [...options.endpoint].some(character => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127) ||
        endpoint.username || endpoint.password || options.endpoint.includes("?") || options.endpoint.includes("#") ||
        (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname))))
        throw Error(ENDPOINT_ERROR);
    const tokenEnv = options.tokenEnv ?? "KERYX_HUB_TOKEN";
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokenEnv)) throw Error(CREDENTIAL_ERROR);
    const token = env[tokenEnv];
    const clientId = env.KERYX_CF_ACCESS_CLIENT_ID;
    const clientSecret = env.KERYX_CF_ACCESS_CLIENT_SECRET;
    const valid = (value: string | undefined): value is string => typeof value === "string" && value.length > 0 && value.length <= 8192 && /^[\x21-\x7e]+$/.test(value);
    if (!valid(token) || ((clientId !== undefined || clientSecret !== undefined) && (!valid(clientId) || !valid(clientSecret)))) throw Error(CREDENTIAL_ERROR);
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    const secrets = [token];
    if (clientId !== undefined && clientSecret !== undefined) {
        headers["CF-Access-Client-Id"] = clientId;
        headers["CF-Access-Client-Secret"] = clientSecret;
        secrets.push(clientId, clientSecret);
    }
    return { endpoint, headers, secrets };
}

function redact(value: unknown, secrets: string[]): unknown {
    let serialized = JSON.stringify(value);
    for (const secret of [...secrets].sort((a, b) => b.length - a.length)) serialized = serialized.replaceAll(JSON.stringify(secret).slice(1, -1), "[REDACTED]");
    return JSON.parse(serialized) as unknown;
}

export async function runHubMcpBridge(options: HubMcpBridgeOptions): Promise<void> {
    const config = resolveHubMcpBridgeConfig(options);
    // The SDK is optional for all unrelated commands, and loaded only here.
    const sdk = await (async () => {
        try {
            const [{ Client }, { StreamableHTTPClientTransport }, { Server }, { StdioServerTransport }, schemas] = await Promise.all([
                import("@modelcontextprotocol/sdk/client/index.js"),
                import("@modelcontextprotocol/sdk/client/streamableHttp.js"),
                import("@modelcontextprotocol/sdk/server/index.js"),
                import("@modelcontextprotocol/sdk/server/stdio.js"),
                import("@modelcontextprotocol/sdk/types.js")
            ]);
            return { Client, StreamableHTTPClientTransport, Server, StdioServerTransport, schemas };
        } catch { throw Error("Hub MCP bridge requires the optional @modelcontextprotocol/sdk dependency."); }
    })();
    const controller = new AbortController();
    const remote = new sdk.Client({ name: "keryx-hub-bridge", version: "0.1.0" });
    const local = new sdk.Server({ name: "keryx-hub-bridge", version: "0.1.0" }, { capabilities: { tools: {} } });
    let finish!: () => void;
    const finished = new Promise<void>(resolve => { finish = resolve; });
    const stop = () => { controller.abort(); finish(); };
    process.once("SIGINT", stop); process.once("SIGTERM", stop); process.stdin.once("end", stop);
    local.onclose = stop;
    remote.onclose = stop;
    // SDK errors may contain response bodies/headers, so never log them raw.
    local.onerror = () => { console.error("Hub MCP stdio protocol error."); };
    remote.onerror = () => { /* A request reports a fixed error to its caller. */ };
    const transport = new sdk.StreamableHTTPClientTransport(config.endpoint, {
        requestInit: { headers: config.headers, redirect: "error" },
        reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
        fetch: async (input, init) => {
            const target = new URL(input instanceof Request ? input.url : String(input));
            if (target.href !== config.endpoint.href) throw Error("Hub MCP refused an unexpected remote endpoint.");
            const signals = [controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)];
            if (init?.signal) signals.push(init.signal);
            return fetch(input, { ...init, redirect: "error", signal: AbortSignal.any(signals) });
        }
    });
    const requestOptions = () => ({ signal: controller.signal, timeout: REQUEST_TIMEOUT_MS });
    local.setRequestHandler(sdk.schemas.ListToolsRequestSchema, async (request) => {
        try { return sdk.schemas.ListToolsResultSchema.parse(redact(await remote.listTools(request.params, requestOptions()), config.secrets)); }
        catch { throw new sdk.schemas.McpError(sdk.schemas.ErrorCode.InternalError, "Remote Hub MCP request failed."); }
    });
    local.setRequestHandler(sdk.schemas.CallToolRequestSchema, async (request) => {
        try { return sdk.schemas.CallToolResultSchema.parse(redact(await remote.callTool(request.params, sdk.schemas.CallToolResultSchema, requestOptions()), config.secrets)); }
        catch { return { isError: true, content: [{ type: "text", text: "Remote Hub MCP request failed. The operation may have completed; inspect Hub or repeat the same operationId." }] }; }
    });
    try {
        // SDK 1.30.0 declares sessionId as an optional Transport field but
        // exposes a string|undefined getter; omit that unused field from this
        // structural view under exactOptionalPropertyTypes. Runtime is unchanged.
        const remoteTransport: Omit<typeof transport, "sessionId"> = transport;
        await remote.connect(remoteTransport, requestOptions());
        if (!controller.signal.aborted) await local.connect(new sdk.StdioServerTransport());
        if (!controller.signal.aborted) await finished;
    } catch {
        if (!controller.signal.aborted) throw Error("Unable to connect to Hub MCP; check the endpoint, agent credentials and Cloudflare service access.");
    } finally {
        controller.abort();
        process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); process.stdin.removeListener("end", stop);
        delete local.onclose; delete remote.onclose;
        await Promise.allSettled([local.close(), remote.close()]);
    }
}
