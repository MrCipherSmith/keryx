import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import path from "node:path";
import { MAX_CONFIG_FILE_BYTES, ensureKeryxSubdir, keryxDataDir, readConfigFile, writeOwnerOnlyFileAtomic } from "../lib/config-dir";

type IndexChunk = { entries: Map<string, unknown>; changed: boolean; file: string };

// Cache only the link on a regular manifest. Matching manifests and their evidence are always read from disk.
export function openReviewLinkIndex(root: string, kind: "flow-links" | "package-links") {
  const rootId = createHash("sha256").update(root).digest("hex");
  const namespace = ["desktop-review", kind, rootId];
  const dataDir = keryxDataDir();
  const chunks = new Map<string, IndexChunk>();
  function chunkFor(directory: string): IndexChunk {
    const bucket = createHash("sha256").update(directory).digest("hex").slice(0, 1);
    const existing = chunks.get(bucket);
    if (existing) return existing;
    const file = path.join(dataDir, ...namespace, bucket + ".json");
    const chunk: IndexChunk = { entries: new Map(), changed: false, file };
    const saved = readConfigFile(file);
    if (saved.ok) {
      try {
        const value: unknown = JSON.parse(saved.text);
        if (value && typeof value === "object" && !Array.isArray(value)) chunk.entries = new Map(Object.entries(value));
      } catch { /* Rebuild a damaged local cache from the project manifests. */ }
    }
    chunks.set(bucket, chunk);
    return chunk;
  }
  return {
    lookup(directory: string, stamp: string | undefined): string | undefined {
      if (!stamp) return;
      const entry = chunkFor(directory).entries.get(directory);
      return Array.isArray(entry) && entry[0] === stamp && typeof entry[1] === "string" ? entry[1] : undefined;
    },
    record(directory: string, stamp: string | undefined, link: string) {
      if (!stamp) return;
      const chunk = chunkFor(directory);
      const prior = chunk.entries.get(directory);
      if (Array.isArray(prior) && prior[0] === stamp && prior[1] === link) return;
      chunk.entries.set(directory, [stamp, link]);
      chunk.changed = true;
    },
    save() {
      for (const chunk of chunks.values()) {
        if (!chunk.changed) continue;
        const body = JSON.stringify(Object.fromEntries(chunk.entries));
        if (Buffer.byteLength(body) > MAX_CONFIG_FILE_BYTES) continue;
        try {
          ensureKeryxSubdir(namespace, dataDir);
          writeOwnerOnlyFileAtomic(chunk.file, body);
        } catch { /* A read-only data directory still supports uncached project context. */ }
      }
    },
  };
}

export function manifestStamp(file: string): string | undefined {
  try {
    const stat = lstatSync(file, { bigint: true });
    if (stat.isFile()) return [stat.dev, stat.ino, stat.size, stat.ctimeNs, stat.mtimeNs].join(":");
  } catch { /* A project artifact may be removed while the board is reading it. */ }
  return undefined;
}
