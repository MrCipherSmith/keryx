// flow 330 — `keryx review jev-rules`, driven through the real CLI dispatcher
// (AC8: CLI tests with fixture diff + fixture rules + fixture Jev responses;
// schema validation against reviewer-finding.schema.json). Hermetic: no
// network (a fixtures dir stands in for Jev), no real git (scope mode reads
// a hand-written scope.json), macOS-safe (mkdtemp under the OS tmp dir).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { reviewCommand } from "./review";
import { validateJson, type JsonSchema } from "../gdskills/contracts";

const ORIGINAL_CWD = process.cwd();
const ORIGINAL_KEY = process.env.OPENROUTER_API_KEY;
const realLog = console.log;
const realError = console.error;

let ROOT = "";
let logs: string[] = [];

function output(): string {
  return logs.join("\n");
}

async function projectRoot(enabled: boolean): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "keryx-jev-rules-cli-"));
  await mkdir(path.join(dir, ".metaproject"), { recursive: true });
  await writeFile(path.join(dir, ".metaproject", "tasks.config.json"), JSON.stringify({ review: { jev: { rules: enabled } } }), "utf8");
  return dir;
}

/**
 * One rule doc at `.metaproject/rules/test-rule.mdc` — discovered
 * automatically, no `--rules` needed. Three clauses, all tagged EXPLICITLY
 * (`[state:hunk]`/`[not-checkable: ...]`) so no clause-tagging Jev call is
 * ever made by a test that does not itself exercise tagging: a rationale
 * bullet (used as `impact` for the others, and excluded from pairing by the
 * `not-checkable` marker) and two checkable clauses.
 */
async function writeTestRule(root: string): Promise<void> {
  await mkdir(path.join(root, ".metaproject", "rules"), { recursive: true });
  await writeFile(
    path.join(root, ".metaproject", "rules", "test-rule.mdc"),
    [
      "# Test Rule",
      "",
      "## Rationale",
      "",
      "- Keeps the test deterministic and easy to reason about. [not-checkable: a rationale statement, not itself a checkable rule]",
      "",
      "## Clauses",
      "",
      "- Every widget must be documented. [state:hunk]",
      "- Every widget must have a test. [state:hunk]",
      "",
    ].join("\n"),
    "utf8",
  );
}

/** One region, `src/widget.ts:1-3`. */
async function writeScope(root: string): Promise<string> {
  const scopePath = path.join(root, "scope.json");
  await writeFile(
    scopePath,
    JSON.stringify({
      schemaVersion: 1,
      mode: "diff",
      contextLines: 20,
      files: ["src/widget.ts"],
      regions: [{ path: "src/widget.ts", startLine: 1, endLine: 3, changedLines: 1, contextTruncated: false, text: "+export function widget() {}" }],
      drops: [],
      counts: {
        filesSeen: 1,
        filesRetained: 1,
        filesDropped: 0,
        blocksSeen: 1,
        blocksRetained: 1,
        blocksDropped: 0,
        changedLinesRetained: 1,
        changedLinesDropped: 0,
        droppedByReason: { lockfile: 0, generated: 0, vendored: 0, snapshot: 0, minified: 0, binary: 0, "whitespace-only": 0, "comment-only": 0 },
      },
    }),
    "utf8",
  );
  return scopePath;
}

async function writeFixtures(root: string, answers: Record<string, { type: "noul"; noul: number }>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "keryx-jev-rules-fixtures-"));
  await writeFile(path.join(dir, "jev-responses.json"), JSON.stringify([{ answers, usage: { input_tokens: 100, output_tokens: 5, cost: 0.001 } }]), "utf8");
  return dir;
}

beforeEach(() => {
  logs = [];
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
});

