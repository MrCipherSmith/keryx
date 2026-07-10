import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { resolveAsset } from "./resolver";
import { pullAsset, type AssetFetcher } from "./pull";
import { normalizeLock, registryFromLock, validateAssetsLock, type AssetRegistry, type AssetsLock } from "./lock";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "keryx-assets-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const CONTENT = "grammar-bytes-v1\n";
const SHA = createHash("sha256").update(CONTENT).digest("hex");

function registryWithPath(assetPath: string, sha = SHA): AssetRegistry {
  return {
    assets: {
      grammar: { id: "grammar", sha256: sha, size: Buffer.byteLength(CONTENT), path: assetPath },
    },
  };
}

test("resolveAsset: valid user-path asset verifies sha256 and resolves", async () => {
  const assetPath = path.join(root, "grammar.bin");
  await writeFile(assetPath, CONTENT, "utf8");

  const resolved = await resolveAsset(registryWithPath(assetPath), "grammar");
  expect(resolved).not.toBeNull();
  expect(resolved!.verified).toBe(true);
  expect(resolved!.sha256).toBe(SHA);
  expect(resolved!.path).toBe(assetPath);
});

test("resolveAsset: missing file resolves to null", async () => {
  const resolved = await resolveAsset(
    registryWithPath(path.join(root, "absent.bin")),
    "grammar",
  );
  expect(resolved).toBeNull();
});

test("resolveAsset: tampered file (checksum mismatch) resolves to null", async () => {
  const assetPath = path.join(root, "grammar.bin");
  await writeFile(assetPath, "TAMPERED CONTENT", "utf8");

  const resolved = await resolveAsset(registryWithPath(assetPath), "grammar");
  expect(resolved).toBeNull();
});

test("resolveAsset: unknown id resolves to null", async () => {
  const resolved = await resolveAsset({ assets: {} }, "grammar");
  expect(resolved).toBeNull();
});

test("resolveAsset opens no socket (network-free)", async () => {
  const assetPath = path.join(root, "grammar.bin");
  await writeFile(assetPath, CONTENT, "utf8");

  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  // Any network attempt would throw and fail the assertion below.
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error("network blocked");
  }) as unknown as typeof fetch;
  try {
    const resolved = await resolveAsset(registryWithPath(assetPath), "grammar");
    expect(resolved).not.toBeNull();
  } finally {
    globalThis.fetch = originalFetch;
  }
  expect(fetchCalls).toBe(0);
});

const LOCK: AssetsLock = {
  schemaVersion: 1,
  assets: {
    grammar: {
      version: "1.0.0",
      url: "https://assets.example.dev/grammar",
      sha256: SHA,
      size: Buffer.byteLength(CONTENT),
    },
  },
};

test("pullAsset: verified download is written to the cache", async () => {
  const destDir = path.join(root, "cache");
  const fetcher: AssetFetcher = async () => ({
    ok: true,
    status: 200,
    bytes: async () => new Uint8Array(Buffer.from(CONTENT)),
  });

  const resolved = await pullAsset("grammar", LOCK, { fetcher, destDir });
  expect(resolved.verified).toBe(true);
  expect(resolved.path).toBe(path.join(destDir, "grammar"));
  expect((await readdir(destDir)).length).toBe(1);
});

test("pullAsset: checksum mismatch refuses and writes no file", async () => {
  const destDir = path.join(root, "cache-mismatch");
  const fetcher: AssetFetcher = async () => ({
    ok: true,
    status: 200,
    bytes: async () => new Uint8Array(Buffer.from("WRONG BYTES")),
  });

  await expect(pullAsset("grammar", LOCK, { fetcher, destDir })).rejects.toThrow(
    /Checksum mismatch/,
  );
  // No file written on refusal.
  await expect(readdir(destDir)).rejects.toBeDefined();
});

test("pullAsset: unknown id throws before any fetch", async () => {
  let fetchCalls = 0;
  const fetcher: AssetFetcher = async () => {
    fetchCalls += 1;
    return { ok: true, status: 200, bytes: async () => new Uint8Array() };
  };
  await expect(pullAsset("nope", LOCK, { fetcher })).rejects.toThrow(/Unknown asset/);
  expect(fetchCalls).toBe(0);
});

test("normalizeLock drops malformed entries; validateAssetsLock accepts the scaffold", () => {
  const normalized = normalizeLock({
    schemaVersion: 1,
    assets: {
      ok: { version: "1", url: "u", sha256: "a".repeat(64), size: 1 },
      // @ts-expect-error malformed on purpose
      bad: { version: "1" },
    },
  });
  expect(Object.keys(normalized.assets)).toEqual(["ok"]);

  const registry = registryFromLock(normalized);
  expect(registry.assets.ok?.id).toBe("ok");

  expect(
    validateAssetsLock({
      schemaVersion: 1,
      assets: { grammar: { version: "1.0.0", url: "u", sha256: "a".repeat(64), size: 1 } },
    }),
  ).toEqual([]);
});
