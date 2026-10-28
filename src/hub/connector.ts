import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, relative } from "node:path";
import { revisionOperand } from "../lib/git-revision";
import { hasControls, hubGit, safeHubPath, validateHubRemote } from "./git-delivery";
import type { CodeRevision, Delivery, ImportResponse, Project, RevisionChange, RevisionFile } from "./contracts";
import { acquireContextLock, HubSyncCancelled, HubSyncError, mergeContext, readContext, replaceContextFile, requestContext } from "./context-sync";
export type HubBinding = {
    url: string;
    projectId: string;
    checkoutId: string;
    tokenEnv: string;
    gitCommonDir?: string;
    lastRevisionId?: string;
    lastAppliedRevisionId?: string;
};
type HubConnectionStatus =
    | { ok: true; connection: Pick<HubBinding, "url" | "projectId" | "checkoutId"> | null }
    | { ok: false; error: "unreadable-binding" | "invalid-binding" };
type Options = {
    cwd: string;
    token?: string;
    tokenEnv?: string;
    cacheRoot?: string;
};
const digest = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
async function atomic(path: string, value: unknown) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    await rename(tmp, path);
    await chmod(path, 0o600);
}
async function exists(path: string) {
    try {
        return await lstat(path);
    }
    catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT")
            return undefined;
        throw e;
    }
}
export async function snapshotTrackedFiles(cwd: string): Promise<RevisionFile[]> {
    const entries = String(await hubGit(cwd, ["ls-files", "--stage", "-z"])).split("\0").filter(Boolean);
    const files: RevisionFile[] = [];
    let size = 0;
    for (const entry of entries) {
        const tab = entry.indexOf("\t");
        const [mode, , stage] = entry.slice(0, tab).split(" ");
        const path = entry.slice(tab + 1);
        safeHubPath(path);
        if (stage !== "0" || !['100644', '100755'].includes(mode ?? ""))
            throw Error("Unsupported tracked mode or unresolved merge");
        const target = join(cwd, path);
        const stat = await exists(target);
        if (!stat)
            continue;
        if (!stat.isFile() || stat.isSymbolicLink())
            throw Error("Unsupported tracked file");
        const canonical = await realpath(target);
        if (relative(await realpath(cwd), canonical).startsWith(".."))
            throw Error("Tracked path escapes checkout");
        const bytes = await readFile(target);
        size += bytes.length;
        if (size > 20 * 1024 * 1024 || files.length >= 5000)
            throw Error("Snapshot quota exceeded");
        files.push({
            path, mode: (stat.mode & 0o111) ? "100755" : "100644", contentBase64: bytes.toString("base64"), contentDigest: digest(bytes)
        });
    }
    return files.sort((a, b) => a.path.localeCompare(b.path));
}
export class HubConnector {
    private readonly cwd: string;
    private readonly bindingPath: string;
    private readonly trustedBindingPath: string;
    constructor(private readonly options: Options) {
        this.cwd = resolve(options.cwd);
        this.bindingPath = join(this.cwd, ".metaproject", "hub.json");
        this.trustedBindingPath = join(options.cacheRoot ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "keryx", "hub"), "bindings", `${digest(this.cwd)}.json`);
    }
    async binding(): Promise<HubBinding> {
        return JSON.parse(await readFile(this.trustedBindingPath, "utf8"));
    }
    async status(): Promise<HubConnectionStatus> {
        let contents: string;
        try {
            contents = await readFile(this.trustedBindingPath, "utf8");
        } catch (error) {
            if (error instanceof Error && "code" in error && error.code === "ENOENT")
                return { ok: true, connection: null };
            return { ok: false, error: "unreadable-binding" };
        }
        try {
            const value: unknown = JSON.parse(contents);
            if (!value || typeof value !== "object" || Array.isArray(value) ||
                !("url" in value) || typeof value.url !== "string" ||
                !("projectId" in value) || typeof value.projectId !== "string" ||
                !("checkoutId" in value) || typeof value.checkoutId !== "string")
                return { ok: false, error: "invalid-binding" };
            const { url, projectId, checkoutId } = value;
            const parsed = new URL(url);
            if (url.trim() !== url || hasControls(url, true) ||
                !["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash ||
                (parsed.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)) ||
                !/^[A-Za-z0-9._-]+$/.test(projectId) || !/^[A-Za-z0-9._-]+$/.test(checkoutId))
                return { ok: false, error: "invalid-binding" };
            return { ok: true, connection: { url, projectId, checkoutId } };
        } catch {
            return { ok: false, error: "invalid-binding" };
        }
    }
    private async saveBinding(binding: HubBinding): Promise<void> {
        const meta = await exists(dirname(this.bindingPath));
        if (meta?.isSymbolicLink())
            throw Error("Metaproject directory cannot be a symlink");
        await atomic(this.trustedBindingPath, binding);
        await atomic(this.bindingPath, binding);
    }
    private token(binding?: HubBinding): string {
        const token = this.options.token ?? process.env[this.options.tokenEnv ?? binding?.tokenEnv ?? "KERYX_HUB_TOKEN"];
        if (!token)
            throw Error("Hub token environment variable is empty");
        return token;
    }
    async request<T>(path: string, body?: unknown, key = randomUUID(), binding?: HubBinding): Promise<T> {
        const b = binding ?? await this.binding();
        const response = await fetch(`${b.url}/hub/v1${path}`, {
            method: body === undefined ? "GET" : "POST", headers: {
                Authorization: `Bearer ${this.token(b)}`, "Content-Type": "application/json", ...(body === undefined ? {} : { "Idempotency-Key": key })
            }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000), redirect: "error"
        });
        const result = await response.json() as T & {
            error?: {
                message: string;
            };
        };
        if (!response.ok)
            throw Error(`Hub ${response.status}: ${result.error?.message ?? "request failed"}`);
        return result;
    }
    async connect(url: string, projectId: string): Promise<HubBinding> {
        const parsed = new URL(url);
        if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash)
            throw Error("Invalid Hub URL");
        if (parsed.protocol === "http:" && !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname))
            throw Error("Remote Hub requires HTTPS");
        if (!/^[A-Za-z0-9._-]+$/.test(projectId) || hasControls(projectId, true))
            throw Error("Invalid project ID");
        let old: HubBinding | undefined;
        try {
            old = await this.binding();
        }
        catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "ENOENT")
                throw e;
        }
        if (old && (old.projectId !== projectId || old.url !== url.replace(/\/$/, "")))
            throw Error("Checkout already bound to another Hub/project");
        const binding: HubBinding = {
            url: url.replace(/\/$/, ""), projectId, checkoutId: old?.checkoutId ?? randomUUID(), tokenEnv: this.options.tokenEnv ?? "KERYX_HUB_TOKEN"
        };
        await this.request(`/projects/${encodeURIComponent(projectId)}`, undefined, undefined, binding);
        try {
            binding.gitCommonDir = String(await hubGit(this.cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
        }
        catch {
            // Documentation-only checkouts do not require Git metadata.
        }
        await this.saveBinding(binding);
        return binding;
    }
    private cache(binding: HubBinding) {
        return join(this.options.cacheRoot ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "keryx", "hub"), digest(`${binding.url}/${binding.projectId}`));
    }
    async importDocuments(): Promise<{
        imported: number;
        proposals: number;
    }> {
        const binding = await this.binding();
        const documents: {
            path: string;
            kind: "wiki" | "spec";
            content: string;
        }[] = [];
        for (const root of ["openspec/specs", "openspec/changes", ".metaproject/wiki"]) {
            const walk = async (path: string): Promise<void> => {
                const stat = await exists(join(this.cwd, path));
                if (!stat)
                    return;
                if (stat.isSymbolicLink())
                    throw Error("Import symlinks are unsupported");
                const canonical = await realpath(join(this.cwd, path));
                if (relative(await realpath(this.cwd), canonical).startsWith(".."))
                    throw Error("Import root escapes checkout");
                if (stat.isDirectory()) {
                    for (const name of (await readdir(join(this.cwd, path))).sort())
                        await walk(`${path}/${name}`);
                }
                else if (stat.isFile() && path.endsWith(".md")) {
                    safeHubPath(path);
                    if (stat.size > 1024 * 1024)
                        throw Error("Document exceeds 1 MiB");
                    if (documents.length >= 10000)
                        throw Error("Import exceeds 10000 documents");
                    documents.push({
                        path, kind: root.startsWith("openspec") ? "spec" : "wiki", content: await readFile(join(this.cwd, path), "utf8")
                    });
                }
            };
            await walk(root);
        }
        let project = await this.request<Project>(`/projects/${binding.projectId}`);
        let proposals = 0;
        let sourceRevision = "local";
        try {
            sourceRevision = String(await hubGit(this.cwd, ["rev-parse", "HEAD"])).trim();
        }
        catch {
            // Documentation-only checkouts do not require Git metadata.
        }
        for (let i = 0; i < documents.length;) {
            const batch: typeof documents = [];
            let bytes = 0;
            while (i < documents.length && batch.length < 500) {
                const next = documents[i]!;
                const size = Buffer.byteLength(JSON.stringify(next));
                if (batch.length && bytes + size > 8 * 1024 * 1024)
                    break;
                batch.push(next);
                bytes += size;
                i++;
            }
            const response = await this.request<ImportResponse>(`/projects/${binding.projectId}/import`, {
                expectedVersion: project.version, sourceRevision, documents: batch
            });
            project = response.project;
            proposals += response.proposals.length;
        }
        return { imported: documents.length, proposals };
    }
    private async validateMetaIndex(): Promise<void> {
        const meta = await exists(dirname(this.bindingPath));
        if (meta && (!meta.isDirectory() || meta.isSymbolicLink()))
            throw Error("Metaproject directory must be a real directory");
        const index = join(this.cwd, ".metaproject", "index.md");
        const stat = await exists(index);
        if (stat && (!stat.isFile() || stat.isSymbolicLink()))
            throw Error("Metaproject index must be a regular file");
        if (meta && relative(await realpath(this.cwd), await realpath(dirname(index))).startsWith(".."))
            throw Error("Metaproject index escapes checkout");
    }
    async sync(options: { signal?: AbortSignal } = {}): Promise<{ cacheDir: string; revision: number; changed: boolean }> {
        const { signal } = options;
        signal?.throwIfAborted();
        let binding: HubBinding, token: string;
        try {
            binding = await this.binding();
            if (!(await this.status()).ok) throw new HubSyncError("configuration");
            token = this.token(binding);
        } catch { throw new HubSyncError("configuration"); }
        const cacheDir = this.cache(binding);
        let release: (() => Promise<void>) | undefined;
        let revision: number | undefined;
        try {
            release = await acquireContextLock(cacheDir);
            signal?.throwIfAborted();
            await this.validateMetaIndex();
            const cacheFile = join(cacheDir, "context.json");
            const prior = await readContext(cacheFile, binding.projectId);
            revision = prior.value?.revision;
            const response = await requestContext(`${binding.url}/hub/v1/projects/${encodeURIComponent(binding.projectId)}/context${prior.value ? `?after=${prior.value.revision}` : ""}`, token, signal);
            signal?.throwIfAborted();
            const context = mergeContext(response, prior.value, binding.projectId);
            const bytes = JSON.stringify(context, null, 2);
            const changed = bytes !== prior.bytes;
            if (changed) await replaceContextFile(cacheFile, bytes, signal);
            revision = context.revision;
            try { await this.updateContextIndex(binding, cacheDir, signal); }
            catch (_error) {
                signal?.throwIfAborted();
                throw new HubSyncError("index-update-failed", revision);
            }
            return { cacheDir, revision, changed };
        } catch (error) {
            if (signal?.aborted) throw new HubSyncCancelled(revision);
            const failure = error instanceof HubSyncError ? error : new HubSyncError("filesystem");
            if (revision !== undefined) failure.revision = revision;
            throw failure;
        } finally { if (release) await release(); }
    }
    /** Refresh an explicit checkout's reference to an already validated shared cache; no network. */
    async refreshContextIndex(options: { signal?: AbortSignal } = {}): Promise<void> {
        const binding = await this.binding();
        const cacheDir = this.cache(binding);
        const cached = await readContext(join(cacheDir, "context.json"), binding.projectId);
        if (!cached.value) throw new HubSyncError("invalid-cache");
        options.signal?.throwIfAborted();
        await this.validateMetaIndex();
        await this.updateContextIndex(binding, cacheDir, options.signal);
    }
    private async updateContextIndex(binding: HubBinding, cacheDir: string, signal?: AbortSignal): Promise<void> {
        const index = join(this.cwd, ".metaproject", "index.md");
        const before = (await exists(index)) ? await readFile(index, "utf8") : "# Metaproject Index\n";
        const begin = "<!-- keryx:hub:begin -->";
        const end = "<!-- keryx:hub:end -->";
        const block = `${begin}\n## Team Hub context\nProject: ${binding.projectId}; checkout: ${binding.checkoutId}. Canonical documents cache: ${join(cacheDir, "context.json")}\nHub context is canonical; imported pages are unreviewed until human approval.\n${end}`;
        let text: string;
        if (before.includes(begin)) {
            const first = before.indexOf(begin), last = before.indexOf(end, first);
            if (last < 0)
                throw Error("Malformed Hub index block; repair manually");
            text = before.slice(0, first) + block + before.slice(last + end.length);
        }
        else {
            text = `${before}\n${block}\n`;
            if (await exists(index))
                await writeFile(`${index}.pre-hub-${Date.now()}`, before, { flag: "wx", mode: 0o600 });
        }
        if (text === before) return;
        await mkdir(dirname(index), { recursive: true });
        await this.validateMetaIndex();
        await replaceContextFile(index, text, signal);
    }
    async submit(message: string): Promise<CodeRevision> {
        const binding = await this.binding();
        const base = binding.lastRevisionId ? await this.request<CodeRevision>(`/projects/${binding.projectId}/revisions/${binding.lastRevisionId}`) : undefined;
        if (base?.purpose === "review-bundle")
            throw Error("Review bundles cannot be used as checkout snapshot bases");
        const files = await snapshotTrackedFiles(this.cwd);
        const previous = new Map(base?.files.map(f => [f.path, f]) ?? []);
        const changes: RevisionChange[] = [];
        for (const file of files) {
            const old = previous.get(file.path);
            if (!old || old.contentDigest !== file.contentDigest || old.mode !== file.mode)
                changes.push({
                    path: file.path, contentBase64: file.contentBase64, mode: file.mode
                });
            previous.delete(file.path);
        }
        for (const path of previous.keys())
            changes.push({ path, deleted: true });
        const revision = await this.request<CodeRevision>(`/projects/${binding.projectId}/revisions`, {
            baseRevisionId: base?.id ?? null, gitBaseSha: base?.gitBaseSha ?? String(await hubGit(this.cwd, ["rev-parse", "HEAD"])).trim(), message, changes
        });
        await this.saveBinding({ ...binding, lastRevisionId: revision.id });
        return revision;
    }
    async fetchDelivery(deliveryId: string): Promise<{
        deliveryId: string;
        commitSha: string;
        treeSha: string;
        ref: string;
        reanchor: "manual";
        preview: {
            path: string;
            change: "added" | "modified" | "deleted";
        }[];
    }> {
        const binding = await this.binding();
        const { deliveries } = await this.request<{
            deliveries: Delivery[];
        }>(`/projects/${binding.projectId}/deliveries`);
        const delivery = deliveries.find(d => d.id === deliveryId);
        if (!delivery || delivery.status !== "published" || !delivery.branch || !delivery.commitSha || !delivery.treeSha)
            throw Error("Published delivery receipt required");
        const revision = await this.request<CodeRevision>(`/projects/${binding.projectId}/revisions/${delivery.revisionId}`);
        if (revision.purpose === "review-bundle")
            throw Error("Review bundles cannot have Git delivery receipts");
        validateHubRemote(delivery.remoteUrl);
        if (!/^codex\/hub-[a-f0-9]+-[a-f0-9]+$/.test(delivery.branch) || !/^[a-f0-9]{40,64}$/.test(delivery.commitSha) || !/^[a-f0-9]{40,64}$/.test(delivery.treeSha))
            throw Error("Invalid managed delivery receipt");
        const ref = `refs/keryx-hub/${digest(delivery.id)}`;
        // The receipt and the revision are the Hub's: `--end-of-options` keeps each URL and revision an operand.
        await hubGit(this.cwd, ["fetch", "--no-tags", "--end-of-options", delivery.remoteUrl, `refs/heads/${delivery.branch}:${ref}`]);
        const actual = String(await hubGit(this.cwd, ["rev-parse", "--verify", ...revisionOperand(ref)])).trim();
        const tree = String(await hubGit(this.cwd, ["rev-parse", "--verify", ...revisionOperand(`${ref}^{tree}`)])).trim();
        if (actual !== delivery.commitSha || tree !== delivery.treeSha)
            throw Error("Remote branch differs from delivery receipt; automatic reanchor refused");
        const parseTree = (data: Buffer) => new Map(String(data).split("\0").filter(Boolean).map(entry => {
            const tab = entry.indexOf("\t");
            const [mode, , oid] = entry.slice(0, tab).split(" ");
            return [entry.slice(tab + 1), { mode, oid }] as const;
        }));
        const delivered = parseTree(await hubGit(this.cwd, ["ls-tree", "-r", "-z", ...revisionOperand(actual)]));
        const base = parseTree(await hubGit(this.cwd, ["ls-tree", "-r", "-z", ...revisionOperand(revision.gitBaseSha)]));
        const blobOid = (bytes: Buffer) => createHash(revision.gitBaseSha.length === 64 ? "sha256" : "sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
        // Verify only the selected delta. Untouched baseline files may legitimately contain independent remote edits.
        const selected = new Set(revision.files.map(file => file.path));
        for (const file of revision.files) {
            safeHubPath(file.path);
            const oid = blobOid(Buffer.from(file.contentBase64, "base64"));
            const before = base.get(file.path);
            if (before?.oid === oid && before.mode === file.mode)
                continue;
            const published = delivered.get(file.path);
            if (published?.oid !== oid || published.mode !== file.mode)
                throw Error("Published selected delta differs; automatic reanchor refused");
        }
        for (const path of base.keys())
            if (!selected.has(path) && delivered.has(path))
                throw Error("Published selected deletion differs; reanchor refused");
        const local = new Map((await snapshotTrackedFiles(this.cwd)).map(file => [file.path, { oid: blobOid(Buffer.from(file.contentBase64, "base64")), mode: file.mode }]));
        const preview: {
            path: string;
            change: "added" | "modified" | "deleted";
        }[] = [];
        for (const [path, file] of delivered) {
            safeHubPath(path);
            const before = local.get(path);
            if (!before)
                preview.push({ path, change: "added" });
            else if (before.oid !== file.oid || before.mode !== file.mode)
                preview.push({ path, change: "modified" });
            local.delete(path);
        }
        for (const path of local.keys())
            preview.push({ path, change: "deleted" });
        return {
            deliveryId, commitSha: actual, treeSha: tree, ref, reanchor: "manual", preview
        };
    }
    async pull(revisionId?: string, apply = false): Promise<{
        revisionId: string;
        changes: RevisionChange[];
        applied: boolean;
        checkpoint?: string;
    }> {
        const binding = await this.binding();
        const project = await this.request<Project>(`/projects/${binding.projectId}`);
        const target = revisionId ?? project.lineRevisionId;
        if (!target)
            throw Error("Project has no selected code revision");
        const revision = await this.request<CodeRevision>(`/projects/${binding.projectId}/revisions/${encodeURIComponent(target)}`);
        if (revision.purpose === "review-bundle")
            throw Error("Review bundles cannot be applied to a checkout");
        const current = await snapshotTrackedFiles(this.cwd);
        const applied = binding.lastAppliedRevisionId ? await this.request<CodeRevision>(`/projects/${binding.projectId}/revisions/${binding.lastAppliedRevisionId}`) : undefined;
        for (const file of applied?.files ?? []) {
            safeHubPath(file.path);
            if (current.some(f => f.path === file.path))
                continue;
            const p = join(this.cwd, file.path);
            const stat = await exists(p);
            if (!stat)
                continue;
            if (!stat.isFile() || stat.isSymbolicLink())
                throw Error("Applied file became unsupported");
            if (relative(await realpath(this.cwd), await realpath(p)).startsWith(".."))
                throw Error("Applied path escapes checkout");
            const bytes = await readFile(p);
            current.push({
                path: file.path, contentBase64: bytes.toString("base64"), mode: (stat.mode & 0o111) ? "100755" : "100644", contentDigest: digest(bytes)
            });
        }
        const wanted = new Map(revision.files.map(f => [f.path, f]));
        const changes: RevisionChange[] = [];
        for (const f of current) {
            const to = wanted.get(f.path);
            if (!to)
                changes.push({ path: f.path, deleted: true });
            else if (to.contentDigest !== f.contentDigest || to.mode !== f.mode)
                changes.push({
                    path: to.path, contentBase64: to.contentBase64, mode: to.mode
                });
            wanted.delete(f.path);
        }
        for (const f of wanted.values())
            changes.push({
                path: f.path, contentBase64: f.contentBase64, mode: f.mode
            });
        for (const c of changes) {
            safeHubPath(c.path);
            if (c.path === ".metaproject/hub.json")
                throw Error("Revision contains checkout binding; remove it from source tracking");
        }
        if (!apply)
            return {
                revisionId: target, changes, applied: false
            };
        const status = String(await hubGit(this.cwd, ["status", "--porcelain=v1", "--untracked-files=all"]));
        const entries = status.split("\n").filter(Boolean).filter(line => line !== "?? .metaproject/hub.json" && !/^\?\? \.metaproject\/index\.md\.pre-hub-/.test(line));
        if (entries.some(line => line[0] !== " " && line[0] !== "?"))
            throw Error("Staged changes; pull refused");
        if (applied) {
            const same = current.length === applied.files.length && current.every(f => applied.files.some(a => a.path === f.path && a.mode === f.mode && a.contentDigest === f.contentDigest));
            if (!same || entries.some(line => line.startsWith("??") && !applied.files.some(f => line.slice(3) === f.path)))
                throw Error("Local changes since last applied Hub revision; pull refused");
        }
        else if (entries.length)
            throw Error("Refusing pull into dirty, staged or untracked checkout");
        for (const state of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "index.lock"]) {
            const p = String(await hubGit(this.cwd, ["rev-parse", "--git-path", state])).trim();
            if (await exists(resolve(this.cwd, p)))
                throw Error("Active Git operation; pull refused");
        }
        const tracked = new Set(current.map(f => f.path));
        for (const c of changes) {
            const parts = c.path.split("/");
            for (let i = 1; i <= parts.length; i++) {
                const path = join(this.cwd, ...parts.slice(0, i));
                const stat = await exists(path);
                if (stat && (stat.isSymbolicLink() || (i < parts.length && !stat.isDirectory()) || (i === parts.length && (!tracked.has(c.path) || !stat.isFile()))))
                    throw Error("Untracked, ignored or symlink collision; pull refused");
            }
        }
        const gitPath = String(await hubGit(this.cwd, ["rev-parse", "--git-path", "hub-checkpoints"])).trim();
        const checkpoint = join(resolve(this.cwd, gitPath), randomUUID());
        await mkdir(checkpoint, { recursive: true, mode: 0o700 });
        const journal = {
            status: "prepared", revisionId: target, files: current.filter(f => changes.some(c => c.path === f.path)), changes
        };
        await atomic(join(checkpoint, "journal.json"), journal);
        try {
            for (const c of changes) {
                const p = join(this.cwd, c.path);
                if (c.deleted)
                    await rm(p);
                else {
                    await mkdir(dirname(p), { recursive: true });
                    await writeFile(p, Buffer.from(c.contentBase64!, "base64"), { mode: c.mode === "100755" ? 0o755 : 0o644 });
                    await chmod(p, c.mode === "100755" ? 0o755 : 0o644);
                }
            }
            await atomic(join(checkpoint, "journal.json"), { ...journal, status: "applied" });
            await this.saveBinding({ ...binding, lastAppliedRevisionId: target });
        }
        catch (error) {
            await atomic(join(checkpoint, "journal.json"), { ...journal, status: "partial-apply-recovery-required" });
            throw Error(`Pull interrupted; recovery journal ${checkpoint}: ${error instanceof Error ? error.message : "write failure"}`, { cause: error });
        }
        return {
            revisionId: target, changes, applied: true, checkpoint
        };
    }
}