afterEach(async () => {
  console.log = realLog;
  console.error = realError;
  process.chdir(ORIGINAL_CWD);
  process.exitCode = 0;
  if (ORIGINAL_KEY === undefined) {
    delete process.env.OPENROUTER_API_KEY;
  } else {
    process.env.OPENROUTER_API_KEY = ORIGINAL_KEY;
  }
  if (ROOT) {
    await rm(ROOT, { recursive: true, force: true });
    ROOT = "";
  }
});

describe("AC8: keryx review jev-rules --scope <scope.json> --json", () => {
  test("emits one finding, above threshold, schema-valid against reviewer-finding.schema.json", async () => {
    ROOT = await projectRoot(true);
    await writeTestRule(ROOT);
    const scopePath = await writeScope(ROOT);
    const fixturesDir = await writeFixtures(ROOT, {
      ".metaproject/rules/test-rule.mdc::clauses-1": { type: "noul", noul: 0.95 },
      ".metaproject/rules/test-rule.mdc::clauses-2": { type: "noul", noul: 0.1 },
    });
    process.chdir(ROOT);
    process.env.OPENROUTER_API_KEY = "sk-or-test";

    await reviewCommand(["jev-rules", "--scope", scopePath, "--fixtures", fixturesDir, "--json"]);

    const parsed = JSON.parse(output()) as {
      status: string;
      reviewer: string;
      findings: Array<Record<string, unknown>>;
      stats: Record<string, number>;
      droppedClauses: Array<{ ruleId: string; clauseId: string; reason: string }>;
      tokens: { jevCalls: number; taggingCalls: number; violationCalls: number };
    };
    expect(parsed.reviewer).toBe("review-jev-rules");
    expect(parsed.findings).toHaveLength(1);
    const finding = parsed.findings[0]!;
    expect(finding.file).toBe("src/widget.ts");
    expect(finding.problem).toContain("clauses-1");
    expect(finding.impact).toBe("Keeps the test deterministic and easy to reason about.");
    expect(finding.reviewer).toBe("review-jev-rules");
    expect(process.exitCode ?? 0).toBe(0);
    // The rationale clause is tagged `[not-checkable: ...]` — excluded from pairing, reported, never sent to Jev.
    expect(parsed.droppedClauses).toEqual([
      { ruleId: ".metaproject/rules/test-rule.mdc", clauseId: "rationale-1", reason: "a rationale statement, not itself a checkable rule" },
    ]);
    // No explicit-marker clause ever needs a Jev tagging call.
    expect(parsed.tokens.taggingCalls).toBe(0);
    expect(parsed.tokens.violationCalls).toBe(1);

    const schemaRaw = await readFile(
      path.join(import.meta.dir, "..", "gdskills", "bundled", "skills", "review", "review-orchestrator", "reviewer-finding.schema.json"),
      "utf8",
    );
    const schema = JSON.parse(schemaRaw) as JsonSchema;
    const errors = await validateJson(parsed, schema);
    expect(errors).toEqual([]);
  });

  test("below threshold: no finding, but usage/selection are still reported", async () => {
    ROOT = await projectRoot(true);
    await writeTestRule(ROOT);
    const scopePath = await writeScope(ROOT);
    const fixturesDir = await writeFixtures(ROOT, {
      ".metaproject/rules/test-rule.mdc::clauses-1": { type: "noul", noul: 0.2 },
      ".metaproject/rules/test-rule.mdc::clauses-2": { type: "noul", noul: 0.1 },
    });
    process.chdir(ROOT);
    process.env.OPENROUTER_API_KEY = "sk-or-test";

    await reviewCommand(["jev-rules", "--scope", scopePath, "--fixtures", fixturesDir, "--json"]);
    const parsed = JSON.parse(output()) as { findings: unknown[]; status: string; tokens: { jevCalls: number; taggingCalls: number; violationCalls: number } };
    expect(parsed.findings).toEqual([]);
    expect(parsed.status).toBe("DONE");
    expect(parsed.tokens.jevCalls).toBe(1);
    expect(parsed.tokens.taggingCalls).toBe(0);
    expect(parsed.tokens.violationCalls).toBe(1);
  });

  test("--max-calls caps the pairs selected, reported rather than silently truncated", async () => {
    ROOT = await projectRoot(true);
    await writeTestRule(ROOT);
    const scopePath = await writeScope(ROOT);
    const fixturesDir = await writeFixtures(ROOT, { ".metaproject/rules/test-rule.mdc::clauses-1": { type: "noul", noul: 0.6 } });
    process.chdir(ROOT);
    process.env.OPENROUTER_API_KEY = "sk-or-test";

    await reviewCommand(["jev-rules", "--scope", scopePath, "--fixtures", fixturesDir, "--max-calls", "1", "--json"]);
    const parsed = JSON.parse(output()) as { selection: { maxCalls: number; selectedPairs: number; droppedPairs: number } };
    expect(parsed.selection.maxCalls).toBe(1);
    expect(parsed.selection.selectedPairs).toBe(1);
    expect(parsed.selection.droppedPairs).toBe(1);
  });

  test("no rule sources discovered: zero findings, not an error", async () => {
    ROOT = await projectRoot(true);
    const scopePath = await writeScope(ROOT);
    process.chdir(ROOT);
    process.env.OPENROUTER_API_KEY = "sk-or-test";

    await reviewCommand(["jev-rules", "--scope", scopePath, "--json"]);
    const parsed = JSON.parse(output()) as { findings: unknown[]; ruleSources: unknown[] };
    expect(parsed.findings).toEqual([]);
    expect(parsed.ruleSources).toEqual([]);
    expect(process.exitCode ?? 0).toBe(0);
  });
});

