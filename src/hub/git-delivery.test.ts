import { createHash } from "node:crypto";
import { test, expect } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deliverRevision } from "./git-delivery";
import type { CodeRevision } from "./contracts";
async function git(cwd: string, ...args: string[]) {
    const p = Bun.spawn(["git", "-c", "core.hooksPath=/dev/null", ...args], {
        cwd, stdout: "pipe", stderr: "pipe"
    });
    const out = await new Response(p.stdout).text();
    if (await p.exited)
        throw Error(await new Response(p.stderr).text());
    return out.trim();
}
test("delivery preserves concurrent remote edits, publishes selected delta and reconciles retry", async () => {
    const root = await mkdtemp(join(tmpdir(), "hub-git-"));
    try {
        await git(root, "init", "--bare", "remote.git");
        await git(root, "clone", join(root, "remote.git"), "seed");
        const seed = join(root, "seed");
        await git(seed, "config", "user.name", "Test");
        await git(seed, "config", "user.email", "test@example.test");
        await writeFile(join(seed, "one"), "base\n");
        await git(seed, "add", ".");
        await git(seed, "commit", "-m", "base");
        await git(seed, "branch", "-M", "main");
        await git(seed, "push", "origin", "main");
        const base = await git(seed, "rev-parse", "HEAD");
        await writeFile(join(seed, "remote"), "keep\n");
        await git(seed, "add", ".");
        await git(seed, "commit", "-m", "remote advance");
        await git(seed, "push", "origin", "main");
        const head = await git(seed, "rev-parse", "HEAD");
        const revision: CodeRevision = {
            id: "r", projectId: "p", gitBaseSha: base, baseRevisionId: null, message: "selected", createdAt: "", createdBy: "a", treeDigest: "", files: [{
                    path: "one", mode: "100644", contentBase64: Buffer.from("chosen\n").toString("base64"), contentDigest: ""
                }]
        };
        const req = {
            dataDir: join(root, "data"), projectId: "p", operationId: "op", revision, remoteUrl: join(root, "remote.git"), baseBranch: "main"
        };
        const result = await deliverRevision(req);
        expect(result.status).toBe("published");
        if (result.status !== "published")
            return;
        expect(await git(seed, "ls-remote", "origin", "refs/heads/main")).toContain(head);
        await git(seed, "fetch", "origin", result.branch);
        expect(await git(seed, "show", `${result.commitSha}:remote`)).toBe("keep");
        expect(await git(seed, "show", `${result.commitSha}:one`)).toBe("chosen");
        expect(await deliverRevision(req)).toEqual(result);
        const h = (value: string) => createHash("sha256").update(value).digest("hex");
        await rm(join(root, "data", "git", h("p"), `${h("op")}.json`));
        expect(await deliverRevision(req)).toEqual(result);
        const deleted = await deliverRevision({
            ...req, operationId: "deleted", revision: { ...revision, files: [] }
        });
        expect(deleted.status).toBe("published");
        if (deleted.status === "published") {
            await git(seed, "fetch", "origin", deleted.branch);
            expect(await git(seed, "ls-tree", "--name-only", deleted.commitSha)).toBe("remote");
        }
        const unchanged = await deliverRevision({
            ...req, operationId: "unchanged", revision: { ...revision, files: [{
                        path: "one", mode: "100644", contentBase64: Buffer.from("base\n").toString("base64"), contentDigest: ""
                    }] }
        });
        expect(unchanged.status).toBe("published");
        if (unchanged.status === "published") {
            await git(seed, "fetch", "origin", unchanged.branch);
            expect(await git(seed, "show", `${unchanged.commitSha}:one`)).toBe("base");
            expect(await git(seed, "show", `${unchanged.commitSha}:remote`)).toBe("keep");
        }
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});
test("delivery rejects option injection and traversal without invoking remotes", async () => {
    const result = await deliverRevision({
        dataDir: "/tmp/hub-unused", projectId: "p", operationId: "op", revision: { files: [], gitBaseSha: "x" } as unknown as CodeRevision, remoteUrl: "--upload-pack=evil", baseBranch: "main"
    });
    expect(result.status).toBe("failed");
});
test("three-way conflict fails visibly without publishing or moving base", async () => {
    const root = await mkdtemp(join(tmpdir(), "hub-conflict-"));
    try {
        await git(root, "init", "--bare", "remote.git");
        await git(root, "clone", join(root, "remote.git"), "seed");
        const seed = join(root, "seed");
        await git(seed, "config", "user.name", "Test");
        await git(seed, "config", "user.email", "test@example.test");
        await writeFile(join(seed, "file"), "base\n");
        await git(seed, "add", ".");
        await git(seed, "commit", "-m", "base");
        await git(seed, "branch", "-M", "main");
        await git(seed, "push", "origin", "main");
        const base = await git(seed, "rev-parse", "HEAD");
        await writeFile(join(seed, "file"), "remote\n");
        await git(seed, "commit", "-am", "remote change");
        await git(seed, "push", "origin", "main");
        const head = await git(seed, "rev-parse", "HEAD");
        const revision: CodeRevision = {
            id: "r", projectId: "p", gitBaseSha: base, baseRevisionId: null, message: "candidate", createdAt: "", createdBy: "a", treeDigest: "", files: [{
                    path: "file", mode: "100644", contentBase64: Buffer.from("local\n").toString("base64"), contentDigest: ""
                }]
        };
        const result = await deliverRevision({
            dataDir: join(root, "data"), projectId: "p", operationId: "conflict", revision, remoteUrl: join(root, "remote.git"), baseBranch: "main"
        });
        expect(result).toMatchObject({ status: "conflict" });
        expect(await git(seed, "ls-remote", "--heads", "origin")).toBe(`${head}\trefs/heads/main`);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});
