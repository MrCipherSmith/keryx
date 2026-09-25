// flow 332 (AC8): `keryx review jev-scenarios`, driven through the real CLI
// dispatcher — fixture scenario sources on disk, a fixture scope, fixture
// Jev responses, schema validation against `reviewer-finding.schema.json`.
// Hermetic: no network, no real git, macOS-safe (mkdtemp under the OS tmp
// dir).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { reviewCommand } from "./review";
import { validateJson } from "../gdskills/contracts";

type JsonSchema = Parameters<typeof validateJson>[1];

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
  const dir = await mkdtemp(path.join(tmpdir(), "keryx-jev-scenarios-cli-"));
  await mkdir(path.join(dir, ".metaproject"), { recursive: true });
  await writeFile(path.join(dir, ".metaproject", "tasks.config.json"), JSON.stringify({ review: { jev: { scenarios: enabled } } }), "utf8");
  return dir;
}

/** One gdwiki `user-scenario` page linking `src/commands/providers.ts`. */
async function writeWikiScenario(root: string): Promise<void> {
  const dir = path.join(root, ".metaproject", "wiki", "user-scenarios");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "connect-provider.md"),
    ["---", "title: Connect a model provider", "---", "", "# Connect a model provider", "", "A user runs `src/commands/providers.ts` to add one."].join("\n"),
    "utf8",
  );
}

/** A scope naming `src/commands/providers.ts` as the only changed file (no diff hunks needed for scenario matching). */
async function writeScope(root: string): Promise<string> {
  const scopePath = path.join(root, "scope.json");
  await writeFile(
    scopePath,
    JSON.stringify({
      schemaVersion: 1,
      mode: "diff",
      contextLines: 20,
      files: ["src/commands/providers.ts"],
      regions: [],
      drops: [],
      counts: {
        filesSeen: 1,
        filesRetained: 1,
        filesDropped: 0,
        blocksSeen: 0,
        blocksRetained: 0,
        blocksDropped: 0,
        changedLinesRetained: 0,
        changedLinesDropped: 0,
        droppedByReason: { lockfile: 0, generated: 0, vendored: 0, snapshot: 0, minified: 0, binary: 0, "whitespace-only": 0, "comment-only": 0 },
      },
    }),
    "utf8",
  );
  return scopePath;
}

async function writeFixtures(root: string, noul: number): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "keryx-jev-scenarios-fixtures-"));
  await writeFile(
    path.join(dir, "jev-responses.json"),
    JSON.stringify([{ answers: { ".metaproject/wiki/user-scenarios/connect-provider.md": { type: "noul", noul } }, usage: { input_tokens: 50, output_tokens: 5, cost: 0.0005 } }]),
    "utf8",
  );
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