/** A scope with one region at `filePath`, `text` as the (already `+`-prefixed) changed line. */
async function writeScopeFor(root: string, filePath: string, text: string): Promise<string> {
  const scopePath = path.join(root, `scope-${filePath.replace(/[/.]/g, "-")}.json`);
  await writeFile(
    scopePath,
    JSON.stringify({
      schemaVersion: 1,
      mode: "diff",
      contextLines: 20,
      files: [filePath],
      regions: [{ path: filePath, startLine: 1, endLine: 3, changedLines: 1, contextTruncated: false, text }],
      drops: [],
      counts: {
        filesSeen: 1,
        filesRetained: 1,
        filesDropped: 0,
        blocksSeen: 1,
        blocksRetained: 1,
        blocksDropped: 0,
        changedLinesRetained: 1,
        changedLinesDropped: 0,
        droppedByReason: { lockfile: 0, generated: 0, vendored: 0, snapshot: 0, minified: 0, binary: 0, "whitespace-only": 0, "comment-only": 0 },
      },
    }),
    "utf8",
  );
  return scopePath;
}

/** A JSON array of `{answers, usage}` bodies, ONE per Jev call in order — unlike `writeFixtures`, this can model a TAGGING call followed by a VIOLATION call (or any other sequence a test needs). */
async function writeCallSequenceFixtures(
  responses: ReadonlyArray<Record<string, { type: "choice"; choice: string } | { type: "noul"; noul: number }>>,
): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "keryx-jev-rules-fixtures-"));
  await writeFile(
    path.join(dir, "jev-responses.json"),
    JSON.stringify(responses.map((answers) => ({ answers, usage: { input_tokens: 50, output_tokens: 3, cost: 0.0005 } }))),
    "utf8",
  );
  return dir;
}

