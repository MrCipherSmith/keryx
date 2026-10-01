import { expect, test } from "bun:test";
import { runAdapter } from "./run";
import type { HealthContext, SourceAdapter, SourceId, SourceStatus } from "./types";

// AC5: a `missing` source has to say WHICH check failed, because its reason is
// what reaches `gate.ts`'s `required source unavailable: <source>: <reason>`
// and `OPTIONAL: <source> source missing: <reason>` lines -- the committable
// artifact a human acts on. `resolveBin` looks in `<cwd>/node_modules/.bin`
// then PATH, so a usable reason names the binary AND both lookup places.
//
// Driven with a stub adapter instead of a real fixture tree on purpose: on a
// developer machine a global `eslint`/`tsc` may be on PATH, which would make a
// real fixture detect `available` and say nothing about the reason text. The
// stub fixes the status `detect()` reports; the reason lookup inside
// `runAdapter` (`missingSourceReason`) is the real production code under test.
function stub(id: SourceId, status: SourceStatus): SourceAdapter {
  return {
    id,
    detect: async () => status,
    run: async () => {
      throw new Error("unreachable: a missing source never runs");
    },
    import: async () => {
      throw new Error("unreachable: a missing source never imports");
    },
    parse: () => [],
  };
}

// A tree with no files at all: nothing in it can make a reason claim a config
// file. oxlint's reason reads the tree to name the intent signal that fired
// (config file vs package.json), so the context needs a real `cwd`.
const EMPTY_TREE = { cwd: "/nonexistent-keryx-health-fixture" } as HealthContext;

async function missingInfo(source: SourceId, required: boolean) {
  const outcome = await runAdapter(
    stub(source, "missing"),
    EMPTY_TREE,
    { mode: "auto", required },
    `test-${Date.now()}`,
  );
  return outcome.info;
}

for (const [source, binary, configHint] of [
  ["eslint", "eslint", "config"],
  // No `.oxlintrc.*` in the tree, so the only intent signal left is package.json.
  ["oxlint", "oxlint", "package.json"],
  ["typescript", "tsc", "tsconfig.json"],
] as const) {
  test(`AC5: a missing ${source} source names ${binary} and both lookup places`, async () => {
    const info = await missingInfo(source, true);
    expect(info.status).toBe("missing");
    const reason = info.error ?? "";
    expect(reason.length).toBeGreaterThan(0);
    expect(reason).toContain(binary);
    expect(reason).toContain("node_modules/.bin");
    expect(reason).toContain("PATH");
    // Says the project DID configure the tool, so the reader knows the fix is
    // to install it -- without leaking a path or raw error text (T62 F-005).
    expect(reason).toContain(configHint);
    expect(reason).not.toContain(process.cwd());
    expect(reason).not.toMatch(/\/Users\/|\/home\/|\\/);
    expect(reason).not.toContain("undefined");
  });
}

test("AC5: the pre-existing tests reason still names bun and both lookup places", async () => {
  const info = await missingInfo("tests", false);
  const reason = info.error ?? "";
  expect(reason).toContain("bun");
  expect(reason).toContain("node_modules/.bin");
  expect(reason).toContain("PATH");
});

test("a source with no reason written for it yet falls back to naming only the source", async () => {
  // `complexity` has no `missingSourceReason` entry: it must come back with no
  // invented text (the gate then prints its name-only line) rather than a
  // reason borrowed from another source.
  const info = await missingInfo("complexity", false);
  expect(info.status).toBe("missing");
  expect(info.error).toBeUndefined();
});

test("a SKIPPED source carries no reason -- it never performed a failed lookup", async () => {
  // The `missing` text reads "config found, binary not found". A skipped source
  // has NO config, so attaching that sentence would state a fact about the tree
  // that is false (found by an end-to-end `runHealth` over an oxlint-only
  // project, where the absent eslint reported "eslint config found").
  for (const id of ["eslint", "oxlint", "typescript", "tests"] as const) {
    const outcome = await runAdapter(
      stub(id, "skipped"),
      EMPTY_TREE,
      { mode: "auto", required: false },
      `test-${Date.now()}`,
    );
    expect(outcome.info.status).toBe("skipped");
    expect(outcome.info.error).toBeUndefined();
  }
});
