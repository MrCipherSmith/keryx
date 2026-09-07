// T76 probe -- independent reproduction of the mock.module("./sources", ...)
// cross-file hazard T69-implementation.md and T75-implementation.md both
// document (and both independently hit while designing regressions for this
// exact file, src/health/run.ts). Written fresh, not copied from either.
//
// Judgement-call question this answers: "is the hazard real as described?"
// This file does the ONE thing the shipped health-truthful-gate.test.ts
// regressions deliberately do NOT do -- it mocks the whole `./sources`
// module with `mock.module`, restored synchronously in the same test's
// `finally` (the pattern src/flow/service.test.ts:548-565 uses successfully
// for an analogous `./store` leak regression). Run together with
// src/health/provenance.test.ts (T69's own reproduction case) in a single
// `bun test` invocation, in both file orders, this either corrupts
// provenance.test.ts's assertion (hazard confirmed, matching both prior
// reports) or it does not (hazard reports would be unconfirmed).
import { mock, test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const SOURCES = path.join(import.meta.dir, "../../../../src/health/sources/index.ts");

test("T76 hazard repro: mock.module('./sources', ...) with a same-test synchronous restore, run alongside provenance.test.ts", async () => {
  const realSources = (await import(SOURCES)) as Record<string, unknown>;
  const syntheticAdapter = {
    id: "eslint",
    async detect() {
      return "missing" as const;
    },
    async run() {
      throw new Error("unreachable");
    },
    async import() {
      throw new Error("unreachable");
    },
    parse() {
      return [];
    },
  };

  mock.module(SOURCES, () => ({ ...realSources, FINDING_ADAPTERS: [syntheticAdapter] }));
  try {
    const { runHealth } = await import(path.join(import.meta.dir, "../../../../src/health/run.ts"));
    const root = await mkdtemp(path.join(tmpdir(), "t76-hazard-"));
    try {
      await mkdir(path.join(root, ".metaproject"), { recursive: true });
      await writeFile(path.join(root, "a.ts"), "export const a = 1;\n", "utf8");
      const result = await runHealth({ cwd: root });
      const eslint = (result.report.sources as Array<{ source: string; status: string }>).find(
        (s) => s.source === "eslint",
      );
      // The synthetic single-adapter mock only replaces `eslint`; this
      // assertion is about THIS test's own view, not the hazard itself.
      expect(eslint?.status).toBe("missing");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  } finally {
    // Synchronous restore in the same test, before any other test file's
    // module graph is touched -- exactly the discipline both T69 and T75
    // report is NOT sufficient to prevent the cross-file corruption.
    mock.module(SOURCES, () => realSources);
  }
});
