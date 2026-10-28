import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HubConnector } from "./connector";
import type { ContextResponse, HubDocument } from "./contracts";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const document = (id = "a", content = "# Accepted context", version = 1): HubDocument => ({
    id, projectId: "p", path: `wiki/${id}.md`, kind: "wiki", content, contentDigest: hash(content), version,
    approval: "accepted", sourceRevision: "source-sha", acceptedBy: "human-owner", acceptedAt: "2026-10-24T00:00:00Z"
});
const snapshot = (revision: number, documents: HubDocument[], fullSnapshot = true): ContextResponse => ({
    revision, fullSnapshot, documents, deletedDocumentIds: [],
    manifest: documents.map(({ id, path, kind, version, contentDigest }) => ({ id, path, kind, version, contentDigest }))
});
async function fixture(run: (f: { connector: HubConnector; root: string; cwd: string; cachePath: string; requests: URL[]; respond: (f: (request: Request) => Response | Promise<Response>) => void }) => Promise<void>) {
    const root = await mkdtemp(join(tmpdir(), "hub-watch-behavior-"));
    const cwd = join(root, "checkout");
    await mkdir(cwd);
    let reply = (_request: Request): Response | Promise<Response> => Response.json(snapshot(1, [document()]));
    const requests: URL[] = [];
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
        const url = new URL(request.url);
        if (!url.pathname.endsWith("/context")) return Response.json({ id: "p", version: 1 });
        requests.push(url);
        return reply(request);
    } });
    const cacheRoot = join(root, "cache");
    const connector = new HubConnector({ cwd, cacheRoot, token: "fixture-secret-do-not-print" });
    try {
        const binding = await connector.connect(server.url.toString(), "p");
        const cachePath = join(cacheRoot, hash(`${binding.url}/p`), "context.json");
        await run({ connector, root, cwd, cachePath, requests, respond(f) { reply = f; } });
    } finally { server.stop(true); await rm(root, { recursive: true, force: true }); }
}

// AC2: sync remains the public transaction boundary shared by one-shot and watch.
test("incremental additions/updates/deletions and full fallback preserve approval provenance", async () => {
    await fixture(async ({ connector, cachePath, requests, respond }) => {
        await connector.sync();
        const b = document("b", "# New accepted page");
        respond(() => Response.json({ ...snapshot(2, [b], false), deletedDocumentIds: ["a"] }));
        await connector.sync();
        expect(requests.map(r => r.searchParams.get("after"))).toEqual([null, "1"]);
        expect(JSON.parse(await readFile(cachePath, "utf8")).documents).toEqual([b]);
        const c = document("c");
        respond(() => Response.json(snapshot(3, [c])));
        await connector.sync();
        expect(JSON.parse(await readFile(cachePath, "utf8")).documents).toEqual([c]);
        expect((await stat(cachePath)).mode & 0o777).toBe(0o600);
    });
});

test("unchanged response preserves cache/index inodes, original text and initial backup", async () => {
    await fixture(async ({ connector, cwd, cachePath, respond }) => {
        const index = join(cwd, ".metaproject", "index.md");
        await writeFile(index, "# Local routing\nKeep this exactly.\n");
        await connector.sync();
        const beforeCache = await stat(cachePath), beforeIndex = await stat(index);
        const beforeText = await readFile(index, "utf8");
        respond(() => Response.json({ ...snapshot(1, [document()], false), documents: [] }));
        await connector.sync();
        expect((await stat(cachePath)).ino).toBe(beforeCache.ino);
        expect((await stat(index)).ino).toBe(beforeIndex.ino);
        expect(await readFile(index, "utf8")).toBe(beforeText);
        expect(beforeText).toContain("# Local routing\nKeep this exactly.\n");
    });
});

const invalidResponses: [string, (response: ContextResponse) => unknown][] = [
    ["regressing revision", r => ({ ...r, revision: 0 })],
    ["unsafe cursor", r => ({ ...r, revision: Number.MAX_SAFE_INTEGER + 1 })],
    ["negative cursor", r => ({ ...r, revision: -1 })],
    ["digest mismatch", r => ({ ...r, documents: [{ ...r.documents[0], content: "tampered" }] })],
    ["duplicate manifest ID", r => ({ ...r, manifest: [...r.manifest, r.manifest[0]] })],
    ["duplicate document ID", r => ({ ...r, documents: [...r.documents, r.documents[0]] })],
    ["wrong project", r => ({ ...r, documents: [{ ...r.documents[0], projectId: "other" }] })],
    ["invalid kind", r => ({ ...r, documents: [{ ...r.documents[0], kind: "code" }] })],
    ["approval array cannot stand in for literal enum", r => ({ ...r, documents: [{ ...r.documents[0], approval: ["accepted"] }] })],
    ["kind array cannot stand in for literal enum", r => ({ ...r, documents: [{ ...r.documents[0], kind: ["wiki"] }] })],
    ["manifest mismatch", r => ({ ...r, manifest: [] })],
    ["missing required provenance", r => ({ ...r, documents: [{ ...r.documents[0], sourceRevision: undefined }] })],
    ["duplicate paths", _r => { const other = { ...document("b"), path: document().path }; return snapshot(2, [document(), other]); }],
];
for (const [name, mutate] of invalidResponses) test(`invalid context: ${name} preserves last committed bytes`, async () => {
    await fixture(async ({ connector, cachePath, respond }) => {
        await connector.sync();
        const before = await readFile(cachePath, "utf8");
        respond(() => Response.json(mutate(snapshot(2, [document()]))));
        await expect(connector.sync()).rejects.toMatchObject({ code: "invalid-context" });
        expect(await readFile(cachePath, "utf8")).toBe(before);
    });
});

