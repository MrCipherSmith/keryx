// flow 333 — `keryx review jev-docs`, driven through the real CLI dispatcher
// (AC8: CLI tests with fixture diff + fixture docs + recorded Jev responses;
// schema validation against reviewer-finding.schema.json). Hermetic: no
// network (a fixtures dir stands in for Jev and for `gh pr diff`/`gh pr
// view`), macOS-safe (mkdtemp under the OS tmp dir).

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
  const dir = await mkdtemp(path.join(tmpdir(), "keryx-jev-docs-cli-"));
  await mkdir(path.join(dir, ".metaproject"), { recursive: true });
  await writeFile(path.join(dir, ".metaproject", "tasks.config.json"), JSON.stringify({ review: { jev: { docs: enabled } } }), "utf8");
  return dir;
}

/** `docs/widget.md`: a `## Widget` section (line 3) that names `src/widget.ts` — the diff below changes that file. */
async function writeDocs(root: string): Promise<void> {
  await mkdir(path.join(root, "docs"), { recursive: true });
  await writeFile(path.join(root, "docs", "widget.md"), ["# Title", "", "## Widget", "", "See `src/widget.ts` for details."].join("\n"), "utf8");
}

const WIDGET_DIFF = [
  "diff --git a/src/widget.ts b/src/widget.ts",
  "index 1111111..2222222 100644",
  "--- a/src/widget.ts",
  "+++ b/src/widget.ts",
  "@@ -1,3 +1,3 @@",
  " context line",
  "-export function oldWidget() {}",
  "+export function widget() {}",
  " context line",
  "",
].join("\n");

async function writeFixtures(root: string, answers: Record<string, { type: "noul"; noul: number }>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "keryx-jev-docs-fixtures-"));
  await writeFile(path.join(dir, "pr.json"), JSON.stringify({ number: 7, title: "Widget PR", body: "", diff: WIDGET_DIFF }), "utf8");
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

describe("AC8: keryx review jev-docs --pr <n> --json", () => {
  test("emits one finding, above threshold, schema-valid against reviewer-finding.schema.json", async () => {
    ROOT = await projectRoot(true);
    await writeDocs(ROOT);
    const fixturesDir = await writeFixtures(ROOT, { "docs/widget.md::3": { type: "noul", noul: 0.9 } });
    process.chdir(ROOT);
    process.env.OPENROUTER_API_KEY = "sk-or-test";

    await reviewCommand(["jev-docs", "--pr", "7", "--fixtures", fixturesDir, "--json"]);

    const parsed = JSON.parse(output()) as { reviewer: string; findings: Array<Record<string, unknown>>; stats: Record<string, number> };
    expect(parsed.reviewer).toBe("review-jev-docs");
    expect(parsed.findings).toHaveLength(1);
    const finding = parsed.findings[0]!;
    expect(finding.file).toBe("docs/widget.md");
    expect(finding.line).toBe(3);
    expect(finding.severity).toBe("minor");
    expect(finding.reviewer).toBe("review-jev-docs");
    expect(process.exitCode ?? 0).toBe(0);

    const schemaRaw = await readFile(
      path.join(import.meta.dir, "..", "gdskills", "bundled", "skills", "review", "review-orchestrator", "reviewer-finding.schema.json"),
      "utf8",
    );
    const schema = JSON.parse(schemaRaw) as JsonSchema;
    const errors = await validateJson(parsed, schema);
    expect(errors).toEqual([]);
  });

  test("below threshold: no Jev finding", async () => {
    ROOT = await projectRoot(true);
    await writeDocs(ROOT);
    const fixturesDir = await writeFixtures(ROOT, { "docs/widget.md::3": { type: "noul", noul: 0.1 } });
    process.chdir(ROOT);
    process.env.OPENROUTER_API_KEY = "sk-or-test";

    await reviewCommand(["jev-docs", "--pr", "7", "--fixtures", fixturesDir, "--json"]);
    const parsed = JSON.parse(output()) as { findings: unknown[]; status: string; tokens: { jevCalls: number } };
    expect(parsed.findings).toEqual([]);
    expect(parsed.status).toBe("DONE");
    expect(parsed.tokens.jevCalls).toBe(1);
  });

  test("no doc files discovered: zero findings, not an error", async () => {
    ROOT = await projectRoot(true);
    const fixturesDir = await writeFixtures(ROOT, {});
    process.chdir(ROOT);
    process.env.OPENROUTER_API_KEY = "sk-or-test";

    await reviewCommand(["jev-docs", "--pr", "7", "--fixtures", fixturesDir, "--json"]);
    const parsed = JSON.parse(output()) as { findings: unknown[]; selection: { linkedSections: number } };
    expect(parsed.findings).toEqual([]);
    expect(parsed.selection.linkedSections).toBe(0);
    expect(process.exitCode ?? 0).toBe(0);
  });

  test("a removed CLI flag still mentioned in an untouched doc is flagged deterministically, with no Jev call needed for it", async () => {
    ROOT = await projectRoot(true);
    await mkdir(path.join(ROOT, "docs"), { recursive: true });
    await writeFile(path.join(ROOT, "docs", "cli.md"), ["# CLI", "", "## Usage", "", "Run with `--old-flag` to enable it."].join("\n"), "utf8");
    const flagDiff = [
      "diff --git a/src/commands/review.ts b/src/commands/review.ts",
      "index 1111111..2222222 100644",
      "--- a/src/commands/review.ts",
      "+++ b/src/commands/review.ts",
      "@@ -1,3 +1,3 @@",
      " context line",
      '-  optionValue(args, "--old-flag");',
      '+  optionValue(args, "--new-flag");',
      " context line",
      "",
    ].join("\n");
    const fixturesDir = await mkdtemp(path.join(tmpdir(), "keryx-jev-docs-fixtures-"));
    await writeFile(path.join(fixturesDir, "pr.json"), JSON.stringify({ number: 8, title: "Flag rename", body: "", diff: flagDiff }), "utf8");
    await writeFile(path.join(fixturesDir, "jev-responses.json"), JSON.stringify([]), "utf8");
    process.chdir(ROOT);
    process.env.OPENROUTER_API_KEY = "sk-or-test";

    await reviewCommand(["jev-docs", "--pr", "8", "--fixtures", fixturesDir, "--json"]);
    const parsed = JSON.parse(output()) as { findings: Array<Record<string, unknown>>; tokens: { jevCalls: number } };
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0]!.evidence).toContain("Deterministic");
    // No linked section this run (the flag mention is not a path/symbol/verb
    // link), so no Jev batch was ever built — the deterministic check truly
    // cost zero Jev calls.
    expect(parsed.tokens.jevCalls).toBe(0);
  });
});