describe("AC8: keryx review jev-scenarios --scope <scope.json> --json", () => {
  test("a touched-link scenario above threshold with no covering test: one finding, schema-valid", async () => {
    ROOT = await projectRoot(true);
    await writeWikiScenario(ROOT);
    const scopePath = await writeScope(ROOT);
    const fixturesDir = await writeFixtures(ROOT, 0.9);
    process.chdir(ROOT);
    process.env.OPENROUTER_API_KEY = "sk-or-test";

    await reviewCommand(["jev-scenarios", "--scope", scopePath, "--fixtures", fixturesDir, "--json"]);

    const parsed = JSON.parse(output()) as {
      status: string;
      reviewer: string;
      findings: Array<Record<string, unknown>>;
      checklist: Array<{ id: string; probability: number }>;
    };
    expect(parsed.reviewer).toBe("review-jev-scenarios");
    expect(parsed.checklist).toHaveLength(1);
    expect(parsed.checklist[0]!.id).toBe(".metaproject/wiki/user-scenarios/connect-provider.md");
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0]!.reviewer).toBe("review-jev-scenarios");
    expect(parsed.findings[0]!.severity).toBe("minor");
    expect(process.exitCode ?? 0).toBe(0);

    const schemaRaw = await readFile(
      path.join(import.meta.dir, "..", "gdskills", "bundled", "skills", "review", "review-orchestrator", "reviewer-finding.schema.json"),
      "utf8",
    );
    const schema = JSON.parse(schemaRaw) as JsonSchema;
    const errors = await validateJson(parsed, schema);
    expect(errors).toEqual([]);
  });

  test("below threshold: no finding, no checklist entry", async () => {
    ROOT = await projectRoot(true);
    await writeWikiScenario(ROOT);
    const scopePath = await writeScope(ROOT);
    const fixturesDir = await writeFixtures(ROOT, 0.1);
    process.chdir(ROOT);
    process.env.OPENROUTER_API_KEY = "sk-or-test";

    await reviewCommand(["jev-scenarios", "--scope", scopePath, "--fixtures", fixturesDir, "--json"]);
    const parsed = JSON.parse(output()) as { findings: unknown[]; checklist: unknown[]; status: string; tokens: { jevCalls: number } };
    expect(parsed.findings).toEqual([]);
    expect(parsed.checklist).toEqual([]);
    expect(parsed.status).toBe("DONE");
    expect(parsed.tokens.jevCalls).toBe(1);
  });

  test("no scenario sources discovered: zero findings, zero Jev calls, not an error", async () => {
    ROOT = await projectRoot(true);
    const scopePath = await writeScope(ROOT);
    process.chdir(ROOT);
    process.env.OPENROUTER_API_KEY = "sk-or-test";

    await reviewCommand(["jev-scenarios", "--scope", scopePath, "--json"]);
    const parsed = JSON.parse(output()) as { findings: unknown[]; scenarioSources: unknown[]; tokens: { jevCalls: number } };
    expect(parsed.findings).toEqual([]);
    expect(parsed.scenarioSources).toEqual([]);
    expect(parsed.tokens.jevCalls).toBe(0);
    expect(process.exitCode ?? 0).toBe(0);
  });
});

describe("AC5: opt-in and credential gating — both refuse before any read", () => {
  test("review.jev.scenarios absent/false: refused, the scope file is never even opened", async () => {
    ROOT = await projectRoot(false);
    process.chdir(ROOT);
    process.env.OPENROUTER_API_KEY = "sk-or-test";

    await reviewCommand(["jev-scenarios", "--scope", path.join(ROOT, "does-not-exist.json"), "--json"]);

    expect(output().toLowerCase()).toContain("review.jev.scenarios");
    expect(output().toLowerCase()).toContain("not enabled");
    expect(process.exitCode).toBe(1);
  });

  test("enabled but no OPENROUTER_API_KEY (and no saved key): refused, no network call possible", async () => {
    ROOT = await projectRoot(true);
    process.chdir(ROOT);
    delete process.env.OPENROUTER_API_KEY;

    await reviewCommand(["jev-scenarios", "--scope", path.join(ROOT, "does-not-exist.json"), "--json"]);

    expect(output()).toContain("OPENROUTER_API_KEY");
    expect(process.exitCode).toBe(1);
  });
});

describe("usage: exactly one of --diff/--pr/--scope is required", () => {
  test("none given is refused", async () => {
    ROOT = await projectRoot(true);
    process.chdir(ROOT);
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    await reviewCommand(["jev-scenarios", "--json"]);
    expect(output()).toContain("Usage: keryx review jev-scenarios");
  });

  test("two given is refused", async () => {
    ROOT = await projectRoot(true);
    process.chdir(ROOT);
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    await reviewCommand(["jev-scenarios", "--diff", "HEAD", "--pr", "1", "--json"]);
    expect(output()).toContain("Usage: keryx review jev-scenarios");
  });
});

describe("keryx review reviewers --json lists review-jev-scenarios with engine: jev", () => {
  test("once its SKILL.md is installed under .metaproject", async () => {
    ROOT = await projectRoot(true);
    const dir = path.join(ROOT, ".metaproject", "skills", "gdskills", "review", "review-jev-scenarios");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "SKILL.md"), '---\nname: review-jev-scenarios\nmetadata:\n  engine: "jev"\n---\n', "utf8");
    process.chdir(ROOT);

    await reviewCommand(["reviewers", "--json"]);
    const parsed = JSON.parse(output()) as { bundled: Array<{ name: string; engine?: string }> };
    const entry = parsed.bundled.find((r) => r.name === "review-jev-scenarios");
    expect(entry?.engine).toBe("jev");
  });
});
