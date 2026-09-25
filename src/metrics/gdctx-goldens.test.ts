// AC6 (W7-graph-ctx-correctness): fixtures/benchmark/keryx/gdctx-fact-preservation.json
// carries a `goldens` array of self-contained CORRECTNESS regressions (GDCTX-1, GDCTX-2)
// that this file recomputes LIVE against the real production functions — never against a
// captured fixture of output — and requires 100% fact agreement on.
//
// This is deliberately a SEPARATE benchmark from the fixture's `inputs` array (see that
// file's `note`): `inputs` are captured dogfood COMPRESSION measurements that are lossy by
// design (they exercise compactLines' head/tail elision on a listing longer than the line
// budget) and must stay untouched by scripts/benchmark/run-gdctx-oracle.ts's regeneration.
// `goldens` never touch compaction's elision path at all (every golden here is well under
// the compactor's line budget) — they exercise the two CLASSIFICATION/REDACTION regressions
// GDCTX-1 and GDCTX-2 fixed, where "fact preservation" means "did the fix actually keep
// working", not "how much survived a truncation".
//
// Two `kind`s, scored differently (both documented in the fixture's `note`, restated here):
//
//   - "ctx-run" (GDCTX-1): builds the exact CommandResult shape src/commands/ctx.ts's
//     `runCommand` builds (raw = stdout+stderr merged the same way), calls the real
//     `summarizeCommandOutput`, and scores fact agreement the documented way — rawFacts =
//     extractFacts(merged raw), compactFacts = extractFacts(the rendered summary) — via the
//     SAME extractFacts (src/metrics/oracle-runner.ts) the oracle scorer uses. Plus a direct
//     check of `expectErrorsSection` and `mustContainInSummary`.
//
//   - "ctx-read-redaction" (GDCTX-2): calls the real `redactRaw` (src/security/guard.ts)
//     against a temp workspace with security enabled (advisory mode, default config — the
//     same default `sourceOverrides` the shipped `ctx read` -> redactRaw("trusted-project")
//     path relies on). A bare badge/logo URL embedded in `<img src="...">` / `![alt](url)`
//     markup contains no bare file-path or `key: value` token by extractFacts' narrow rule
//     (see oracle-runner.ts's module comment), so running extractFacts over this content
//     would score a vacuous, always-1.0 0/0 agreement and prove nothing. Instead the golden's
//     `mustContain` array IS the fact set for this kind: rawFacts = mustContain (the literal
//     strings `content` minus its `mustNotContain` entries is expected to survive as) and
//     compactFacts = the subset of those found verbatim (substring) in redactRaw's output.
//     Every `mustNotContain` string is additionally asserted absent from the output.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { extractFacts } from "./oracle-runner";
import { redactRaw } from "../security/guard";
import type { SecuritySource } from "../security/types";
import { summarizeCommandOutput } from "../commands/ctx";
import fixture from "../../fixtures/benchmark/keryx/gdctx-fact-preservation.json";

// Same shape as src/commands/ctx.test.ts's CONFIG / src/commands/ctx.ts's (unexported)
// DEFAULT_CONFIG — every golden here is far under these line budgets, so no elision path
// is exercised; only classification (GDCTX-1) is under test through this config.
const CONFIG = {
  maxOutputLines: 120,
  maxImportantLines: 60,
  maxGroupItems: 12,
  compactHeadLines: 120,
  compactTailLines: 80,
  outlineMaxEntries: 160,
};

type CtxRunGolden = {
  readonly id: string;
  readonly kind: "ctx-run";
  readonly command: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly expectErrorsSection: boolean;
  readonly mustContainInSummary: readonly string[];
};

type RedactionGolden = {
  readonly id: string;
  readonly kind: "ctx-read-redaction";
  readonly source: SecuritySource;
  readonly content: string;
  readonly mustContain: readonly string[];
  readonly mustNotContain: readonly string[];
};

type Golden = CtxRunGolden | RedactionGolden;

const goldens = (fixture as { goldens: Golden[] }).goldens;

// The exact merge `runCommand` (src/commands/ctx.ts ~636-649) builds: raw is stdout and
// stderr concatenated, joined by "\n" only when BOTH are non-empty.
function mergedRaw(stdout: string, stderr: string): string {
  return [stdout, stderr].filter(Boolean).join(stderr && stdout ? "\n" : "");
}

function factAgreement(rawFacts: readonly string[], compactFacts: readonly string[]): number {
  if (rawFacts.length === 0) return 1;
  const compactSet = new Set(compactFacts);
  let preserved = 0;
  for (const fact of rawFacts) if (compactSet.has(fact)) preserved += 1;
  return preserved / rawFacts.length;
}

test("gdctx-fact-preservation.json goldens: non-empty, unique ids", () => {
  expect(goldens.length).toBeGreaterThan(0);
  const ids = goldens.map((g) => g.id);
  expect(new Set(ids).size).toBe(ids.length);
});

for (const golden of goldens.filter((g): g is CtxRunGolden => g.kind === "ctx-run")) {
  test(`gdctx golden [${golden.id}] (ctx-run): 100% fact agreement + expectations`, () => {
    const raw = mergedRaw(golden.stdout, golden.stderr);
    const result = { stdout: golden.stdout, stderr: golden.stderr, raw, exitCode: golden.exitCode };
    const summary = summarizeCommandOutput(golden.command, result, CONFIG);

    const rawFacts = extractFacts(raw);
    const compactFacts = extractFacts(summary);
    expect(factAgreement(rawFacts, compactFacts)).toBe(1);

    expect(summary.includes("## Errors / Warnings")).toBe(golden.expectErrorsSection);
    for (const needle of golden.mustContainInSummary) {
      expect(summary).toContain(needle);
    }
  });
}

async function makeSecurityWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "gd-gdctx-golden-"));
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  await writeFile(
    path.join(root, ".metaproject", "metaproject.json"),
    JSON.stringify({ modules: { security: { enabled: true } } }),
    "utf8",
  );
  await writeFile(
    path.join(root, ".metaproject", "security.config.json"),
    JSON.stringify({ mode: "advisory" }),
    "utf8",
  );
  return root;
}

for (const golden of goldens.filter((g): g is RedactionGolden => g.kind === "ctx-read-redaction")) {
  test(`gdctx golden [${golden.id}] (ctx-read-redaction): 100% fact agreement + expectations`, async () => {
    const root = await makeSecurityWorkspace();
    try {
      const out = await redactRaw({ cwd: root, content: golden.content, source: golden.source });

      // rawFacts = mustContain (see module comment above for why extractFacts is not used
      // here); compactFacts = the subset actually found, verbatim, in the redacted output.
      const rawFacts = golden.mustContain;
      const compactFacts = rawFacts.filter((needle) => out.content.includes(needle));
      expect(factAgreement(rawFacts, compactFacts)).toBe(1);

      for (const needle of golden.mustContain) {
        expect(out.content).toContain(needle);
      }
      for (const needle of golden.mustNotContain) {
        expect(out.content).not.toContain(needle);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