test("a delta without prior cache fails instead of creating a partial snapshot", async () => {
    await fixture(async ({ connector, cachePath, respond }) => {
        respond(() => Response.json(snapshot(1, [document()], false)));
        await expect(connector.sync()).rejects.toMatchObject({ code: "invalid-context" });
        expect(await Bun.file(cachePath).exists()).toBe(false);
    });
});

for (const corrupt of ["{broken", JSON.stringify({ revision: "1", manifest: [], documents: [] }), JSON.stringify({ revision: 1, manifest: [], documents: [document()] })]) {
    test("corrupt existing cache is preserved and fails before network", async () => {
        await fixture(async ({ connector, cachePath, requests }) => {
            await connector.sync();
            await writeFile(cachePath, corrupt);
            const count = requests.length;
            await expect(connector.sync()).rejects.toMatchObject({ code: "invalid-cache" });
            expect(requests.length).toBe(count);
            expect(await readFile(cachePath, "utf8")).toBe(corrupt);
        });
    });
}

test("index update failure reports committed revision while preserving original index", async () => {
    await fixture(async ({ connector, cwd, cachePath }) => {
        const index = join(cwd, ".metaproject", "index.md");
        const original = "# Original\n<!-- keryx:hub:begin -->\nmissing closing marker\n";
        await writeFile(index, original);
        await expect(connector.sync()).rejects.toMatchObject({ code: "index-update-failed", revision: 1 });
        expect(JSON.parse(await readFile(cachePath, "utf8")).revision).toBe(1);
        expect(await readFile(index, "utf8")).toBe(original);
    });
});

// The single injection is a cancellable scheduler; all syncs use actual HTTP and filesystem.
async function watcher() { return (await import("./context-watch")).watchHubContext; }
test("watch immediately syncs, waits after completed cycles, and stops without another poll", async () => {
    const watch = await watcher();
    await fixture(async ({ connector, requests, cachePath }) => {
        const controller = new AbortController();
        const events: { state: string; revision?: number }[] = [];
        const sleeps: number[] = [];
        await watch({ connector, signal: controller.signal, onEvent: (event: { state: string; revision?: number }) => events.push(event), sleep: async (seconds: number) => {
            sleeps.push(seconds);
            expect(JSON.parse(await readFile(cachePath, "utf8")).revision).toBe(1);
            if (sleeps.length === 2) controller.abort();
        } });
        expect(sleeps).toEqual([15, 15]);
        expect(requests.length).toBe(2);
        expect(events.map(e => e.state)).toEqual(["updated", "unchanged", "stopped"]);
    });
});

for (const status of [408, 429, 500, 503]) test(`transient HTTP ${status} backs off, retains context and resets after recovery`, async () => {
    const watch = await watcher();
    await fixture(async ({ connector, cachePath, respond }) => {
        await connector.sync();
        const before = await readFile(cachePath, "utf8");
        const controller = new AbortController();
        let attempts = 0;
        respond(() => { attempts++; return attempts <= 5 || attempts === 7 ? Response.json({ error: { message: "fixture-secret-do-not-print" } }, { status }) : Response.json(snapshot(2, [document("b")])); });
        const delays: number[] = [], events: Record<string, unknown>[] = [];
        await watch({ connector, intervalSeconds: 5, signal: controller.signal, onEvent: (e: Record<string, unknown>) => events.push(e), sleep: async (seconds: number) => {
            delays.push(seconds);
            if (attempts <= 5) expect(await readFile(cachePath, "utf8")).toBe(before);
            if (attempts === 7) controller.abort();
        } });
        expect(delays).toEqual([5, 10, 20, 40, 60, 5, 5]);
        expect(events.filter(e => e.state === "retrying").length).toBe(6);
        expect(JSON.stringify(events)).not.toContain("fixture-secret-do-not-print");
        for (const e of events) {
            expect(Object.keys(e).every(k => ["state", "revision", "errorCode", "retryAfterSeconds"].includes(k))).toBe(true);
            expect(Buffer.byteLength(JSON.stringify(e))).toBeLessThanOrEqual(2048);
        }
    });
});
for (const [status, code] of [[401, "unauthorized"], [403, "forbidden"], [404, "permanent-http"]] as const) test(`HTTP ${status} is fatal and sanitized with no retry`, async () => {
    const watch = await watcher();
    await fixture(async ({ connector, respond, requests }) => {
        respond(() => Response.json({ error: { message: "fixture-secret-do-not-print" } }, { status }));
        const events: unknown[] = [], sleeps: number[] = [];
        await expect(watch({ connector, intervalSeconds: 5, signal: new AbortController().signal, onEvent: (e: unknown) => events.push(e), sleep: async (s: number) => { sleeps.push(s); } })).rejects.toMatchObject({ code });
        expect(requests.length).toBe(1);
        expect(sleeps).toEqual([]);
        expect(events).toContainEqual({ state: "fatal", errorCode: code });
        expect(JSON.stringify(events)).not.toContain("fixture-secret-do-not-print");
    });
});