describe("AC5: opt-in and credential gating — both refuse before any read", () => {
  test("review.jev.docs absent/false: refused, docs are never even read", async () => {
    ROOT = await projectRoot(false);
    await writeDocs(ROOT);
    process.chdir(ROOT);
    process.env.OPENROUTER_API_KEY = "sk-or-test";

    await reviewCommand(["jev-docs", "--pr", "7", "--json"]);

    expect(output().toLowerCase()).toContain("review.jev.docs");
    expect(output().toLowerCase()).toContain("not enabled");
    expect(process.exitCode).toBe(1);
  });

  test("enabled but no OPENROUTER_API_KEY: refused, no network call possible", async () => {
    ROOT = await projectRoot(true);
    process.chdir(ROOT);
    delete process.env.OPENROUTER_API_KEY;

    await reviewCommand(["jev-docs", "--pr", "7", "--json"]);

    expect(output()).toContain("OPENROUTER_API_KEY");
    expect(process.exitCode).toBe(1);
  });
});

describe("usage: exactly one of --diff/--pr is required", () => {
  test("none given is refused", async () => {
    ROOT = await projectRoot(true);
    process.chdir(ROOT);
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    await reviewCommand(["jev-docs", "--json"]);
    expect(output()).toContain("Usage: keryx review jev-docs");
  });

  test("two given is refused", async () => {
    ROOT = await projectRoot(true);
    process.chdir(ROOT);
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    await reviewCommand(["jev-docs", "--diff", "HEAD", "--pr", "1", "--json"]);
    expect(output()).toContain("Usage: keryx review jev-docs");
  });
});

