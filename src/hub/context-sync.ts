import { createHash, randomUUID } from "node:crypto";
import { renameSync } from "node:fs";
import { chmod, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ContextResponse, HubDocument } from "./contracts";

export type SyncErrorCode = "network" | "timeout" | "rate-limited" | "server-unavailable" | "cache-busy" | "unauthorized" | "forbidden" | "permanent-http" | "invalid-context" | "invalid-cache" | "filesystem" | "index-update-failed" | "configuration";
export class HubSyncError extends Error {
    constructor(readonly code: SyncErrorCode, public revision?: number) {
        super(code === "cache-busy" ? "Hub cache-busy: another sync owns the lock; if its owner was killed, verify it has stopped before manually removing context.json.lock." : code === "invalid-cache" ? "Hub invalid-cache: preserve the cache and repair or move it aside explicitly before retrying." : `Hub sync failed: ${code}`);
        this.name = "HubSyncError";
    }
}
/** Carries the last committed cursor even when shutdown interrupts index maintenance. */
export class HubSyncCancelled extends Error {
    constructor(readonly revision?: number) {
        super("Hub context sync stopped");
        this.name = "HubSyncCancelled";
    }
}
export type CachedContext = { revision: number; manifest: ContextResponse["manifest"]; documents: HubDocument[] };
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && ![...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
const path = (value: unknown) => text(value) && !value.startsWith("/") && !value.includes("\\") && !value.split("/").some(part => !part || part === "." || part === "..");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function entries(value: unknown, documents: boolean, projectId: string): boolean {
    if (!Array.isArray(value)) return false;
    const ids = new Set<string>(), paths = new Set<string>();
    return value.every(item => {
        if (!record(item) || !text(item.id) || !path(item.path) || !text(item.path) || ids.has(item.id) || paths.has(item.path) || (item.kind !== "wiki" && item.kind !== "spec") || !integer(item.version) || item.version < 1 || typeof item.contentDigest !== "string" || !/^[a-f0-9]{64}$/.test(item.contentDigest)) return false;
        ids.add(item.id); paths.add(item.path);
        return !documents || (item.projectId === projectId && typeof item.content === "string" && hash(item.content) === item.contentDigest && (item.approval === "accepted" || item.approval === "unreviewed") && text(item.sourceRevision) && (item.acceptedBy === undefined || text(item.acceptedBy)) && (item.acceptedAt === undefined || text(item.acceptedAt)));
    });
}
function validCache(value: unknown, projectId: string): value is CachedContext {
    if (!record(value) || !integer(value.revision) || !entries(value.manifest, false, projectId) || !entries(value.documents, true, projectId)) return false;
    const manifest = value.manifest as ContextResponse["manifest"];
    const docs = value.documents as HubDocument[];
    return manifest.length === docs.length && docs.every(doc => manifest.some(entry => entry.id === doc.id && entry.path === doc.path && entry.kind === doc.kind && entry.version === doc.version && entry.contentDigest === doc.contentDigest));
}
export function mergeContext(value: unknown, prior: CachedContext | undefined, projectId: string): CachedContext {
    if (!record(value) || !integer(value.revision) || (prior && value.revision < prior.revision) || typeof value.fullSnapshot !== "boolean" || (!prior && !value.fullSnapshot) || !entries(value.manifest, false, projectId) || !entries(value.documents, true, projectId) || !Array.isArray(value.deletedDocumentIds) || !value.deletedDocumentIds.every(text) || new Set(value.deletedDocumentIds).size !== value.deletedDocumentIds.length) throw new HubSyncError("invalid-context");
    const response = value as ContextResponse;
    if (response.documents.some(doc => response.deletedDocumentIds.includes(doc.id))) throw new HubSyncError("invalid-context");
    const documents = new Map((response.fullSnapshot ? [] : prior?.documents ?? []).map(doc => [doc.id, doc]));
    for (const id of response.deletedDocumentIds) documents.delete(id);
    for (const doc of response.documents) documents.set(doc.id, doc);
    const result = { revision: response.revision, manifest: response.manifest, documents: [...documents.values()] };
    if (!validCache(result, projectId)) throw new HubSyncError("invalid-context");
    return result;
}
export async function readContext(cacheFile: string, projectId: string): Promise<{ value?: CachedContext; bytes?: string }> {
    try {
        const stat = await lstat(cacheFile);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new HubSyncError("invalid-cache");
        const bytes = await readFile(cacheFile, "utf8");
        let value: unknown;
        try { value = JSON.parse(bytes); } catch { throw new HubSyncError("invalid-cache"); }
        if (!validCache(value, projectId)) throw new HubSyncError("invalid-cache");
        return { value, bytes };
    } catch (error) {
        if (record(error) && error.code === "ENOENT") return {};
        throw error;
    }
}
/** Rename synchronously after the final cancellation check: cancellation cannot interleave with commit. */
export async function replaceContextFile(file: string, bytes: string, signal?: AbortSignal): Promise<void> {
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
        await writeFile(temp, bytes, { flag: "wx", mode: 0o600 });
        signal?.throwIfAborted();
        renameSync(temp, file);
    } finally { await rm(temp, { force: true }); }
}
export async function acquireContextLock(cacheDir: string): Promise<() => Promise<void>> {
    await mkdir(cacheDir, { recursive: true, mode: 0o700 });
    await chmod(cacheDir, 0o700);
    const file = join(cacheDir, "context.json.lock");
    const owner = JSON.stringify({ owner: randomUUID(), pid: process.pid });
    try { await writeFile(file, owner, { flag: "wx", mode: 0o600 }); }
    catch (error) {
        if (record(error) && error.code === "EEXIST") throw new HubSyncError("cache-busy");
        throw error;
    }
    return async () => {
        // Never delete a lock replaced by explicit operator recovery.
        try { if (await readFile(file, "utf8") === owner) await rm(file); }
        catch (error) { if (!record(error) || error.code !== "ENOENT") throw error; }
    };
}
export async function requestContext(url: string, token: string, signal?: AbortSignal, accessHeaders: Readonly<Record<string, string>> = {}): Promise<unknown> {
    const timeout = AbortSignal.timeout(30000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
        combined.throwIfAborted();
        const response = await fetch(url, { headers: { ...accessHeaders, Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, signal: combined, redirect: "error" });
        if (!response.ok) {
            await response.body?.cancel();
            const status = response.status;
            throw new HubSyncError(status === 401 ? "unauthorized" : status === 403 ? "forbidden" : status === 408 ? "timeout" : status === 429 ? "rate-limited" : status >= 500 ? "server-unavailable" : "permanent-http");
        }
        try { return await response.json(); }
        catch (error) {
            if (combined.aborted) throw error;
            throw new HubSyncError(error instanceof SyntaxError ? "invalid-context" : "network");
        }
    } catch (error) {
        signal?.throwIfAborted();
        if (error instanceof HubSyncError) throw error;
        throw new HubSyncError(timeout.aborted ? "timeout" : "network");
    }
}
