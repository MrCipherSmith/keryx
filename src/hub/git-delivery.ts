import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile, rename, rm, lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { GitDeliveryAdapter, GitDeliveryResult } from "./contracts";
export function hasControls(value: string, space = false): boolean {
    return [...value].some(char => char.charCodeAt(0) < (space ? 33 : 32) || char.charCodeAt(0) === 127);
}
export function safeHubPath(path: string): void {
    if (!path || path.startsWith("-") || path.includes("\\") || hasControls(path) || path.split("/").some(p => !p || p === "." || p === ".." || p.toLowerCase() === ".git") || path.startsWith("/"))
        throw Error("Unsafe file path");
}
/** Deliberately excludes caller-controlled Git configuration, hooks and shell commands. */
export async function hubGit(cwd: string, args: string[], input?: Buffer | string): Promise<Buffer> {
    const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH, HOME: process.env.HOME, LANG: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -oBatchMode=yes", GIT_AUTHOR_NAME: "Keryx Hub", GIT_AUTHOR_EMAIL: "hub@localhost", GIT_COMMITTER_NAME: "Keryx Hub", GIT_COMMITTER_EMAIL: "hub@localhost"
    };
    return new Promise((yes, no) => {
        const child = execFile("git", ["-c", "core.hooksPath=/dev/null", "-c", "protocol.ext.allow=never", "-c", "commit.gpgsign=false", ...args], {
            cwd, env, encoding: "buffer", timeout: 30000, maxBuffer: 40 * 1024 * 1024
        }, (error, stdout) => error ? no(Error(`Git ${args[0]} failed (authentication, remote, base or conflict); inspect managed workspace`)) : yes(stdout));
        if (input !== undefined)
            child.stdin?.end(input);
        else
            child.stdin?.end();
    });
}
export function validateHubRemote(remoteUrl: string): void {
    if (!remoteUrl || remoteUrl.startsWith("-") || hasControls(remoteUrl) || remoteUrl.startsWith("ext::") || (!remoteUrl.startsWith("/") && !/^(https:\/\/|ssh:\/\/|git@[A-Za-z0-9.-]+:)/.test(remoteUrl)))
        throw Error("Unsupported remote URL");
    if (remoteUrl.includes("://")) {
        const url = new URL(remoteUrl);
        if (url.password || (url.protocol === "https:" && url.username))
            throw Error("Use external credential configuration, not URL credentials");
    }
}
async function saveReceipt(path: string, value: unknown): Promise<void> {
    const tmp = `${path}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(value), { mode: 0o600 });
    await rename(tmp, path);
}
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export const deliverRevision: GitDeliveryAdapter = async (request) => {
    let workspace: string | undefined;
    let lock: string | undefined;
    try {
        const { revision, remoteUrl, baseBranch } = request;
        validateHubRemote(remoteUrl);
        if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(baseBranch) || baseBranch.includes("..") || baseBranch.includes("//") || baseBranch.endsWith("/") || baseBranch.endsWith(".lock"))
            throw Error("Invalid base branch");
        if (!/^[a-f0-9]{40,64}$/.test(revision.gitBaseSha))
            throw Error("Invalid Git base SHA");
        const directory = join(resolve(request.dataDir), "git", hash(request.projectId));
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const candidateLock = join(directory, "lock");
        await mkdir(candidateLock);
        lock = candidateLock;
        const fingerprint = hash(JSON.stringify(request));
        const receiptPath = join(directory, `${hash(request.operationId)}.json`);
        let previous: {
            fingerprint: string;
            result: GitDeliveryResult;
        } | undefined;
        try {
            previous = JSON.parse(await readFile(receiptPath, "utf8"));
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                throw error;
        }
        if (previous && previous.fingerprint !== fingerprint)
            throw Error("Operation payload changed");
        const branch = `codex/hub-${hash(request.projectId).slice(0, 12)}-${hash(request.operationId).slice(0, 20)}`;
        const cache = join(directory, `${hash(remoteUrl)}.git`);
        try {
            await lstat(cache);
        }
        catch {
            await hubGit(directory, ["init", "--bare", cache]);
        }
        await hubGit(cache, ["fetch", "--no-tags", remoteUrl, `+refs/heads/${baseBranch}:refs/remotes/hub/base`]);
        const remote = String(await hubGit(cache, ["ls-remote", remoteUrl, `refs/heads/${branch}`])).trim().split(/\s/)[0];
        if (previous?.result.status === "published") {
            if (remote !== previous.result.commitSha)
                throw Error("Published branch changed or disappeared");
            return previous.result;
        }
        // Remote recovery after push succeeded but the caller lost the response: inspect the immutable operation marker.
        if (remote) {
            await hubGit(cache, ["fetch", "--no-tags", remoteUrl, `refs/heads/${branch}`]);
            const marker = String(await hubGit(cache, ["show", "-s", "--format=%B", remote]));
            if (!marker.includes(`Hub-Operation: ${fingerprint}`))
                throw Error("Managed branch collision");
            const result: GitDeliveryResult = {
                status: "published", branch, commitSha: remote, treeSha: String(await hubGit(cache, ["rev-parse", `${remote}^{tree}`])).trim()
            };
            await saveReceipt(receiptPath, { fingerprint, result });
            return result;
        }
        await hubGit(cache, ["cat-file", "-e", `${revision.gitBaseSha}^{commit}`]);
        workspace = await mkdtemp(join(directory, "operation-"));
        await hubGit(workspace, ["clone", "--no-checkout", cache, "work"]);
        const work = join(workspace, "work");
        await hubGit(work, ["checkout", "--detach", revision.gitBaseSha]);
        const seen = new Set<string>();
        let size = 0;
        for (const f of revision.files) {
            safeHubPath(f.path);
            if (seen.has(f.path) || !["100644", "100755"].includes(f.mode))
                throw Error("Unsupported or duplicate file");
            seen.add(f.path);
            size += Buffer.from(f.contentBase64, "base64").length;
        }
        if (size > 20 * 1024 * 1024 || seen.size > 5000)
            throw Error("Snapshot quota exceeded");
        // Build the exact selected tree in the index, including deletions; no filesystem path traversal or filters.
        await hubGit(work, ["read-tree", "--empty"]);
        for (const file of revision.files) {
            const blob = String(await hubGit(work, ["hash-object", "-w", "--stdin"], Buffer.from(file.contentBase64, "base64"))).trim();
            await hubGit(work, ["update-index", "--add", "--cacheinfo", file.mode, blob, file.path]);
        }
        const tree = String(await hubGit(work, ["write-tree"])).trim();
        const candidate = String(await hubGit(work, ["commit-tree", tree, "-p", revision.gitBaseSha], "Hub selected snapshot\n")).trim();
        await hubGit(work, ["fetch", "origin", "refs/remotes/hub/base"]);
        await hubGit(work, ["checkout", "--force", "--detach", "FETCH_HEAD"]);
        try {
            await hubGit(work, ["cherry-pick", "--no-commit", candidate]);
        }
        catch {
            return { status: "conflict", error: "Selected revision conflicts with current remote base; no branch pushed" };
        }
        const mergedTree = String(await hubGit(work, ["write-tree"])).trim();
        const parent = String(await hubGit(work, ["rev-parse", "HEAD"])).trim();
        const commitSha = String(await hubGit(work, ["commit-tree", mergedTree, "-p", parent], `${revision.message}\n\nHub-Operation: ${fingerprint}\n`)).trim();
        await hubGit(work, ["push", remoteUrl, `${commitSha}:refs/heads/${branch}`]);
        const result: GitDeliveryResult = {
            status: "published", branch, commitSha, treeSha: mergedTree
        };
        await saveReceipt(receiptPath, { fingerprint, result });
        return result;
    }
    catch (error) {
        return { status: "failed", error: error instanceof Error ? error.message : "Git delivery failed" };
    }
    finally {
        if (workspace)
            await rm(workspace, { recursive: true, force: true });
        if (lock)
            await rm(lock, { recursive: true, force: true });
    }
};
