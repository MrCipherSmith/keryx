// AFC-13 / AC5 requirement 4: "fixture даёт реальные symbols после явной
// установки" — a fixture that genuinely yields real symbols after an
// explicit runtime/grammar installation. This task is forbidden from
// performing that installation (no dependency installs of any kind).
//
// So this file does NOT install anything. It probes whether a working
// `web-tree-sitter` runtime + a real, verified grammar are ALREADY present in
// this environment (exactly the state an explicit install would produce) and:
//   - genuinely present  ⇒ the test RUNS FOR REAL against the real adapter
//     (`resolveTreesitterCapability`, the actual production entry point —
//     not a mock) and asserts real, non-empty symbols extracted from a real
//     TypeScript fixture by the real grammar.
//   - genuinely absent   ⇒ `test.skipIf` marks the test SKIPPED (visible as
//     "skip" in `bun test`'s own summary, not a silent pass), with the reason
//     embedded in the test name.
//
// A vacuous pass (the "absent" branch quietly returning without asserting
// anything) would NOT be evidence for requirement 4 — `test.skipIf` is used
// specifically so an absent environment shows up as a skip, never as a pass.

import { expect, test } from "bun:test";
import { resolveTreesitterCapability } from "./adapter";

const FIXTURE_SOURCE = ["export function boot(): void {", "  tick();", "}", "", "function tick(): void {}", ""].join(
  "\n",
);

// Probed once at module load (top-level await — this file's only test needs
// the answer before `test.skipIf` decides whether to run). This calls the
// REAL `resolveTreesitterCapability` against the real project root, so it
// reflects whatever runtime + grammar state is genuinely on this machine —
// no mocking, no injected `dep`.
const projectRoot = process.cwd();
const probedAdapter = await resolveTreesitterCapability(projectRoot, {
  languages: ["typescript"],
  grammarsPath: null,
});
const skipReason = probedAdapter
  ? ""
  : "no working web-tree-sitter runtime + verified typescript grammar resolved in this environment " +
    "(gdgraph.treesitter must be enabled in metaproject.json AND a matching grammar installed via " +
    '"keryx gdgraph assets pull tree-sitter-typescript" — an install this task must not perform)';

test.skipIf(!probedAdapter)(
  skipReason ? `AC5.req4 — real fixture yields real symbols [SKIPPED: ${skipReason}]` : "AC5.req4 — real fixture yields real symbols after explicit installation",
  async () => {
    const adapter = probedAdapter;
    if (!adapter) {
      // Unreachable when the test actually runs (skipIf gates it), kept only
      // so TypeScript sees the non-null adapter below without a cast.
      throw new Error("AC5.req4 ran without a resolved adapter — skipIf condition was wrong");
    }

    const layer = await adapter.run({
      files: [{ path: "fixtures/treesitter/ac5-req4-fixture.ts", content: FIXTURE_SOURCE }],
    });

    // Real symbols, not a mock's canned output: names, kinds, and a resolved
    // call edge all come from the actually-installed tree-sitter grammar
    // parsing actual TypeScript source.
    expect(layer.symbols.length).toBeGreaterThan(0);
    const byName = Object.fromEntries(layer.symbols.map((s) => [s.name, s]));
    expect(byName.boot).toMatchObject({ kind: "function", language: "typescript" });
    expect(byName.tick).toMatchObject({ kind: "function", language: "typescript" });

    const callSummaries = layer.calls.map((c) => `${c.kind}:${c.from}=>${c.to}`);
    expect(callSummaries).toContain(
      "calls:fixtures/treesitter/ac5-req4-fixture.ts#boot=>fixtures/treesitter/ac5-req4-fixture.ts#tick",
    );
  },
);
