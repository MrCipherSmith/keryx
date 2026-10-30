import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { HubConnector } from "./connector";

const clientEntry = resolve(import.meta.dir, "client-main.ts");
const connectorEntry = resolve(import.meta.dir, "connector.ts");
const empty = (revision: number) => ({ revision, fullSnapshot: true, documents: [], manifest: [], deletedDocumentIds: [] });
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, timeout = 2000) {
    const deadline = Date.now() + timeout;
    while (!(await check())) { if (Date.now() > deadline) throw Error("Timed out waiting for observed fixture behavior"); await pause(10); }
}
async function output(child: ReturnType<typeof Bun.spawn>) {
    const timer = setTimeout(() => child.kill("SIGKILL"), 4000);
    try {
        const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout instanceof ReadableStream ? child.stdout : null).text(), new Response(child.stderr instanceof ReadableStream ? child.stderr : null).text()]);
        return { code, stdout, stderr };
    } finally { clearTimeout(timer); }
}
async function setup(run: (root: string, env: Record<string, string>, cli: (args: string[], cwd?: string) => ReturnType<typeof Bun.spawn>) => Promise<void>) {
    const root = await mkdtemp(join(tmpdir(), "hub-watch-process-"));
    const env = { PATH: process.env.PATH ?? "", HOME: root, XDG_CONFIG_HOME: join(root, "config"), XDG_CACHE_HOME: join(root, "cache"), KERYX_HUB_TOKEN: "isolated-test-secret", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" };
    const cli = (args: string[], cwd = root) => Bun.spawn([process.execPath, "--no-env-file", "--config=/dev/null", clientEntry, ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
    try { await run(root, env, cli); } finally { await rm(root, { recursive: true, force: true }); }
}

// AC1: parser validation is tested via the real standalone executable, before enrollment.
for (const flags of [["--interval", "5"], ["--watch", "--interval", "4"], ["--watch", "--interval", "3601"], ["--watch", "--interval", "5.5"], ["--watch", "--interval", "NaN"], ["--watch", "--interval"], ["--watch", "--watch"], ["--watch", "--unknown"], ["--watch", "--token-env"]]) {
    test(`CLI rejects ${flags.join(" ")} without writes or secret exposure`, async () => {
        await setup(async (root, _env, cli) => {
            const result = await output(cli(["sync", ...flags]));
            expect(result.code).not.toBe(0);
            expect(result.stderr + result.stdout).not.toContain("isolated-test-secret");
            expect(await readdir(root)).toEqual([]);
        });
    });
}

test("standalone watch performs immediate HTTP sync and SIGTERM stops idle sleep successfully", async () => {
    await setup(async (root, _env, cli) => {
        let requests = 0;
        const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
            if (new URL(request.url).pathname.endsWith("/context")) { requests++; return Response.json(empty(1)); }
            return Response.json({ id: "p" });
        } });
        let child: ReturnType<typeof Bun.spawn> | undefined;
        try {
            expect((await output(cli(["connect", "--url", server.url.toString(), "--project", "p"]))).code).toBe(0);
            child = cli(["sync", "--watch"]);
            await until(() => requests === 1);
            // Wait for the complete committed cache/index, then interrupt its default 15s sleep.
            await until(() => Bun.file(join(root, ".metaproject", "index.md")).exists());
            child.kill("SIGTERM");
            const result = await output(child);
            expect(result.code).toBe(0);
            const events = result.stdout.trim().split("\n").map(line => JSON.parse(line));
            expect(events[0]).toEqual({ state: "updated", revision: 1 });
            expect(events.at(-1)).toEqual({ state: "stopped", revision: 1 });
            expect(requests).toBe(1);
        } finally { child?.kill("SIGKILL"); server.stop(true); }
    });
}, 8000);

