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

/** One rule doc at `.metaproject/rules/test-rule.mdc` — discovered automatically, no `--rules` needed. Two clauses: a rationale bullet (used as `impact` for the other) and the actual checkable clause. */
async function writeTestRule(root: string): Promise<void> {
  await mkdir(path.join(root, ".metaproject", "rules"), { recursive: true });
  await writeFile(
    path.join(root, ".metaproject", "rules", "test-rule.mdc"),
    ["# Test Rule", "", "## Rationale", "", "- Keeps the test deterministic and easy to reason about.", "", "## Clauses", "", "- Every widget must be documented.", ""].join(
      "\n",
    ),
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
      ".metaproject/rules/test-rule.mdc::rationale-1": { type: "noul", noul: 0.1 },
      ".metaproject/rules/test-rule.mdc::clauses-1": { type: "noul", noul: 0.95 },
    });
    process.chdir(ROOT);
    process.env.OPENROUTER_API_KEY = "sk-or-test";

    await reviewCommand(["jev-rules", "--scope", scopePath, "--fixtures", fixturesDir, "--json"]);

    const parsed = JSON.parse(output()) as {
      status: string;
      reviewer: string;
      findings: Array<Record<string, unknown>>;
      stats: Record<string, number>;
    };
    expect(parsed.reviewer).toBe("review-jev-rules");
    expect(parsed.findings).toHaveLength(1);
    const finding = parsed.findings[0]!;
    expect(finding.file).toBe("src/widget.ts");
    expect(finding.problem).toContain("clauses-1");
    expect(finding.impact).toBe("Keeps the test deterministic and easy to reason about.");
    expect(finding.reviewer).toBe("review-jev-rules");
    expect(process.exitCode ?? 0).toBe(0);

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
      ".metaproject/rules/test-rule.mdc::rationale-1": { type: "noul", noul: 0.1 },
      ".metaproject/rules/test-rule.mdc::clauses-1": { type: "noul", noul: 0.2 },
    });
    process.chdir(ROOT);
    process.env.OPENROUTER_API_KEY = "sk-or-test";

    await reviewCommand(["jev-rules", "--scope", scopePath, "--fixtures", fixturesDir, "--json"]);
    const parsed = JSON.parse(output()) as { findings: unknown[]; status: string; tokens: { jevCalls: number } };
    expect(parsed.findings).toEqual([]);
    expect(parsed.status).toBe("DONE");
    expect(parsed.tokens.jevCalls).toBe(1);
  });

  test("--max-calls caps the pairs selected, reported rather than silently truncated", async () => {
    ROOT = await projectRoot(true);
    await writeTestRule(ROOT);
    const scopePath = await writeScope(ROOT);
    const fixturesDir = await writeFixtures(ROOT, { ".metaproject/rules/test-rule.mdc::rationale-1": { type: "noul", noul: 0.6 } });
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