describe("AC-follow-up 1: reused conform clause tagging, cached across runs", () => {
  async function writeUntaggedRule(root: string): Promise<void> {
    await mkdir(path.join(root, ".metaproject", "rules"), { recursive: true });
    await writeFile(
      path.join(root, ".metaproject", "rules", "fresh-rule.mdc"),
      ["# Fresh Rule", "", "## Clauses", "", "- Every exported function needs a docstring.", ""].join("\n"),
      "utf8",
    );
  }

  test("an untagged clause costs one tagging call plus one violation call; a later run against a DIFFERENT hunk (same rule doc) reuses the cached tag", async () => {
    ROOT = await projectRoot(true);
    await writeUntaggedRule(ROOT);
    process.chdir(ROOT);
    process.env.OPENROUTER_API_KEY = "sk-or-test";

    const scope1 = await writeScopeFor(ROOT, "src/widget.ts", "+export function widget() {}");
    const fixtures1 = await writeCallSequenceFixtures([
      { "clauses-1": { type: "choice", choice: "hunk" } },
      { ".metaproject/rules/fresh-rule.mdc::clauses-1": { type: "noul", noul: 0.9 } },
    ]);
    await reviewCommand(["jev-rules", "--scope", scope1, "--fixtures", fixtures1, "--json"]);
    const first = JSON.parse(output()) as {
      tokens: { jevCalls: number; taggingCalls: number; violationCalls: number };
      findings: Array<{ file: string }>;
    };
    expect(first.tokens.taggingCalls).toBe(1);
    expect(first.tokens.violationCalls).toBe(1);
    expect(first.tokens.jevCalls).toBe(2);
    expect(first.findings).toHaveLength(1);
    expect(first.findings[0]?.file).toBe("src/widget.ts");

    logs = [];
    const scope2 = await writeScopeFor(ROOT, "src/other.ts", "+export function other() {}");
    // Only ONE response supplied — a second tagging call here would throw
    // (`fixtureJevFetch`'s own "a call beyond that was made"), so this run
    // PROVES the tag cache was hit rather than merely asserting a count.
    const fixtures2 = await writeCallSequenceFixtures([{ ".metaproject/rules/fresh-rule.mdc::clauses-1": { type: "noul", noul: 0.4 } }]);
    await reviewCommand(["jev-rules", "--scope", scope2, "--fixtures", fixtures2, "--json"]);
    const second = JSON.parse(output()) as { tokens: { jevCalls: number; taggingCalls: number; violationCalls: number }; findings: unknown[] };
    expect(second.tokens.taggingCalls).toBe(0);
    expect(second.tokens.violationCalls).toBe(1);
    expect(second.findings).toEqual([]);
  });
});

describe("AC-follow-up 2: rule-source category filter, applied before clause extraction", () => {
  async function writeProcessAndCodeRules(root: string): Promise<void> {
    await mkdir(path.join(root, ".metaproject", "rules"), { recursive: true });
    await writeFile(
      path.join(root, ".metaproject", "rules", "commit-message-formatting.mdc"),
      ["# Commit Message Formatting", "", "## Clauses", "", "- Commit subjects must be imperative mood. [state:hunk]", ""].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(root, ".metaproject", "rules", "code-style.mdc"),
      ["# Code Style", "", "## Clauses", "", "- Every widget must be documented. [state:hunk]", ""].join("\n"),
      "utf8",
    );
  }

  test("a process-named rule file is excluded before clause extraction; a code-named one is still checked", async () => {
    ROOT = await projectRoot(true);
    await writeProcessAndCodeRules(ROOT);
    const scopePath = await writeScope(ROOT);
    const fixturesDir = await writeFixtures(ROOT, { ".metaproject/rules/code-style.mdc::clauses-1": { type: "noul", noul: 0.7 } });
    process.chdir(ROOT);
    process.env.OPENROUTER_API_KEY = "sk-or-test";

    await reviewCommand(["jev-rules", "--scope", scopePath, "--fixtures", fixturesDir, "--json"]);
    const parsed = JSON.parse(output()) as {
      ruleSources: Array<{ path: string; kind: string }>;
      excludedSources: Array<{ path: string; kind: string; reason: string }>;
      findings: Array<{ problem: string }>;
    };
    expect(parsed.ruleSources.map((s) => s.path)).toEqual([".metaproject/rules/code-style.mdc"]);
    expect(parsed.excludedSources).toHaveLength(1);
    expect(parsed.excludedSources[0]?.path).toBe(".metaproject/rules/commit-message-formatting.mdc");
    expect(parsed.excludedSources[0]?.reason).toContain("commit");
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0]?.problem).toContain("code-style.mdc");
  });

  test("--rules names the excluded file explicitly: the category filter is bypassed for it", async () => {
    ROOT = await projectRoot(true);
    await writeProcessAndCodeRules(ROOT);
    const scopePath = await writeScope(ROOT);
    const fixturesDir = await writeFixtures(ROOT, {
      ".metaproject/rules/code-style.mdc::clauses-1": { type: "noul", noul: 0.2 },
      ".metaproject/rules/commit-message-formatting.mdc::clauses-1": { type: "noul", noul: 0.2 },
    });
    process.chdir(ROOT);
    process.env.OPENROUTER_API_KEY = "sk-or-test";

    await reviewCommand([
      "jev-rules",
      "--scope",
      scopePath,
      "--rules",
      ".metaproject/rules/commit-message-formatting.mdc",
      "--fixtures",
      fixturesDir,
      "--json",
    ]);
    const parsed = JSON.parse(output()) as { ruleSources: Array<{ path: string }>; excludedSources: unknown[] };
    expect(parsed.ruleSources.map((s) => s.path).sort()).toEqual([".metaproject/rules/code-style.mdc", ".metaproject/rules/commit-message-formatting.mdc"]);
    expect(parsed.excludedSources).toEqual([]);
  });
});

