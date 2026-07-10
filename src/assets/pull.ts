// Asset pull — THE ONLY network path in keryx (specification.md §6, §6a;
// arch §3; AC0-15, AC0-16). Used solely by `<module> assets pull <id>`.
//
// `pullAsset(id, lock)` fetches the pinned url, verifies the download's sha256
// against `assets.lock.json`, and REFUSES on mismatch — throwing before any
// file is written, so a tampered/mismatched download never lands on disk. On a
// verified match it writes the bytes to the well-known cache and returns the
// resolved asset. The fetcher is injectable so tests exercise the verify/refuse
// contract without opening a real socket.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { assetCacheDir, sha256Bytes, type ResolvedAsset } from "./resolver";
import type { AssetsLock } from "./lock";

// A minimal fetch abstraction so the network dependency is injectable in tests.
export type AssetFetchResponse = {
  ok: boolean;
  status: number;
  bytes: () => Promise<Uint8Array>;
};
export type AssetFetcher = (url: string) => Promise<AssetFetchResponse>;

// The real network fetcher — the single place `fetch` is invoked for assets.
const defaultFetcher: AssetFetcher = async (url) => {
  const response = await fetch(url);
  return {
    ok: response.ok,
    status: response.status,
    bytes: async () => new Uint8Array(await response.arrayBuffer()),
  };
};

export interface PullOptions {
  fetcher?: AssetFetcher;
  destDir?: string;
}

// Fetch, verify, and (only on match) persist a pinned asset. Throws on unknown
// id, HTTP failure, or checksum mismatch; on mismatch NO file is written.
export async function pullAsset(
  id: string,
  lock: AssetsLock,
  options: PullOptions = {},
): Promise<ResolvedAsset> {
  const entry = lock.assets[id];
  if (!entry) {
    throw new Error(`Unknown asset "${id}": not present in assets.lock.json`);
  }

  const fetcher = options.fetcher ?? defaultFetcher;
  const response = await fetcher(entry.url);
  if (!response.ok) {
    throw new Error(
      `Failed to download asset "${id}" from ${entry.url}: HTTP ${response.status}`,
    );
  }

  const bytes = await response.bytes();
  const actual = sha256Bytes(bytes);
  if (actual !== entry.sha256) {
    // Refuse: do not write anything. Provenance mismatch is a hard failure.
    throw new Error(
      `Checksum mismatch for asset "${id}": expected ${entry.sha256}, got ${actual}. Refusing to write.`,
    );
  }

  const destDir = options.destDir ?? assetCacheDir();
  const destPath = path.join(destDir, id);
  await mkdir(destDir, { recursive: true });
  await writeFile(destPath, bytes);
  return { path: destPath, sha256: actual, verified: true };
}
