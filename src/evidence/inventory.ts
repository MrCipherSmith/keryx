import { isSessionEvidenceId } from "../session/evidence-revocation";
import path from "node:path";
import { keryxDataDir, projectSessionsDir } from "../session/paths";
import { lstat, realpath } from "node:fs/promises";
import { DescriptorReadError, listDescriptorDirectory } from "../lib/descriptor-read";
import { parseEvidenceConfig, safeRelativePath } from "./config";
import { evidenceFilePathDenied } from "./sources";
import { evidenceFileOutsideSessionStore } from "./file-policy";
import type { EvidenceSourceScope } from "./lifecycle";

type InventoryResult = { code: "ok"; scopes: EvidenceSourceScope[] } |
  { code: "disabled" | "source-unavailable" | "budget-exceeded" | "timeout"; scopes: [] };
/** Runtime-owned candidate inventory. Every candidate still needs the source adapter. */
export async function collectEvidenceFiles(options: {
  projectRoot: string; config?: unknown; signal?: AbortSignal; dataDir?: string;
}): Promise<InventoryResult> {
  const dataDir = path.resolve(keryxDataDir(options.dataDir));
  const parsed = parseEvidenceConfig(options.config);
  if (!parsed.ok) return { code: "source-unavailable", scopes: [] };
  const config = parsed.config;
  if (!config.enabled) return { code: "disabled", scopes: [] };
  const deadline = performance.now() + config.timeoutMs;
  const checkpoint = () => {
    if (options.signal?.aborted || performance.now() >= deadline) throw new Error("inventory-timeout");
  };
  try {
    checkpoint();
    const root = await realpath(options.projectRoot);
    const identity = await lstat(root); checkpoint();
    if (!identity.isDirectory()) return { code: "source-unavailable", scopes: [] };
    const directories = config.roots.map(p => p.split("/").filter(part => part !== ".").join("/"));
    if (directories.some(p => evidenceFilePathDenied(p))) return { code: "source-unavailable", scopes: [] };
    const seen = new Set<string>(); const files = new Set<string>();
    const maxEntries = Math.min(100000, config.maxChunks * 8 + 32);
    let visited = 0;
    while (directories.length) {
      checkpoint();
      const relative = directories.pop()!;
      if (!evidenceFileOutsideSessionStore(root, relative, dataDir)) continue;
      if (seen.has(relative)) continue;
      seen.add(relative);
      const entries = listDescriptorDirectory(root, relative, {
        expectedRootIdentity: identity, maxEntries: maxEntries - visited, checkpoint,
      });
      visited += entries.length;
      for (const entry of entries) {
        const candidate = relative ? `${relative}/${entry.name}` : entry.name;
        if (!safeRelativePath(candidate) || evidenceFilePathDenied(candidate) ||
            !evidenceFileOutsideSessionStore(root, candidate, dataDir)) continue;
        if (entry.kind === "directory") directories.push(candidate);
        if (entry.kind === "file") files.add(candidate);
        if (files.size > config.maxChunks) return { code: "budget-exceeded", scopes: [] };
      }
    }
    const scopes: EvidenceSourceScope[] = [...files].sort().map(id => ({ kind: "file", id }));
    if (config.sessionArchives) {
      const store = path.resolve(keryxDataDir(dataDir));
      let storageRoot: string | undefined;
      try { storageRoot = await realpath(store); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        // ENOENT may mean a dangling ancestor, not an absent store. Inspect
        // existing ancestors before accepting absence; never follow a broken link.
        let prefix = path.parse(store).root;
        for (const component of store.slice(prefix.length).split(path.sep).filter(Boolean)) {
          prefix = path.join(prefix, component);
          let info;
          try { info = await lstat(prefix); }
          catch (missing) {
            if ((missing as NodeJS.ErrnoException).code === "ENOENT") break;
            throw missing;
          }
          checkpoint();
          if (info.isSymbolicLink()) await realpath(prefix);
          else if (!info.isDirectory()) throw Error("invalid storage ancestor", { cause: error });
        }
      }
      checkpoint();
      if (storageRoot !== undefined) {
        const resolvedStorageRoot = storageRoot;
        const storageIdentity = await lstat(resolvedStorageRoot); checkpoint();
        const list = (relative: string) => {
          const entries = listDescriptorDirectory(resolvedStorageRoot, relative, {
            expectedRootIdentity: storageIdentity, maxEntries: maxEntries - visited, checkpoint,
          });
          visited += entries.length;
          return entries;
        };
        // Inspect parents through descriptors so absent stores are empty, but symlink
        // parents or failed opens never become an empty successful inventory.
        const sessions = list("").find(entry => entry.name === "sessions");
        if (sessions && sessions.kind !== "directory") throw Error("invalid session store");
        if (sessions) {
          const projectRelative = path.relative(store, projectSessionsDir(root, dataDir)).split(path.sep).join("/");
          if (!safeRelativePath(projectRelative) || projectRelative.split("/").length !== 2)
            throw Error("invalid project session scope");
          const projectEntry = list("sessions").find(entry => entry.name === projectRelative.split("/")[1]);
          if (projectEntry && projectEntry.kind !== "directory") throw Error("invalid project session store");
          if (projectEntry) {
            for (const entry of list(projectRelative).sort((a, b) => a.name.localeCompare(b.name))) {
              checkpoint();
              if (entry.kind !== "directory" || !isSessionEvidenceId(entry.name)) continue;
              const children = list(`${projectRelative}/${entry.name}`);
              const summary = children.find(child => child.name === "summary.json");
              const archive = children.find(child => child.name === "archive.jsonl");
              if (!archive) continue; // Live sessions without a persisted archive are not sources.
              if (archive.kind !== "file" || !summary || summary.kind !== "file")
                throw Error("invalid archive candidate");
              scopes.push({ kind: "session-archive", id: entry.name });
              if (scopes.length > config.maxChunks) return { code: "budget-exceeded", scopes: [] };
            }
          }
        }
      }
    }
    checkpoint();
    return { code: "ok", scopes };
  } catch (error) {
    return { code: error instanceof DescriptorReadError && error.code === "too-large" ? "budget-exceeded" :
      options.signal?.aborted || performance.now() >= deadline ? "timeout" : "source-unavailable", scopes: [] };
  }
}