describe("AC6: opt-in and credential gating — both refuse before any read", () => {
  test("review.jev.rules absent/false: refused, the scope file is never even opened", async () => {
    ROOT = await projectRoot(false);
    process.chdir(ROOT);
    process.env.OPENROUTER_API_KEY = "sk-or-test";

    await reviewCommand(["jev-rules", "--scope", path.join(ROOT, "does-not-exist.json"), "--json"]);

    expect(output().toLowerCase()).toContain("review.jev.rules");
    expect(output().toLowerCase()).toContain("not enabled");
    expect(process.exitCode).toBe(1);
  });

  test("enabled but no OPENROUTER_API_KEY (and no saved key): refused, no network call possible", async () => {
    ROOT = await projectRoot(true);
    process.chdir(ROOT);
    delete process.env.OPENROUTER_API_KEY;

    await reviewCommand(["jev-rules", "--scope", path.join(ROOT, "does-not-exist.json"), "--json"]);

    expect(output()).toContain("OPENROUTER_API_KEY");
    expect(process.exitCode).toBe(1);
  });
});

describe("usage: exactly one of --diff/--pr/--scope is required", () => {
  test("none given is refused", async () => {
    ROOT = await projectRoot(true);
    process.chdir(ROOT);
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    await reviewCommand(["jev-rules", "--json"]);
    expect(output()).toContain("Usage: keryx review jev-rules");
  });

  test("two given is refused", async () => {
    ROOT = await projectRoot(true);
    process.chdir(ROOT);
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    await reviewCommand(["jev-rules", "--diff", "HEAD", "--pr", "1", "--json"]);
    expect(output()).toContain("Usage: keryx review jev-rules");
  });
});

describe("keryx review reviewers --json lists review-jev-rules with engine: jev", () => {
  test("once its SKILL.md is installed under .metaproject", async () => {
    ROOT = await projectRoot(true);
    const dir = path.join(ROOT, ".metaproject", "skills", "gdskills", "review", "review-jev-rules");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "SKILL.md"), '---\nname: review-jev-rules\nmetadata:\n  engine: "jev"\n---\n', "utf8");
    process.chdir(ROOT);

    await reviewCommand(["reviewers", "--json"]);
    const parsed = JSON.parse(output()) as { bundled: Array<{ name: string; engine?: string }> };
    const entry = parsed.bundled.find((r) => r.name === "review-jev-rules");
    expect(entry?.engine).toBe("jev");
  });
});