test("aborting in-flight HTTP prevents committing its late response and releases owned lock", async () => {
    const watch = await watcher();
    await fixture(async ({ connector, respond, cachePath }) => {
        const controller = new AbortController();
        let release!: () => void;
        let started!: () => void;
        const begun = new Promise<void>(resolve => { started = resolve; });
        const delayed = new Promise<void>(resolve => { release = resolve; });
        respond(async () => { started(); await delayed; return Response.json(snapshot(2, [document()])); });
        const events: { state: string }[] = [];
        const running = watch({ connector, signal: controller.signal, onEvent: (e: { state: string }) => events.push(e) });
        await begun;
        controller.abort(); release();
        await running;
        expect(await Bun.file(cachePath).exists()).toBe(false);
        expect(events.at(-1)?.state).toBe("stopped");
        respond(() => Response.json(snapshot(3, [document()])));
        expect((await connector.sync()).revision).toBe(3);
    });
}, 5000);

test("watch recovers from a real disconnected HTTP endpoint without losing last good cache", async () => {
    const watch = await watcher();
    const root = await mkdtemp(join(tmpdir(), "hub-watch-offline-"));
    const controller = new AbortController();
    let server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) { return Response.json(new URL(request.url).pathname.endsWith("/context") ? snapshot(1, [document()]) : { id: "p" }); } });
    const port = server.port!;
    const connector = new HubConnector({ cwd: root, cacheRoot: join(root, "cache"), token: "offline-test-token" });
    try {
        await connector.connect(server.url.toString(), "p");
        const initial = await connector.sync();
        const cachePath = join(initial.cacheDir, "context.json"), before = await readFile(cachePath, "utf8");
        server.stop(true);
        const events: { state: string; errorCode?: string; revision?: number; retryAfterSeconds?: number }[] = [];
        await watch({ connector, intervalSeconds: 5, signal: controller.signal, onEvent: (e: { state: string; errorCode?: string; revision?: number; retryAfterSeconds?: number }) => events.push(e), sleep: async () => {
            if (events.at(-1)?.state === "retrying") {
                expect(await readFile(cachePath, "utf8")).toBe(before);
                server = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => Response.json(snapshot(2, [document("b")])) });
            } else controller.abort();
        } });
        expect(events.map(e => e.state)).toEqual(["retrying", "updated", "stopped"]);
        expect(events[0]).toEqual({ state: "retrying", errorCode: "network", revision: 1, retryAfterSeconds: 5 });
        expect(JSON.parse(await readFile(cachePath, "utf8")).revision).toBe(2);
    } finally { controller.abort(); server.stop(true); await rm(root, { recursive: true, force: true }); }
});

