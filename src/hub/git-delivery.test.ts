import { createHash } from "node:crypto";
import { test, expect } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitDelivery, deliverRevision, hubGit, type HubGitRunner } from "./git-delivery";
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
/** A bare remote whose main holds one commit; returns its path and that commit. */
async function seedRemote(root: string): Promise<{ remoteUrl: string; base: string }> {
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
    return { remoteUrl: join(root, "remote.git"), base: await git(seed, "rev-parse", "HEAD") };
}
/** Runs every call through the real hardened git, recording its argv; `answer` may stand in for the remote. */
function recordingGit(calls: string[][], answer?: (args: string[]) => Buffer | undefined): HubGitRunner {
    return async (cwd, args, input) => {
        calls.push([...args]);
        return answer?.(args) ?? hubGit(cwd, args, input);
    };
}
const selected = (gitBaseSha: string): CodeRevision => ({
    id: "r", projectId: "p", gitBaseSha, baseRevisionId: null, message: "selected", createdAt: "", createdBy: "a", treeDigest: "", files: [{
            path: "one", mode: "100644", contentBase64: Buffer.from("chosen\n").toString("base64"), contentDigest: ""
        }]
});
test("every git call that carries the remote URL or a revision puts --end-of-options before it", async () => {
    const root = await mkdtemp(join(tmpdir(), "hub-git-operands-"));
    try {
        const { remoteUrl, base } = await seedRemote(root);
        const calls: string[][] = [];
        const deliver = createGitDelivery(recordingGit(calls));
        const req = { dataDir: join(root, "data"), projectId: "p", operationId: "op", revision: selected(base), remoteUrl, baseBranch: "main" };
        const result = await deliver(req);
        expect(result.status).toBe("published");
        if (result.status !== "published")
            return;
        const verb = (name: string) => calls.filter(args => args[0] === name);
        expect(verb("fetch")[0]).toEqual(["fetch", "--no-tags", "--end-of-options", remoteUrl, "+refs/heads/main:refs/remotes/hub/base"]);
        expect(verb("ls-remote")[0]).toEqual(["ls-remote", "--end-of-options", remoteUrl, `refs/heads/${result.branch}`]);
        expect(verb("cat-file")).toEqual([["cat-file", "-e", "--end-of-options", `${base}^{commit}`]]);
        expect(verb("checkout")[0]).toEqual(["checkout", "--detach", "--end-of-options", base]);
        expect(verb("cherry-pick")[0]?.slice(0, 3)).toEqual(["cherry-pick", "--no-commit", "--end-of-options"]);
        expect(verb("cherry-pick")[0]?.[3]).toMatch(/^[a-f0-9]{40,64}$/);
        expect(verb("push")).toEqual([["push", "--end-of-options", remoteUrl, `${result.commitSha}:refs/heads/${result.branch}`]]);
        // Losing the receipt sends the retry through recovery, which reads the branch the remote reports.
        const h = (value: string) => createHash("sha256").update(value).digest("hex");
        await rm(join(root, "data", "git", h("p"), `${h("op")}.json`));
        calls.length = 0;
        expect(await deliver(req)).toEqual(result);
        expect(verb("fetch")[1]).toEqual(["fetch", "--no-tags", "--end-of-options", remoteUrl, `refs/heads/${result.branch}`]);
        expect(verb("show")).toEqual([["show", "-s", "--format=%B", "--end-of-options", result.commitSha]]);
        expect(verb("rev-parse")).toEqual([["rev-parse", "--verify", "--end-of-options", `${result.commitSha}^{tree}`]]);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});
test("a remote that reports a dash-leading revision is refused by name before git reads it as an option", async () => {
    const root = await mkdtemp(join(tmpdir(), "hub-git-hostile-"));
    const marker = join(root, "show-wrote");
    try {
        const { remoteUrl, base } = await seedRemote(root);
        // One whitespace-free word each: deliverRevision keeps only ls-remote's first column. `--output` makes git show write a file.
        for (const [index, hostile] of [`--output=${marker}`, "-cprotocol.ext.allow=always"].entries()) {
            const calls: string[][] = [];
            // The remote answers ls-remote with a hostile first column, as a compromised remote or transport could.
            const deliver = createGitDelivery(recordingGit(calls, args => args[0] === "ls-remote" ? Buffer.from(`${hostile}\trefs/heads/x\n`)
                : args[0] === "fetch" && args.at(-1)?.startsWith("refs/heads/codex/") ? Buffer.alloc(0) : undefined));
            const result = await deliver({ dataDir: join(root, "data"), projectId: "p", operationId: `op-${index}`, revision: selected(base), remoteUrl, baseBranch: "main" });
            expect(result).toEqual({ status: "failed", error: `Refusing the revision "${hostile}": a revision never starts with "-".` });
            expect(calls.some(args => args[0] === "show")).toBe(false);
        }
        expect(await Bun.file(marker).exists()).toBe(false);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});
test("a dash-leading remote URL or base revision never reaches git", async () => {
    const root = await mkdtemp(join(tmpdir(), "hub-git-refused-"));
    const marker = join(root, "upload-pack-ran");
    try {
        const calls: string[][] = [];
        const deliver = createGitDelivery(recordingGit(calls));
        const request = { dataDir: join(root, "data"), projectId: "p", operationId: "op", revision: selected("a".repeat(40)), remoteUrl: join(root, "remote.git"), baseBranch: "main" };
        expect(await deliver({ ...request, remoteUrl: `--upload-pack=touch ${marker}` })).toEqual({ status: "failed", error: "Unsupported remote URL" });
        expect(await deliver({ ...request, remoteUrl: "-cprotocol.ext.allow=always" })).toEqual({ status: "failed", error: "Unsupported remote URL" });
        expect(await deliver({ ...request, revision: selected(`--upload-pack=touch ${marker}`) })).toEqual({ status: "failed", error: "Invalid Git base SHA" });
        expect(calls).toEqual([]);
        expect(await Bun.file(marker).exists()).toBe(false);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});
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
test('builds selected file trees using one bounded blob batch and one index batch', async () => {
    const root=await mkdtemp(join(tmpdir(),'hub-git-batch-'));
    try {
        const {remoteUrl,base}=await seedRemote(root), calls:string[][]=[];
        const revision=selected(base);
        revision.files=Array.from({length:30},(_,index)=>({path:'src/file-'+index+'.txt',mode:'100644' as const,contentBase64:Buffer.from('file '+index).toString('base64'),contentDigest:''}));
        const result=await createGitDelivery(recordingGit(calls))({dataDir:join(root,'data'),projectId:'p',operationId:'batch',revision,remoteUrl,baseBranch:'main'});
        expect(result.status).toBe('published');
        expect(calls.filter(args=>args[0]==='hash-object')).toHaveLength(1);
        expect(calls.filter(args=>args[0]==='update-index')).toHaveLength(1);
    } finally { await rm(root,{recursive:true,force:true}); }
});
