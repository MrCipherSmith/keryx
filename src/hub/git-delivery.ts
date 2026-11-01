import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile, rename, rm, lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { revisionOperand } from "../lib/git-revision";
import type { GitDeliveryAdapter, GitDeliveryResult } from "./contracts";
export function hasControls(value: string, space = false): boolean {
    return [...value].some(char => char.charCodeAt(0) < (space ? 33 : 32) || char.charCodeAt(0) === 127);
}
export function safeHubPath(path: string): void {
    if (!path || path.startsWith("-") || path.includes("\\") || hasControls(path) || path.split("/").some(p => !p || p === "." || p === ".." || p.toLowerCase() === ".git") || path.startsWith("/"))
        throw Error("Unsafe file path");
}
export type HubGitRunner = (cwd: string, args: string[], input?: Buffer | string) => Promise<Buffer>;
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
/** The delivery over a git runner: production runs hubGit; a test wraps it to see each argv or answer for the remote. */
export const createGitDelivery = (git: HubGitRunner): GitDeliveryAdapter => async (request) => {
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
            await git(directory, ["init", "--bare", cache]);
        }
        // `--end-of-options` before every remote URL and revision: git reads them as operands even if a check above is loosened.
        await git(cache, ["fetch", "--no-tags", "--end-of-options", remoteUrl, `+refs/heads/${baseBranch}:refs/remotes/hub/base`]);
        const remote = String(await git(cache, ["ls-remote", "--end-of-options", remoteUrl, `refs/heads/${branch}`])).trim().split(/\s/)[0];
        if (previous?.result.status === "published") {
            if (remote !== previous.result.commitSha)
                throw Error("Published branch changed or disappeared");
            return previous.result;
        }
        // Remote recovery after push succeeded but the caller lost the response: inspect the immutable operation marker.
        if (remote) {
            await git(cache, ["fetch", "--no-tags", "--end-of-options", remoteUrl, `refs/heads/${branch}`]);
            const marker = String(await git(cache, ["show", "-s", "--format=%B", ...revisionOperand(remote)]));
            if (!marker.includes(`Hub-Operation: ${fingerprint}`))
                throw Error("Managed branch collision");
            const result: GitDeliveryResult = {
                status: "published", branch, commitSha: remote, treeSha: String(await git(cache, ["rev-parse", "--verify", ...revisionOperand(`${remote}^{tree}`)])).trim()
            };
            await saveReceipt(receiptPath, { fingerprint, result });
            return result;
        }
        await git(cache, ["cat-file", "-e", ...revisionOperand(`${revision.gitBaseSha}^{commit}`)]);
        workspace = await mkdtemp(join(directory, "operation-"));
        await git(workspace, ["clone", "--no-checkout", cache, "work"]);
        const work = join(workspace, "work");
        await git(work, ["checkout", "--detach", ...revisionOperand(revision.gitBaseSha)]);
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
        await git(work, ["read-tree", "--empty"]);
        // Private numbered files avoid repository symlinks, filters and filename quoting.
        // At most 32 writes are open, and Git is spawned once per batch rather than twice per file.
        const blobs = join(workspace, 'blobs');
        await mkdir(blobs, { mode: 0o700 });
        for (let start = 0; start < revision.files.length; start += 32)
            await Promise.all(revision.files.slice(start, start + 32).map((file, offset) => writeFile(join(blobs, String(start + offset)), Buffer.from(file.contentBase64, 'base64'), { mode: 0o600 })));
        if (revision.files.length) {
            const paths = revision.files.map((_file, index) => '../blobs/' + index).join('\n') + '\n';
            const hashes = String(await git(work, ['hash-object', '-w', '--no-filters', '--stdin-paths'], paths)).trim().split('\n');
            if (hashes.length !== revision.files.length || hashes.some(hash => !/^[a-f0-9]{40,64}$/.test(hash))) throw Error('Invalid Git blob batch result');
            const index = revision.files.map((file, position) => `${file.mode} ${hashes[position]}\t${file.path}\0`).join('');
            await git(work, ['update-index', '-z', '--index-info'], index);
        }
        const tree = String(await git(work, ["write-tree"])).trim();
        const candidate = String(await git(work, ["commit-tree", tree, "-p", revision.gitBaseSha], "Hub selected snapshot\n")).trim();
        await git(work, ["fetch", "origin", "refs/remotes/hub/base"]);
        await git(work, ["checkout", "--force", "--detach", "FETCH_HEAD"]);
        // Built before the try, so a refused operand fails the delivery instead of reading as a conflict.
        const pick = ["cherry-pick", "--no-commit", ...revisionOperand(candidate)];
        try {
            await git(work, pick);
        }
        catch {
            return { status: "conflict", error: "Selected revision conflicts with current remote base; no branch pushed" };
        }
        const mergedTree = String(await git(work, ["write-tree"])).trim();
        const parent = String(await git(work, ["rev-parse", "HEAD"])).trim();
        const commitSha = String(await git(work, ["commit-tree", mergedTree, "-p", parent], `${revision.message}\n\nHub-Operation: ${fingerprint}\n`)).trim();
        await git(work, ["push", "--end-of-options", remoteUrl, `${commitSha}:refs/heads/${branch}`]);
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
export const deliverRevision: GitDeliveryAdapter = createGitDelivery(hubGit);