test("HTTP body interrupted after headers retries as network failure and recovers", async () => {
    const watch = await watcher();
    const root = await mkdtemp(join(tmpdir(), "hub-watch-body-drop-"));
    let requests = 0;
    const server = createServer((request, response) => {
        response.setHeader("Content-Type", "application/json");
        if (!request.url?.includes("/context")) { response.end(JSON.stringify({ id: "p" })); return; }
        requests++;
        if (requests === 2) {
            response.writeHead(200, { "Content-Length": "99999" });
            response.write('{"revision":2,"documents":[');
            setTimeout(() => response.destroy(), 10);
        } else response.end(JSON.stringify(snapshot(requests === 1 ? 1 : 2, [document()])));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw Error("Expected loopback fixture listener");
    const connector = new HubConnector({ cwd: root, cacheRoot: join(root, "cache"), token: "body-fixture-token" });
    const controller = new AbortController();
    try {
        await connector.connect(`http://127.0.0.1:${address.port}`, "p");
        const initial = await connector.sync();
        const cachePath = join(initial.cacheDir, "context.json"), before = await readFile(cachePath, "utf8");
        const events: { state: string; errorCode?: string }[] = [];
        await watch({ connector, intervalSeconds: 5, signal: controller.signal, onEvent: e => events.push(e), sleep: async () => {
            if (events.at(-1)?.state === "retrying") expect(await readFile(cachePath, "utf8")).toBe(before);
            else controller.abort();
        } });
        expect(events.map(e => e.state)).toEqual(["retrying", "updated", "stopped"]);
        expect(events[0]?.errorCode).toBe("network");
        expect(requests).toBe(3);
        expect(JSON.parse(await readFile(cachePath, "utf8")).revision).toBe(2);
    } finally {
        controller.abort(); server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
        await rm(root, { recursive: true, force: true });
    }
}, 5000);

test("complete malformed JSON is a protocol failure and preserves committed bytes", async () => {
    await fixture(async ({ connector, cachePath, respond }) => {
        await connector.sync();
        const before = await readFile(cachePath, "utf8");
        respond(() => new Response('{"broken":', { headers: { "Content-Type": "application/json" } }));
        await expect(connector.sync()).rejects.toMatchObject({ code: "invalid-context" });
        expect(await readFile(cachePath, "utf8")).toBe(before);
    });
});

test("watch cache-busy uses normal interval and resumes after owner releases transaction", async () => {
    const watch = await watcher();
    await fixture(async ({ connector, respond, requests }) => {
        let release!: () => void, started!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const begun = new Promise<void>(resolve => { started = resolve; });
        respond(async () => { started(); await gate; return Response.json(snapshot(1, [document()])); });
        const owner = connector.sync();
        const controller = new AbortController();
        try {
            await begun;
            const events: { state: string; errorCode?: string }[] = [], delays: number[] = [];
            await watch({ connector, intervalSeconds: 5, signal: controller.signal, onEvent: e => events.push(e), sleep: async seconds => {
                delays.push(seconds);
                if (events.at(-1)?.state === "busy") { expect(requests.length).toBe(1); release(); await owner; }
                else controller.abort();
            } });
            expect(delays).toEqual([5, 5]);
            expect(events.map(e => e.state)).toEqual(["busy", "unchanged", "stopped"]);
            expect(events[0]?.errorCode).toBe("cache-busy");
            expect(requests.length).toBe(2);
        } finally { release(); controller.abort(); await owner; }
    });
}, 5000);

test("cache with array approval fails before polling and preserves invalid bytes for recovery", async () => {
    await fixture(async ({ connector, cachePath, requests }) => {
        await connector.sync();
        const cached = JSON.parse(await readFile(cachePath, "utf8"));
        cached.documents[0].approval = ["accepted"];
        const corrupt = JSON.stringify(cached);
        await writeFile(cachePath, corrupt);
        const count = requests.length;
        await expect(connector.sync()).rejects.toMatchObject({ code: "invalid-cache" });
        expect(requests.length).toBe(count);
        expect(await readFile(cachePath, "utf8")).toBe(corrupt);
    });
});

test("stopped revision reflects atomic cache commit when cancellation interrupts index update", async () => {
    const watch = await watcher();
    await fixture(async ({ connector, cwd, cachePath, respond, requests }) => {
        let revision = 0;
        respond(() => Response.json(snapshot(++revision, [document()])));
        const controller = new AbortController();
        const events: { state: string; revision?: number }[] = [];
        // Trigger cancellation precisely after cache replacement and before the second index write.
        // Keep actual HTTP, cache transaction, index maintenance and watcher execution intact.
        const original = Reflect.get(connector, "updateContextIndex");
        if (typeof original !== "function") throw Error("Expected connector index transaction boundary");
        let indexCalls = 0;
        Object.defineProperty(connector, "updateContextIndex", { configurable: true, value: async (...args: unknown[]) => {
            if (++indexCalls === 2) controller.abort();
            return Reflect.apply(original, connector, args);
        } });
        try {
            await watch({ connector, signal: controller.signal, onEvent: event => events.push(event), sleep: async () => {
                await writeFile(join(cwd, ".metaproject", "index.md"), "# Changed local routing\n");
            } });
            expect(requests.length).toBe(2);
            expect(JSON.parse(await readFile(cachePath, "utf8")).revision).toBe(2);
            expect(events.at(-1)).toEqual({ state: "stopped", revision: 2 });
            expect(await readFile(join(cwd, ".metaproject", "index.md"), "utf8")).toBe("# Changed local routing\n");
            // Owned lock was released even though post-commit index maintenance was cancelled.
            expect((await connector.sync()).revision).toBe(3);
        } finally { Reflect.deleteProperty(connector, "updateContextIndex"); controller.abort(); }
    });
}, 5000);
