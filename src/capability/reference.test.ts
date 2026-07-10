import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { resolveCapability, runCapabilityOrFallback } from "./seam";
import { resetWarnOnce } from "./warn-once";
import {
  makeReferenceSpec,
  referenceFallback,
  REFERENCE_CAPABILITY_ID,
} from "./reference";

// The reference capability wired end-to-end through the real seam: manifest
// enable + dep-import + asset-resolve + deterministic fallback (T15/T16,
// AC0-9, AC0-23). HOME is redirected into the temp workspace so the asset cache
// tier resolves deterministically without touching the developer's real cache.

let root: string;
let previousCache: string | undefined;

const ASSET_ID = "gdref-fixture";
const ASSET_BYTES = "reference-asset-bytes\n";

beforeEach(async () => {
  resetWarnOnce();
  root = await mkdtemp(path.join(tmpdir(), "keryx-ref-"));
  previousCache = process.env.KERYX_ASSET_CACHE;
  process.env.KERYX_ASSET_CACHE = path.join(root, ".cache", "keryx", "assets");
});

afterEach(async () => {
  if (previousCache === undefined) {
    delete process.env.KERYX_ASSET_CACHE;
  } else {
    process.env.KERYX_ASSET_CACHE = previousCache;
  }
  await rm(root, { recursive: true, force: true });
});

async function writeManifest(enabled: boolean): Promise<void> {
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  await writeFile(
    path.join(root, ".metaproject", "metaproject.json"),
    JSON.stringify({
      modules: {
        gdgraph: {
          enabled: true,
          capabilities: [{ id: REFERENCE_CAPABILITY_ID, enabled, kind: "ceiling" }],
        },
      },
    }),
    "utf8",
  );
}

// Place the fixture asset in the cache tier and pin it in assets.lock.json.
async function writeVerifiedAsset(): Promise<void> {
  const cacheDir = path.join(root, ".cache", "keryx", "assets");
  await mkdir(cacheDir, { recursive: true });
  await writeFile(path.join(cacheDir, ASSET_ID), ASSET_BYTES, "utf8");
  const sha256 = createHash("sha256").update(ASSET_BYTES).digest("hex");
  await writeFile(
    path.join(root, ".metaproject", "assets.lock.json"),
    JSON.stringify({
      schemaVersion: 1,
      assets: {
        [ASSET_ID]: {
          version: "1.0.0",
          url: "https://assets.keryx.dev/gdref-fixture",
          sha256,
          size: Buffer.byteLength(ASSET_BYTES),
        },
      },
    }),
    "utf8",
  );
}

test("availability-true: dep present + asset verified → capability runs", async () => {
  await writeManifest(true);
  await writeVerifiedAsset();

  // node:util is always importable → stands in for an installed optional dep.
  const spec = makeReferenceSpec({ optionalDependency: "node:util", asset: ASSET_ID });
  const adapter = await resolveCapability(root, spec);

  expect(adapter).not.toBeNull();
  const output = await runCapabilityOrFallback(adapter, { text: "metapro" }, () =>
    referenceFallback({ text: "metapro" }),
  );
  // Capability path reverses; fallback would upper-case. Reversed proves it ran.
  expect(output).toBe("orpatem");
});

test("availability-false: dep absent → deterministic fallback, exit-0 semantics", async () => {
  await writeManifest(true);
  await writeVerifiedAsset();

  const spec = makeReferenceSpec({
    optionalDependency: "@keryx/definitely-not-installed",
    asset: ASSET_ID,
  });
  const adapter = await resolveCapability(root, spec);

  expect(adapter).toBeNull();
  const output = await runCapabilityOrFallback(adapter, { text: "metapro" }, () =>
    referenceFallback({ text: "metapro" }),
  );
  // Deterministic fallback (upper-case), byte-identical to capability-off.
  expect(output).toBe("METAPRO");
});

test("availability-false: verified asset but capability disabled → fallback", async () => {
  await writeManifest(false);
  await writeVerifiedAsset();

  const spec = makeReferenceSpec({ optionalDependency: "node:util", asset: ASSET_ID });
  const adapter = await resolveCapability(root, spec);

  expect(adapter).toBeNull();
  const output = await runCapabilityOrFallback(adapter, { text: "abc" }, () =>
    referenceFallback({ text: "abc" }),
  );
  expect(output).toBe("ABC");
});
