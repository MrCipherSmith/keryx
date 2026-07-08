import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  isCapabilityEnabled,
  resolveCapability,
  runCapabilityOrFallback,
  type CapabilitySpec,
} from "./seam";
import { hasWarned, resetWarnOnce } from "./warn-once";
import { makeReferenceSpec, referenceFallback, REFERENCE_CAPABILITY_ID } from "./reference";

let root: string;

beforeEach(async () => {
  resetWarnOnce();
  root = await mkdtemp(path.join(tmpdir(), "keryx-seam-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

// Write a manifest enabling (or not) the reference capability under gdgraph.
async function writeManifest(enabled: boolean | "absent"): Promise<void> {
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  const capabilities =
    enabled === "absent"
      ? []
      : [{ id: REFERENCE_CAPABILITY_ID, enabled, kind: "ceiling" }];
  await writeFile(
    path.join(root, ".metaproject", "metaproject.json"),
    JSON.stringify({ modules: { gdgraph: { enabled: true, capabilities } } }),
    "utf8",
  );
}

test("available: enabled + importable dep resolves to an adapter that runs", async () => {
  await writeManifest(true);
  const spec = makeReferenceSpec({ optionalDependency: "node:util" });

  const adapter = await resolveCapability(root, spec);
  expect(adapter).not.toBeNull();
  const output = await adapter!.run({ text: "abc" });
  expect(output).toBe("cba");
  expect(hasWarned(REFERENCE_CAPABILITY_ID)).toBe(false);
});

test("disabled in manifest: returns null with no warning", async () => {
  await writeManifest(false);
  const spec = makeReferenceSpec({ optionalDependency: "node:util" });

  const adapter = await resolveCapability(root, spec);
  expect(adapter).toBeNull();
  // A disabled ceiling is the normal default path — it must not warn.
  expect(hasWarned(REFERENCE_CAPABILITY_ID)).toBe(false);
});

test("missing manifest = capability off", async () => {
  // No .metaproject written at all.
  expect(await isCapabilityEnabled(root, REFERENCE_CAPABILITY_ID)).toBe(false);
  const adapter = await resolveCapability(
    root,
    makeReferenceSpec({ optionalDependency: "node:util" }),
  );
  expect(adapter).toBeNull();
});

test("dep missing: enabled but dependency not installed degrades + warns once", async () => {
  await writeManifest(true);
  const spec = makeReferenceSpec({
    optionalDependency: "@keryx/definitely-not-installed",
  });

  expect(await resolveCapability(root, spec)).toBeNull();
  expect(hasWarned(REFERENCE_CAPABILITY_ID)).toBe(true);
});

test("asset missing: enabled + importable dep but unresolved asset degrades", async () => {
  await writeManifest(true);
  const spec = makeReferenceSpec({
    optionalDependency: "node:util",
    asset: "no-such-asset",
  });

  expect(await resolveCapability(root, spec)).toBeNull();
  expect(hasWarned(REFERENCE_CAPABILITY_ID)).toBe(true);
});

test("adapter that throws at isAvailable() is caught → null", async () => {
  await writeManifest(true);
  const throwingSpec: CapabilitySpec<{ text: string }, string> = {
    id: REFERENCE_CAPABILITY_ID,
    load() {
      return {
        id: REFERENCE_CAPABILITY_ID,
        async isAvailable() {
          throw new Error("boom in isAvailable");
        },
        async run() {
          return "unreachable";
        },
      };
    },
  };

  const adapter = await resolveCapability(root, throwingSpec);
  expect(adapter).toBeNull();
  expect(hasWarned(REFERENCE_CAPABILITY_ID)).toBe(true);
});

test("adapter that throws at run() never propagates via runCapabilityOrFallback", async () => {
  await writeManifest(true);
  const throwingRun: CapabilitySpec<{ text: string }, string> = {
    id: REFERENCE_CAPABILITY_ID,
    load() {
      return {
        id: REFERENCE_CAPABILITY_ID,
        async isAvailable() {
          return true;
        },
        async run() {
          throw new Error("boom in run");
        },
      };
    },
  };

  const adapter = await resolveCapability(root, throwingRun);
  expect(adapter).not.toBeNull();
  const result = await runCapabilityOrFallback(adapter, { text: "hello" }, () =>
    referenceFallback({ text: "hello" }),
  );
  // Deterministic fallback (upper-case), not an uncaught exception.
  expect(result).toBe("HELLO");
});

test("warn-once: many failing resolves emit exactly one stderr line", async () => {
  await writeManifest(true);
  const spec = makeReferenceSpec({
    optionalDependency: "@keryx/definitely-not-installed",
  });

  const originalWrite = process.stderr.write.bind(process.stderr);
  let lines = 0;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    if (typeof chunk === "string" && chunk.includes(REFERENCE_CAPABILITY_ID)) {
      lines += 1;
    }
    return true;
  }) as typeof process.stderr.write;
  try {
    await resolveCapability(root, spec);
    await resolveCapability(root, spec);
    await resolveCapability(root, spec);
  } finally {
    process.stderr.write = originalWrite;
  }
  expect(lines).toBe(1);
});

test("runCapabilityOrFallback returns fallback when adapter is null", async () => {
  const result = await runCapabilityOrFallback(null, { text: "x" }, () =>
    referenceFallback({ text: "x" }),
  );
  expect(result).toBe("X");
});