test("real two-process transaction lock prevents stale HTTP response and preserves distinct checkout IDs", async () => {
    await setup(async (root, env) => {
        const a = join(root, "one"), b = join(root, "two"), cacheRoot = join(root, "shared");
        await mkdir(a); await mkdir(b);
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const cursors: (string | null)[] = [];
        let hold = true;
        const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
            const url = new URL(request.url);
            if (!url.pathname.endsWith("/context")) return Response.json({ id: "p" });
            cursors.push(url.searchParams.get("after"));
            if (hold) { hold = false; await gate; return Response.json(empty(1)); }
            return Response.json(empty(2));
        } });
        const ca = new HubConnector({ cwd: a, cacheRoot, token: "isolated-test-secret" });
        const cb = new HubConnector({ cwd: b, cacheRoot, token: "isolated-test-secret" });
        const oneShot = (cwd: string) => Bun.spawn([process.execPath, "--no-env-file", "--config=/dev/null", "--eval", `import {HubConnector} from ${JSON.stringify(connectorEntry)}; const c=new HubConnector(${JSON.stringify({ cwd, cacheRoot, token: "isolated-test-secret" })}); try { console.log(JSON.stringify(await c.sync())); } catch(e) { console.error(JSON.stringify({code:e.code,message:e.message})); process.exitCode=1; }`], { cwd, env, stdout: "pipe", stderr: "pipe" });
        let first: ReturnType<typeof Bun.spawn> | undefined, second: ReturnType<typeof Bun.spawn> | undefined;
        try {
            const ba = await ca.connect(server.url.toString(), "p"), bb = await cb.connect(server.url.toString(), "p");
            expect(ba.checkoutId).not.toBe(bb.checkoutId);
            first = oneShot(a);
            await until(() => cursors.length === 1);
            second = oneShot(b);
            const busy = await output(second);
            expect(busy.code).not.toBe(0);
            expect(busy.stderr).toContain("cache-busy");
            expect(cursors).toEqual([null]);
            release();
            expect((await output(first)).code).toBe(0);
            expect((await output(oneShot(b))).code).toBe(0);
            expect(cursors).toEqual([null, "1"]);
            const cache = join(cacheRoot, hash(`${ba.url}/p`), "context.json");
            expect(JSON.parse(await readFile(cache, "utf8")).revision).toBe(2);
            expect(await readFile(join(a, ".metaproject", "hub.json"), "utf8")).toContain(ba.checkoutId);
            expect(await readFile(join(b, ".metaproject", "hub.json"), "utf8")).toContain(bb.checkoutId);
        } finally { release(); first?.kill("SIGKILL"); second?.kill("SIGKILL"); server.stop(true); }
    });
}, 10000);

test("credential revocation stops real watch nonzero without exposing remote diagnostics", async () => {
    await setup(async (root, _env, cli) => {
        let requests = 0;
        const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
            if (new URL(request.url).pathname.endsWith("/context")) { requests++; return Response.json({ error: { message: "isolated-test-secret private remote content" } }, { status: 403 }); }
            return Response.json({ id: "p" });
        } });
        try {
            expect((await output(cli(["connect", "--url", server.url.toString(), "--project", "p"]))).code).toBe(0);
            const result = await output(cli(["sync", "--watch", "--interval", "5"]));
            expect(result.code).not.toBe(0);
            expect(requests).toBe(1);
            expect(result.stdout).toContain('"errorCode":"forbidden"');
            expect(result.stdout + result.stderr).not.toContain("isolated-test-secret");
            expect(result.stdout + result.stderr).not.toContain("private remote content");
        } finally { server.stop(true); }
    });
}, 7000);

test("SIGINT cancels an in-flight real HTTP watch without committing a late response", async () => {
    await setup(async (root, _env, cli) => {
        let requests = 0;
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
            if (!new URL(request.url).pathname.endsWith("/context")) return Response.json({ id: "p" });
            requests++; await gate; return Response.json(empty(1));
        } });
        let child: ReturnType<typeof Bun.spawn> | undefined;
        try {
            expect((await output(cli(["connect", "--url", server.url.toString(), "--project", "p"]))).code).toBe(0);
            child = cli(["sync", "--watch", "--interval", "5"]);
            await until(() => requests === 1);
            child.kill("SIGINT");
            const stopped = await output(child);
            release();
            expect(stopped.code).toBe(0);
            expect(stopped.stdout.trim().split("\n").map(line => JSON.parse(line)).at(-1)).toEqual({ state: "stopped" });
            const cachePath = join(root, "cache", "keryx", "hub", hash(`${server.url.toString().replace(/\/$/, "")}/p`), "context.json");
            expect(await Bun.file(cachePath).exists()).toBe(false);
            expect(requests).toBe(1);
        } finally { release(); child?.kill("SIGKILL"); server.stop(true); }
    });
}, 8000);

test("killed lock owner is not stolen by a competing one-shot, and reports recovery guidance", async () => {
    await setup(async (root, env) => {
        const cacheRoot = join(root, "shared");
        let requests = 0;
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
            if (!new URL(request.url).pathname.endsWith("/context")) return Response.json({ id: "p" });
            requests++; await gate; return Response.json(empty(1));
        } });
        let owner: ReturnType<typeof Bun.spawn> | undefined;
        try {
            const connector = new HubConnector({ cwd: root, cacheRoot, token: "isolated-test-secret" });
            const binding = await connector.connect(server.url.toString(), "p");
            owner = Bun.spawn([process.execPath, "--no-env-file", "--config=/dev/null", "--eval", `import {HubConnector} from ${JSON.stringify(connectorEntry)}; await new HubConnector(${JSON.stringify({ cwd: root, cacheRoot, token: "isolated-test-secret" })}).sync();`], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
            await until(() => requests === 1);
            owner.kill("SIGKILL"); await owner.exited;
            release();
            let failure: unknown;
            try { await connector.sync(); } catch (error) { failure = error; }
            expect(failure).toMatchObject({ code: "cache-busy" });
            expect((failure as Error).message).toMatch(/recover|manual|owner/i);
            expect(requests).toBe(1);
            expect(await Bun.file(join(cacheRoot, hash(`${binding.url}/p`), "context.json")).exists()).toBe(false);
        } finally { release(); owner?.kill("SIGKILL"); server.stop(true); }
    });
}, 7000);
