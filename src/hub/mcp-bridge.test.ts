import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const entry = resolve(import.meta.dir, "client-main.ts");
const token = "bridge-fixture-agent-" + "a".repeat(40);
const cfId = "bridge-fixture.access";
const cfSecret = "bridge-fixture-cf-" + "s".repeat(40);
const env = { KERYX_HUB_TOKEN: token, KERYX_CF_ACCESS_CLIENT_ID: cfId, KERYX_CF_ACCESS_CLIENT_SECRET: cfSecret };

async function configuration(endpoint: string, values: Record<string, string | undefined> = env, tokenEnv?: string) {
    const { resolveHubMcpBridgeConfig } = await import("./mcp-bridge");
    return resolveHubMcpBridgeConfig({ endpoint, ...(tokenEnv ? { tokenEnv } : {}) }, values);
}

describe("Hub MCP bridge configuration", () => {
    test("validates HTTPS and explicit loopback HTTP without a checkout", async () => {
        const config = await configuration("https://hub.example.test/mcp");
        expect(config.endpoint.href).toBe("https://hub.example.test/mcp");
        expect(config.headers.Authorization).toBe(`Bearer ${token}`);
        expect(config.headers["CF-Access-Client-Id"]).toBe(cfId);
        expect((await configuration("http://127.0.0.1:8787/mcp", { ALTERNATE_AGENT: token }, "ALTERNATE_AGENT")).headers).toEqual({ Authorization: `Bearer ${token}` });
    });
    test.each([
        "http://remote.example.test/mcp", "https://user:private@hub.test/mcp", "https://hub.test/mcp?key=private",
        "https://hub.test/mcp#private", "https://hub.test/mcp?", "https://hub.test/mcp#", "file:///private/key", "https://hub.test/\nprivate", " https://hub.test/mcp", "not-a-url"
    ])("rejects unsafe endpoint without echoing its value (%#)", async (endpoint) => {
        try { await configuration(endpoint); throw Error("Expected rejection"); }
        catch (error) { expect((error as Error).message).toBe("Invalid Hub MCP endpoint; use HTTPS or loopback HTTP without credentials, query or fragment."); }
    });
    test.each([
        {}, { KERYX_HUB_TOKEN: "" }, { KERYX_HUB_TOKEN: "private\nheader" },
        { KERYX_HUB_TOKEN: token, KERYX_CF_ACCESS_CLIENT_ID: cfId },
        { KERYX_HUB_TOKEN: token, KERYX_CF_ACCESS_CLIENT_SECRET: cfSecret },
        { ...env, KERYX_CF_ACCESS_CLIENT_SECRET: "" }
    ].map(value => [value] as [Record<string, string | undefined>]))("rejects missing or partial credentials with a fixed error (%#)", async (values) => {
        await expect(configuration("https://hub.test/mcp", values)).rejects.toThrow(/Hub MCP credentials/);
    });
    test("CLI help registers mcp and does not echo unknown secret-bearing flags", () => {
        const help = Bun.spawnSync([process.execPath, "--no-env-file", "--config=/dev/null", entry, "--help"], { env: {}, stdout: "pipe", stderr: "pipe" });
        expect(help.stdout.toString()).toContain("mcp --url");
        const result = Bun.spawnSync([process.execPath, "--no-env-file", "--config=/dev/null", entry, "mcp", "--token=never-echo-private"], { env: {}, stdout: "pipe", stderr: "pipe" });
        expect(result.exitCode).toBe(1);
        expect(result.stdout.toString()).toBe("");
        expect(result.stderr.toString()).not.toContain("never-echo-private");
    });
});

