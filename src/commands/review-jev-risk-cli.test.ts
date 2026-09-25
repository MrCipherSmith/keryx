// flow 332 (AC8): `keryx review jev-risk`, driven through the real CLI
// dispatcher — fixture diff via `--scope`, fixture Jev responses, schema
// validation against `reviewer-finding.schema.json`. Hermetic: no network (a
// fixtures dir stands in for Jev), no real git (scope mode reads a
// hand-written scope.json), macOS-safe (mkdtemp under the OS tmp dir).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { reviewCommand } from "./review";
import { validateJson } from "../gdskills/contracts";

type JsonSchema = Parameters<typeof validateJson>[1];
import { RISK_DIMENSIONS } from "../review/jev-risk";

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
  const dir = await mkdtemp(path.join(tmpdir(), "keryx-jev-risk-cli-"));
  await mkdir(path.join(dir, ".metaproject"), { recursive: true });
  await writeFile(path.join(dir, ".metaproject", "tasks.config.json"), JSON.stringify({ review: { jev: { risk: enabled } } }), "utf8");
  return dir;
}

/** One region, `src/auth/session.ts:1-3`, exporting `login` — a public-API + auth-shaped hunk on purpose. */
async function writeScope(root: string): Promise<string> {
  const scopePath = path.join(root, "scope.json");
  await writeFile(
    scopePath,
    JSON.stringify({
      schemaVersion: 1,
      mode: "diff",
      contextLines: 20,
      files: ["src/auth/session.ts"],
      regions: [{ path: "src/auth/session.ts", startLine: 1, endLine: 3, changedLines: 1, contextTruncated: false, text: "+export function login() {}" }],
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

async function writeFixtures(root: string, noulByDimension: Record<string, number>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "keryx-jev-risk-fixtures-"));
  const answers = Object.fromEntries(RISK_DIMENSIONS.map((d) => [d, { type: "noul", noul: noulByDimension[d] ?? 0.1 }]));
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

describe("AC8: keryx review jev-risk --scope <scope.json> --json", () => {
  test("above threshold, no nearby test: one finding, schema-valid, plus a security routing hint", async () => {
    ROOT = await projectRoot(true);
    const scopePath = await writeScope(ROOT);
    const fixturesDir = await writeFixtures(ROOT, { security: 0.95 });
    process.chdir(ROOT);
    process.env.OPENROUTER_API_KEY = "sk-or-test";

    await reviewCommand(["jev-risk", "--scope", scopePath, "--fixtures", fixturesDir, "--json"]);

    const parsed = JSON.parse(output()) as {
      status: string;
      reviewer: string;
      findings: Array<Record<string, unknown>>;
      stats: Record<string, number>;
      routingHints: Array<{ dimension: string; suggestedReviewer: string }>;
      ranked: Array<{ file: string; combinedRisk: number }>;
    };
    expect(parsed.reviewer).toBe("review-jev-risk");
    expect(parsed.findings).toHaveLength(1);
    const finding = parsed.findings[0]!;
    expect(finding.file).toBe("src/auth/session.ts");
    expect(finding.reviewer).toBe("review-jev-risk");
    expect(["info", "minor"]).toContain(finding.severity as string);
    expect(parsed.routingHints.some((h) => h.dimension === "security" && h.suggestedReviewer === "review-security-code")).toBe(true);
    expect(parsed.ranked[0]!.file).toBe("src/auth/session.ts");
    expect(process.exitCode ?? 0).toBe(0);

    const schemaRaw = await readFile(
      path.join(import.meta.dir, "..", "gdskills", "bundled", "skills", "review", "review-orchestrator", "reviewer-finding.schema.json"),
      "utf8",
    );
    const schema = JSON.parse(schemaRaw) as JsonSchema;
    const errors = await validateJson(parsed, schema);
    expect(errors).toEqual([]);
  });

  test("below threshold: no finding, no routing hint, but usage/selection are still reported", async () => {
    ROOT = await projectRoot(true);
    const scopePath = await writeScope(ROOT);
    const fixturesDir = await writeFixtures(ROOT, { security: 0.2 });
    process.chdir(ROOT);
    process.env.OPENROUTER_API_KEY = "sk-or-test";

    await reviewCommand(["jev-risk", "--scope", scopePath, "--fixtures", fixturesDir, "--json"]);
    const parsed = JSON.parse(output()) as { findings: unknown[]; routingHints: unknown[]; status: string; tokens: { jevCalls: number } };
    expect(parsed.findings).toEqual([]);
    expect(parsed.routingHints).toEqual([]);
    expect(parsed.status).toBe("DONE");
    expect(parsed.tokens.jevCalls).toBe(1);
  });

  test("a docs (.md) hunk is never scored and never consumes --max-calls budget, reported as notCode", async () => {
    ROOT = await projectRoot(true);
    const scopePath = path.join(ROOT, "scope.json");
    await writeFile(
      scopePath,
      JSON.stringify({
        schemaVersion: 1,
        mode: "diff",
        contextLines: 20,
        files: ["src/auth/session.ts", "docs/docs/cli-reference.md"],
        regions: [
          { path: "src/auth/session.ts", startLine: 1, endLine: 3, changedLines: 1, contextTruncated: false, text: "+export function login() {}" },
          { path: "docs/docs/cli-reference.md", startLine: 1, endLine: 3, changedLines: 1, contextTruncated: false, text: "+### `--login`\n+Documents the new public API flag." },
        ],
        drops: [],
        counts: {
          filesSeen: 2,
          filesRetained: 2,
          filesDropped: 0,
          blocksSeen: 2,
          blocksRetained: 2,
          blocksDropped: 0,
          changedLinesRetained: 2,
          changedLinesDropped: 0,
          droppedByReason: { lockfile: 0, generated: 0, vendored: 0, snapshot: 0, minified: 0, binary: 0, "whitespace-only": 0, "comment-only": 0 },
        },
      }),
      "utf8",
    );
    // Only one fixture response — if the docs hunk were scored too, this would
    // throw "a call beyond that was made" (see `fixtureJevFetch`'s own guard).
    const fixturesDir = await writeFixtures(ROOT, { security: 0.95 });
    process.chdir(ROOT);
    process.env.OPENROUTER_API_KEY = "sk-or-test";

    await reviewCommand(["jev-risk", "--scope", scopePath, "--fixtures", fixturesDir, "--json"]);

    const parsed = JSON.parse(output()) as {
      findings: Array<{ file: string }>;
      selection: { hunksScored: number; hunksNotCode: number };
      tokens: { jevCalls: number };
      ranked: Array<{ file: string }>;
    };
    expect(parsed.selection.hunksNotCode).toBe(1);
    expect(parsed.selection.hunksScored).toBe(1);
    expect(parsed.tokens.jevCalls).toBe(1);
    expect(parsed.ranked.map((r) => r.file)).toEqual(["src/auth/session.ts"]);
    expect(parsed.findings.every((f) => f.file !== "docs/docs/cli-reference.md")).toBe(true);
  });

  test("--max-calls caps the hunks scored, reported rather than silently truncated", async () => {
    ROOT = await projectRoot(true);
    const scopePath = await writeScope(ROOT);
    const fixturesDir = await writeFixtures(ROOT, { security: 0.6 });
    process.chdir(ROOT);
    process.env.OPENROUTER_API_KEY = "sk-or-test";

    await reviewCommand(["jev-risk", "--scope", scopePath, "--fixtures", fixturesDir, "--max-calls", "0", "--json"]);
    const parsed = JSON.parse(output()) as { selection: { maxCalls: number; hunksScored: number; hunksSkipped: number } };
    expect(parsed.selection.maxCalls).toBe(0);
    expect(parsed.selection.hunksScored).toBe(0);
    expect(parsed.selection.hunksSkipped).toBe(1);
  });
});

describe("AC1/AC2 (tightened): hasNearbyTest requires evidence, not just directory/stem proximity", () => {
  test("regression (live-check false negative, providers.ts:723-733): a proximate test changed for an unrelated reason does not suppress the finding", async () => {
    ROOT = await projectRoot(true);
    const scopePath = path.join(ROOT, "scope.json");
    await writeFile(
      scopePath,
      JSON.stringify({
        schemaVersion: 1,
        mode: "diff",
        contextLines: 20,
        files: ["src/commands/providers.ts", "src/commands/providers.test.ts"],
        regions: [
          { path: "src/commands/providers.ts", startLine: 723, endLine: 733, changedLines: 5, contextTruncated: false, text: "+export function boundedJsonBody() {}" },
          { path: "src/commands/providers.test.ts", startLine: 10, endLine: 12, changedLines: 2, contextTruncated: false, text: '+test("something unrelated", () => {\n+  expect(1).toBe(1);\n+});' },
        ],
        drops: [],
        counts: {
          filesSeen: 2,
          filesRetained: 2,
          filesDropped: 0,
          blocksSeen: 2,
          blocksRetained: 2,
          blocksDropped: 0,
          changedLinesRetained: 7,
          changedLinesDropped: 0,
          droppedByReason: { lockfile: 0, generated: 0, vendored: 0, snapshot: 0, minified: 0, binary: 0, "whitespace-only": 0, "comment-only": 0 },
        },
      }),
      "utf8",
    );
    // Two hunks are retained (providers.ts AND its own test file), so both get
    // scored — one fixture response per hunk, in region order.
    const fixturesDir = await mkdtemp(path.join(tmpdir(), "keryx-jev-risk-fixtures-"));
    const highAnswers = Object.fromEntries(RISK_DIMENSIONS.map((d) => [d, { type: "noul", noul: d === "public-api" ? 0.89 : 0.1 }]));
    const lowAnswers = Object.fromEntries(RISK_DIMENSIONS.map((d) => [d, { type: "noul", noul: 0.1 }]));
    await writeFile(
      path.join(fixturesDir, "jev-responses.json"),
      JSON.stringify([
        { answers: highAnswers, usage: { input_tokens: 100, output_tokens: 5, cost: 0.001 } },
        { answers: lowAnswers, usage: { input_tokens: 100, output_tokens: 5, cost: 0.001 } },
      ]),
      "utf8",
    );
    process.chdir(ROOT);
    process.env.OPENROUTER_API_KEY = "sk-or-test";

    await reviewCommand(["jev-risk", "--scope", scopePath, "--fixtures", fixturesDir, "--threshold", "0.7", "--json"]);

    const parsed = JSON.parse(output()) as { findings: Array<{ file: string }> };
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0]!.file).toBe("src/commands/providers.ts");
  });
});

describe("AC5: opt-in and credential gating — both refuse before any read", () => {
  test("review.jev.risk absent/false: refused, the scope file is never even opened", async () => {
    ROOT = await projectRoot(false);
    process.chdir(ROOT);
    process.env.OPENROUTER_API_KEY = "sk-or-test";

    await reviewCommand(["jev-risk", "--scope", path.join(ROOT, "does-not-exist.json"), "--json"]);

    expect(output().toLowerCase()).toContain("review.jev.risk");
    expect(output().toLowerCase()).toContain("not enabled");
    expect(process.exitCode).toBe(1);
  });

  test("enabled but no OPENROUTER_API_KEY (and no saved key): refused, no network call possible", async () => {
    ROOT = await projectRoot(true);
    process.chdir(ROOT);
    delete process.env.OPENROUTER_API_KEY;

    await reviewCommand(["jev-risk", "--scope", path.join(ROOT, "does-not-exist.json"), "--json"]);

    expect(output()).toContain("OPENROUTER_API_KEY");
    expect(process.exitCode).toBe(1);
  });
});

describe("usage: exactly one of --diff/--pr/--scope is required", () => {
  test("none given is refused", async () => {
    ROOT = await projectRoot(true);
    process.chdir(ROOT);
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    await reviewCommand(["jev-risk", "--json"]);
    expect(output()).toContain("Usage: keryx review jev-risk");
  });

  test("two given is refused", async () => {
    ROOT = await projectRoot(true);
    process.chdir(ROOT);
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    await reviewCommand(["jev-risk", "--diff", "HEAD", "--pr", "1", "--json"]);
    expect(output()).toContain("Usage: keryx review jev-risk");
  });
});

describe("keryx review reviewers --json lists review-jev-risk with engine: jev", () => {
  test("once its SKILL.md is installed under .metaproject", async () => {
    ROOT = await projectRoot(true);
    const dir = path.join(ROOT, ".metaproject", "skills", "gdskills", "review", "review-jev-risk");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "SKILL.md"), '---\nname: review-jev-risk\nmetadata:\n  engine: "jev"\n---\n', "utf8");
    process.chdir(ROOT);

    await reviewCommand(["reviewers", "--json"]);
    const parsed = JSON.parse(output()) as { bundled: Array<{ name: string; engine?: string }> };
    const entry = parsed.bundled.find((r) => r.name === "review-jev-risk");
    expect(entry?.engine).toBe("jev");
  });
});
