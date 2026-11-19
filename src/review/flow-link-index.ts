import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import path from "node:path";
import { ensureKeryxSubdir, keryxDataDir, readConfigFile, writeOwnerOnlyFileAtomic } from "../lib/config-dir";

// Cache only the link on a regular manifest. Matching manifests and their evidence are always read from disk.
export function openFlowLinkIndex(root: string) {
  const namespace = ["desktop-review", "flow-links"];
  const dataDir = keryxDataDir();
  const name = createHash("sha256").update(root).digest("hex") + ".json";
  const file = path.join(dataDir, ...namespace, name);
  const saved = readConfigFile(file);
  let entries: Record<string, unknown> = {};
  if (saved.ok) {
    try {
      const value: unknown = JSON.parse(saved.text);
      if (value && typeof value === "object" && !Array.isArray(value)) entries = value as Record<string, unknown>;
    } catch { /* Rebuild a damaged local cache from the project manifests. */ }
  }
  let changed = false;
  return {
    lookup(directory: string, stamp: string | undefined): string | undefined {
      const entry = entries[directory];
      return stamp && Array.isArray(entry) && entry[0] === stamp && typeof entry[1] === "string" ? entry[1] : undefined;
    },
    record(directory: string, stamp: string | undefined, link: string) {
      if (!stamp) return;
      const prior = entries[directory];
      if (Array.isArray(prior) && prior[0] === stamp && prior[1] === link) return;
      entries[directory] = [stamp, link];
      changed = true;
    },
    save() {
      if (!changed) return;
      try {
        ensureKeryxSubdir(namespace, dataDir);
        writeOwnerOnlyFileAtomic(file, JSON.stringify(entries));
      } catch { /* A read-only data directory still supports uncached project context. */ }
    },
  };
}

export function flowManifestStamp(file: string): string | undefined {
  try {
    const stat = lstatSync(file, { bigint: true });
    if (stat.isFile()) return [stat.dev, stat.ino, stat.size, stat.ctimeNs, stat.mtimeNs].join(":");
  } catch { /* A Flow may be removed while the board is reading it. */ }
  return undefined;
}
