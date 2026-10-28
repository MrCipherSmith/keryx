import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HubConnector, snapshotTrackedFiles } from "./connector";

test("review bundles cannot be pulled or fetched as a delivery receipt", async () => {
    const root = await mkdtemp(join(tmpdir(), "hub-review-only-"));
    const revision = { id: "bundle", projectId: "p", purpose: "review-bundle", baseRevisionId: null, gitBaseSha: "a".repeat(40), message: "review only", files: [] };
    const server = Bun.serve({ port: 0, fetch(request) {
        const path = new URL(request.url).pathname;
        if (path.endsWith("/revisions/bundle")) return Response.json(revision);
        if (path.endsWith("/deliveries")) return Response.json({ deliveries: [{ id: "delivery", revisionId: "bundle", status: "published", branch: "codex/hub-a-b", commitSha: "b".repeat(40), treeSha: "c".repeat(40), remoteUrl: join(root, "must-not-fetch.git") }] });
        return Response.json({ id: "p", lineRevisionId: "bundle", version: 1 });
    } });
    try {
        await git(root, "init");
        await writeFile(join(root, "keep.txt"), "unfinished local work\n");
        await git(root, "add", "keep.txt");
        await git(root, "-c", "core.hooksPath=/dev/null", "-c", "user.name=Hub Test", "-c", "user.email=hub@example.test", "-c", "commit.gpgsign=false", "commit", "-m", "base");
        const connector = new HubConnector({ cwd: root, token: "agent", cacheRoot: join(root, "cache") });
        await connector.connect(server.url.toString(), "p");
        const bindingPath = join(root, ".metaproject", "hub.json");
        const beforeBinding = await readFile(bindingPath, "utf8");
        const beforeHead = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root }).stdout.toString();
        const beforeRefs = Bun.spawnSync(["git", "show-ref"], { cwd: root }).stdout.toString();
        await expect(connector.pull("bundle", false)).rejects.toThrow("Review bundles cannot be applied to a checkout");
        await expect(connector.pull("bundle", true)).rejects.toThrow("Review bundles cannot be applied to a checkout");
        await expect(connector.pull(undefined, true)).rejects.toThrow("Review bundles cannot be applied to a checkout");
        await expect(connector.fetchDelivery("delivery")).rejects.toThrow("Review bundles cannot have Git delivery receipts");
        expect(await readFile(join(root, "keep.txt"), "utf8")).toBe("unfinished local work\n");
        expect(await readFile(bindingPath, "utf8")).toBe(beforeBinding);
        expect(Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root }).stdout.toString()).toBe(beforeHead);
        expect(Bun.spawnSync(["git", "show-ref"], { cwd: root }).stdout.toString()).toBe(beforeRefs);
    } finally {
        server.stop(true);
        await rm(root, { recursive: true, force: true });
    }
});
async function git(cwd: string, ...args: string[]) {
    const p = Bun.spawn(["git", ...args], {
        cwd, stdout: "pipe", stderr: "pipe"
    });
    if (await p.exited)
        throw Error(await new Response(p.stderr).text());
}
test("snapshot includes executable/binary tracked changes and rejects symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "hub-client-"));
    try {
        await git(root, "init");
        await writeFile(join(root, "binary"), Buffer.from([0, 255, 2]));
        await git(root, "add", ".");
        const files = await snapshotTrackedFiles(root);
        expect(files[0]?.contentBase64).toBe("AP8C");
        await git(root, "update-index", "--add", "--cacheinfo", "120000,0000000000000000000000000000000000000001,link");
        await expect(snapshotTrackedFiles(root)).rejects.toThrow();
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});
test("explicit bindings are distinct and never persist token", async () => {
    const root = await mkdtemp(join(tmpdir(), "hub-bind-"));
    const server = Bun.serve({ port: 0, fetch: () => Response.json({ id: "p", version: 1 }) });
    try {
        const c = new HubConnector({
            cwd: root, token: "secret", cacheRoot: join(root, "cache")
        });
        const a = await c.connect(server.url.toString(), "p");
        const b = await c.connect(server.url.toString(), "p");
        expect(a.checkoutId).toBe(b.checkoutId);
        expect(await readFile(join(root, ".metaproject", "hub.json"), "utf8")).not.toContain("secret");
    }
    finally {
        server.stop(true);
        await rm(root, { recursive: true, force: true });
    }
});
test("live HTTP import/sync, incremental submit/delete and successive guarded pulls across clones", async () => {
    const { createHubApplication } = await import("./server");
    const root = await mkdtemp(join(tmpdir(), "hub-http-"));
    const app = createHubApplication({
        dataDir: join(root, "db"), operatorToken: "human-token-at-least-32-characters-long", agentToken: "agent-token-at-least-32-characters-long"
    });
    const server = Bun.serve({ port: 0, fetch: app.fetch });
    try {
        const human = "human-token-at-least-32-characters-long";
        const headers = {
            Authorization: `Bearer ${human}`, "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID()
        };
        const response = await fetch(`${server.url}hub/v1/projects`, {
            method: "POST", headers, body: JSON.stringify({ name: "two clients" })
        });
        expect(response.ok).toBe(true);
        const project = await response.json() as {
            id: string;
            lineVersion: number;
        };
        const one = join(root, "one"), two = join(root, "two");
        await git(root, "init", "one");
        await git(one, "config", "user.name", "Hub Test");
        await git(one, "config", "user.email", "hub@example.test");
        await writeFile(join(one, "a"), "base\n");
        await writeFile(join(one, "untouched"), "base other\n");
        await git(one, "add", ".");
        await git(one, "-c", "core.hooksPath=/dev/null", "commit", "-m", "base");
        await git(root, "clone", one, "two");
        await git(root, "init", "--bare", "remote.git");
        await git(one, "push", join(root, "remote.git"), "HEAD:refs/heads/main");
        await mkdir(join(one, "openspec", "specs"), { recursive: true });
        await writeFile(join(one, "openspec", "specs", "feature.md"), "# Imported spec\n");
        const a = new HubConnector({
            cwd: one, token: human, cacheRoot: join(root, "cache")
        }), b = new HubConnector({
            cwd: two, token: human, cacheRoot: join(root, "cache")
        });
        const ba = await a.connect(server.url.toString(), project.id), bb = await b.connect(server.url.toString(), project.id);
        expect(ba.checkoutId).not.toBe(bb.checkoutId);
        expect((await a.importDocuments()).imported).toBe(1);
        await writeFile(join(one, ".metaproject", "index.md"), "# Existing routing\n");
        const syncA = await a.sync();
        expect(await readFile(join(one, ".metaproject", "index.md"), "utf8")).toContain("# Existing routing");
        const syncB = await b.sync();
        expect(syncA.cacheDir).toBe(syncB.cacheDir);
        expect((await readFile(join(syncB.cacheDir, "context.json"), "utf8"))).toContain("Imported spec");
        await rm(join(one, "openspec"), { recursive: true });
        await rm(join(one, ".metaproject", "index.md"));
        await rm(join(two, ".metaproject", "index.md"));
        await writeFile(join(one, "a"), "first\n");
        const first = await a.submit("first");
        expect(first.files.length).toBe(2);
        const select = async (id: string, version: number) => {
            const r = await fetch(`${server.url}hub/v1/projects/${project.id}/line`, {
                method: "POST", headers: { ...headers, "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ revisionId: id, expectedVersion: version })
            });
            expect(r.ok).toBe(true);
        };
        await select(first.id, 0);
        expect((await b.pull()).applied).toBe(false);
        expect(await readFile(join(two, "a"), "utf8")).toBe("base\n");
        expect((await b.pull(undefined, true)).checkpoint).toBeDefined();
        await writeFile(join(one, "a"), "second\n");
        await writeFile(join(one, "new"), "new\n");
        await git(one, "add", "new");
        const second = await a.submit("second");
        await select(second.id, 1);
        await writeFile(join(two, "new"), "untracked work\n");
        await expect(b.pull(undefined, true)).rejects.toThrow();
        expect(await readFile(join(two, "new"), "utf8")).toBe("untracked work\n");
        await rm(join(two, "new"));
        await b.pull(undefined, true);
        expect(await readFile(join(two, "a"), "utf8")).toBe("second\n");
        await writeFile(join(two, "a"), "my work\n");
        await expect(b.pull(undefined, true)).rejects.toThrow();
        expect(await readFile(join(two, "a"), "utf8")).toBe("my work\n");
        await git(root, "clone", "--branch", "main", join(root, "remote.git"), "remote-edit");
        const remoteEdit = join(root, "remote-edit");
        await git(remoteEdit, "config", "user.name", "Test");
        await git(remoteEdit, "config", "user.email", "hub@example.test");
        await writeFile(join(remoteEdit, "untouched"), "remote other\n");
        await git(remoteEdit, "-c", "core.hooksPath=/dev/null", "commit", "-am", "remote independent edit");
        await git(remoteEdit, "push", "origin", "main");
        const publication = await fetch(`${server.url}hub/v1/projects/${project.id}/deliveries`, {
            method: "POST", headers: { ...headers, "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({
                revisionId: second.id, remoteUrl: join(root, "remote.git"), baseBranch: "main", expectedLineVersion: 2
            })
        });
        expect(publication.ok).toBe(true);
        const receipt = await publication.json() as {
            id: string;
            status: string;
        };
        expect(receipt.status).toBe("published");
        const fetched = await b.fetchDelivery(receipt.id);
        expect(fetched.reanchor).toBe("manual");
        expect(fetched.preview.some(change => change.path === "untouched" && change.change === "modified")).toBe(true);
        expect(await readFile(join(two, "a"), "utf8")).toBe("my work\n");
        await rm(join(one, "a"));
        const third = await a.submit("delete");
        expect(third.files.map(f => f.path)).toEqual(["new", "untouched"]);
    }
    finally {
        server.stop(true);
        app.close();
        await rm(root, { recursive: true, force: true });
    }
});
test("import batches over 500 bounded documents with sequential expected versions", async () => {
    const root = await mkdtemp(join(tmpdir(), "hub-batch-"));
    let version = 1;
    const counts: number[] = [];
    const server = Bun.serve({ port: 0, async fetch(request) {
            const url = new URL(request.url);
            if (url.pathname.endsWith("/import")) {
                const body = await request.json() as {
                    documents: unknown[];
                    expectedVersion: number;
                };
                expect(body.expectedVersion).toBe(version);
                counts.push(body.documents.length);
                version++;
                return Response.json({
                    documents: [], proposals: [], project: { id: "p", version }, receipt: {}
                });
            }
            return Response.json({ id: "p", version });
        } });
    try {
        await mkdir(join(root, "openspec", "specs"), { recursive: true });
        await Promise.all(Array.from({ length: 501 }, (_, i) => writeFile(join(root, "openspec", "specs", `${i}.md`), "# Spec")));
        const connector = new HubConnector({
            cwd: root, token: "t", cacheRoot: join(root, "cache")
        });
        await connector.connect(server.url.toString(), "p");
        expect((await connector.importDocuments()).imported).toBe(501);
        expect(counts).toEqual([500, 1]);
    }
    finally {
        server.stop(true);
        await rm(root, { recursive: true, force: true });
    }
});
test("sync refuses a symlink index without altering the outside target", async () => {
    const { symlink } = await import("node:fs/promises");
    const root = await mkdtemp(join(tmpdir(), "hub-index-"));
    const server = Bun.serve({ port: 0, fetch(request) {
            if (new URL(request.url).pathname.endsWith("/context"))
                return Response.json({
                    revision: 0, fullSnapshot: true, manifest: [], documents: [], deletedDocumentIds: []
                });
            return Response.json({ id: "p" });
        } });
    try {
        const cwd = join(root, "checkout");
        await mkdir(cwd);
        const connector = new HubConnector({
            cwd, token: "t", cacheRoot: join(root, "cache")
        });
        await connector.connect(server.url.toString(), "p");
        const outside = join(root, "outside.md");
        await writeFile(outside, "private original\n");
        await symlink(outside, join(cwd, ".metaproject", "index.md"));
        await expect(connector.sync()).rejects.toThrow();
        expect(await readFile(outside, "utf8")).toBe("private original\n");
        await rm(join(cwd, ".metaproject"), { recursive: true });
        const outsideMeta = join(root, "outside-meta");
        await mkdir(outsideMeta);
        await writeFile(join(outsideMeta, "index.md"), "external routing\n");
        await symlink(outsideMeta, join(cwd, ".metaproject"));
        await expect(connector.sync()).rejects.toThrow();
        expect(await readFile(join(outsideMeta, "index.md"), "utf8")).toBe("external routing\n");
    }
    finally {
        server.stop(true);
        await rm(root, { recursive: true, force: true });
    }
});