async function remoteFixture(run: (fixture: { url: string; calls: Record<string, unknown>[]; rejectCalls: () => void }) => Promise<void>) {
    const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
    const { WebStandardStreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js");
    const { ListToolsRequestSchema, CallToolRequestSchema } = await import("@modelcontextprotocol/sdk/types.js");
    const calls: Record<string, unknown>[] = [];
    let reject = false;
    const http = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
        if (request.headers.get("authorization") !== `Bearer ${token}` || request.headers.get("CF-Access-Client-Id") !== cfId || request.headers.get("CF-Access-Client-Secret") !== cfSecret)
            return new Response("Denied", { status: 401 });
        if (request.method === "POST") {
            const body = await request.clone().json();
            if (body.method === "tools/call" && reject) { calls.push({ rejected: true }); return new Response(token + cfSecret, { status: 401 }); }
        }
        const server = new Server({ name: "fixture-hub", version: "1" }, { capabilities: { tools: {} } });
        server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "echo_operation", description: "Fixture", inputSchema: { type: "object", properties: { operationId: { type: "string" } }, required: ["operationId"] } }] }));
        server.setRequestHandler(CallToolRequestSchema, async (message) => {
            calls.push(message.params.arguments ?? {});
            return { content: [{ type: "text", text: JSON.stringify({ args: message.params.arguments, accidental: token + cfSecret }) }], _meta: { accidental: cfSecret } };
        });
        const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
        await server.connect(transport);
        const response = await transport.handleRequest(request);
        await server.close();
        return response;
    } });
    try { await run({ url: `http://127.0.0.1:${http.port}/mcp`, calls, rejectCalls: () => { reject = true; } }); }
    finally { await http.stop(true); }
}

async function bridgeClient(endpoint: string, run: (client: import("@modelcontextprotocol/sdk/client/index.js").Client, stderr: () => string) => Promise<void>) {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    const cwd = await mkdtemp(join(tmpdir(), "hub-mcp-bridge-"));
    const transport = new StdioClientTransport({ command: process.execPath, args: ["--no-env-file", "--config=/dev/null", entry, "mcp", "--url", endpoint], cwd, env: { ...env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }, stderr: "pipe" });
    let stderr = "";
    transport.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    const client = new Client({ name: "fixture-editor", version: "1" });
    try { await client.connect(transport, { timeout: 5000 }); await run(client, () => stderr); }
    finally { await client.close(); await rm(cwd, { recursive: true, force: true }); }
}

test("actual SDK subprocess stdio bridge initializes, lists, forwards exact arguments and redacts secrets", async () => {
    await remoteFixture(async ({ url, calls }) => {
        await bridgeClient(url, async (client, stderr) => {
            const tools = await client.listTools();
            expect(tools.tools.map(tool => tool.name)).toEqual(["echo_operation"]);
            const result = await client.callTool({ name: "echo_operation", arguments: { operationId: "same-operation-123" } });
            expect(calls).toEqual([{ operationId: "same-operation-123" }]);
            const output = JSON.stringify(result);
            expect(output).toContain("same-operation-123");
            expect(output).not.toContain(token);
            expect(output).not.toContain(cfSecret);
            expect(output).toContain("[REDACTED]");
            expect(stderr()).not.toContain(token);
            expect(stderr()).not.toContain(cfSecret);
        });
    });
}, 15000);

test("remote auth failure is sanitized and an uncertain tool operation is not retried", async () => {
    await remoteFixture(async ({ url, calls, rejectCalls }) => {
        await bridgeClient(url, async (client, stderr) => {
            await client.listTools(); rejectCalls();
            const result = await client.callTool({ name: "echo_operation", arguments: { operationId: "never-auto-retry" } });
            expect(result.isError).toBe(true);
            expect(JSON.stringify(result)).toContain("Remote Hub MCP request failed");
            expect(JSON.stringify(result) + stderr()).not.toContain(token);
            expect(JSON.stringify(result) + stderr()).not.toContain(cfSecret);
            expect(calls).toEqual([{ rejected: true }]);
        });
    });
}, 15000);

test("HTTP redirect never forwards machine credentials to a second server", async () => {
    let leaked = 0;
    const target = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { leaked++; return new Response("unexpected"); } });
    const redirect = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return new Response(null, { status: 307, headers: { Location: `http://127.0.0.1:${target.port}/steal` } }); } });
    try {
        await expect(bridgeClient(`http://127.0.0.1:${redirect.port}/mcp`, async () => {})).rejects.toThrow();
        expect(leaked).toBe(0);
    } finally { await redirect.stop(true); await target.stop(true); }
}, 15000);


test("stdio EOF closes a connected bridge without a protocol handshake or hanging", async () => {
    await remoteFixture(async ({ url }) => {
        const child = Bun.spawn([process.execPath, "--no-env-file", "--config=/dev/null", entry, "mcp", "--url", url], { env: { ...env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
        child.stdin.end();
        const timer = setTimeout(() => { child.kill(); }, 4000);
        try {
            expect(await child.exited).toBe(0);
            expect(await new Response(child.stdout).text()).toBe("");
            expect(await new Response(child.stderr).text()).toBe("");
        } finally { clearTimeout(timer); child.kill(); }
    });
}, 6000);