describe("flow 333 T4 (live-check fix): default doc corpus is user-facing only; --include widens it back", () => {
  /** A minimal doc file whose `## Section` (line 3) names `src/widget.ts` — the diff every test in this block changes. */
  function widgetSection(): string {
    return ["# Title", "", "## Section", "", "See `src/widget.ts` for details."].join("\n");
  }

  async function writeCorpus(root: string): Promise<void> {
    await mkdir(path.join(root, "docs"), { recursive: true });
    await writeFile(path.join(root, "docs", "widget.md"), widgetSection(), "utf8");
    await writeFile(path.join(root, "README.md"), widgetSection(), "utf8");
    // Never discovered, default or --include: CHANGELOG is explicitly excluded.
    await writeFile(path.join(root, "CHANGELOG.md"), widgetSection(), "utf8");
    await mkdir(path.join(root, ".metaproject", "wiki"), { recursive: true });
    await writeFile(path.join(root, ".metaproject", "wiki", "index.md"), widgetSection(), "utf8");
    // Excluded by DEFAULT (the live-check regression: these used to fill the
    // whole --max-calls budget alphabetically ahead of docs/**), reachable
    // only via --include.
    await mkdir(path.join(root, ".metaproject", "skills", "gdskills", "review", "foo"), { recursive: true });
    await writeFile(path.join(root, ".metaproject", "skills", "gdskills", "review", "foo", "SKILL.md"), widgetSection(), "utf8");
    await mkdir(path.join(root, ".metaproject", "rules"), { recursive: true });
    await writeFile(path.join(root, ".metaproject", "rules", "foo.mdc"), widgetSection(), "utf8");
  }

  test("default run links only docs/**, README*, and gdwiki — never CHANGELOG, skills, or rules", async () => {
    ROOT = await projectRoot(true);
    await writeCorpus(ROOT);
    const answers = {
      "docs/widget.md::3": { type: "noul" as const, noul: 0.9 },
      "README.md::3": { type: "noul" as const, noul: 0.9 },
      ".metaproject/wiki/index.md::3": { type: "noul" as const, noul: 0.9 },
    };
    const fixturesDir = await writeFixtures(ROOT, answers);
    process.chdir(ROOT);
    process.env.OPENROUTER_API_KEY = "sk-or-test";

    await reviewCommand(["jev-docs", "--pr", "7", "--fixtures", fixturesDir, "--json"]);
    const parsed = JSON.parse(output()) as { findings: Array<{ file: string }>; selection: { linkedSections: number; rankingBasis: string } };

    expect(parsed.selection.linkedSections).toBe(3);
    const files = parsed.findings.map((f) => f.file).sort();
    expect(files).toEqual([".metaproject/wiki/index.md", "README.md", "docs/widget.md"]);
    expect(files.some((f) => f.includes("CHANGELOG"))).toBe(false);
    expect(files.some((f) => f.includes(".metaproject/skills"))).toBe(false);
    expect(files.some((f) => f.includes(".metaproject/rules"))).toBe(false);
    expect(parsed.selection.rankingBasis).toContain("link strength");
  });

  test("--include (repeatable) widens the corpus back to skills and rules", async () => {
    ROOT = await projectRoot(true);
    await writeCorpus(ROOT);
    const answers = {
      "docs/widget.md::3": { type: "noul" as const, noul: 0.9 },
      "README.md::3": { type: "noul" as const, noul: 0.9 },
      ".metaproject/wiki/index.md::3": { type: "noul" as const, noul: 0.9 },
      ".metaproject/skills/gdskills/review/foo/SKILL.md::3": { type: "noul" as const, noul: 0.9 },
      ".metaproject/rules/foo.mdc::3": { type: "noul" as const, noul: 0.9 },
    };
    const fixturesDir = await writeFixtures(ROOT, answers);
    process.chdir(ROOT);
    process.env.OPENROUTER_API_KEY = "sk-or-test";

    await reviewCommand([
      "jev-docs",
      "--pr",
      "7",
      "--fixtures",
      fixturesDir,
      "--include",
      ".metaproject/skills/**",
      "--include",
      ".metaproject/rules/**",
      "--json",
    ]);
    const parsed = JSON.parse(output()) as { findings: Array<{ file: string }>; selection: { linkedSections: number } };

    expect(parsed.selection.linkedSections).toBe(5);
    const files = parsed.findings.map((f) => f.file).sort();
    expect(files).toContain(".metaproject/skills/gdskills/review/foo/SKILL.md");
    expect(files).toContain(".metaproject/rules/foo.mdc");
    expect(files.some((f) => f.includes("CHANGELOG"))).toBe(false); // --include never resurrects the CHANGELOG exclusion
  });
});

describe("keryx review reviewers --json lists review-jev-docs with engine: jev", () => {
  test("once its SKILL.md is installed under .metaproject", async () => {
    ROOT = await projectRoot(true);
    const dir = path.join(ROOT, ".metaproject", "skills", "gdskills", "review", "review-jev-docs");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "SKILL.md"), '---\nname: review-jev-docs\nmetadata:\n  engine: "jev"\n---\n', "utf8");
    process.chdir(ROOT);

    await reviewCommand(["reviewers", "--json"]);
    const parsed = JSON.parse(output()) as { bundled: Array<{ name: string; engine?: string }> };
    const entry = parsed.bundled.find((r) => r.name === "review-jev-docs");
    expect(entry?.engine).toBe("jev");
  });
});
