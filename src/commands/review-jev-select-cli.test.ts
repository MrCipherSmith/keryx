// flow 344: `keryx review jev-select`, driven through the real CLI
// dispatcher — fixture diff via `--diff`, a fixed candidate list via
// `--reviewers`, fixture Jev responses via `--fixtures`. Hermetic: no
// network, no real git, macOS-safe (mkdtemp under the OS tmp dir).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { reviewCommand } from "./review";

const ORIGINAL_CWD = process.cwd();
const ORIGINAL_KEY = process.env.OPENROUTER_API_KEY;
const realLog = console.log;
const realError = console.error;

let ROOT = "";
let logs: string[] = [];

function output(): string {
  return logs.join("\n");
}

const CANDIDATES = [
  { id: "review-logic", description: "logic correctness" },
  { id: "review-security-code", description: "security" },
  { id: "review-style", description: "naming/readability" },
];

const DIFF_TEXT = ["diff --git a/src/format.ts b/src/format.ts", "index 1111111..2222222 100644", "--- a/src/format.ts", "+++ b/src/format.ts", "@@ -1,2 +1,2 @@ export function format() {", " const x = 1;", "-return x;", "+return x + 1;"].join("\n");

async function projectRoot(enabled: boolean, extra?: Record<string, unknown>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "keryx-jev-select-cli-"));
  await mkdir(path.join(dir, ".metaproject"), { recursive: true });
  await writeFile(
    path.join(dir, ".metaproject", "tasks.config.json"),
    JSON.stringify({ review: { jev: { select: enabled, ...extra } } }),
    "utf8",
  );
  return dir;
}

async function writeReviewers(root: string): Promise<string> {
  const file = path.join(root, "reviewers.json");
  await writeFile(file, JSON.stringify(CANDIDATES), "utf8");
  return file;
}

async function writeDiff(root: string): Promise<string> {
  const file = path.join(root, "diff.txt");
  await writeFile(file, DIFF_TEXT, "utf8");
  return file;
}

async function writeJevFixtures(root: string, byId: Record<string, number>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "keryx-jev-select-fixtures-"));
  const answers = Object.fromEntries(CANDIDATES.map((c) => [`q:${c.id}`, { type: "noul", noul: byId[c.id] ?? 0.5 }]));
  await writeFile(path.join(dir, "jev-responses.json"), JSON.stringify([{ answers, usage: { input_tokens: 10, output_tokens: 5, cost: 0.0001 } }]), "utf8");
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

describe("keryx review jev-select — fail-open policy", () => {
  test("review.jev.select disabled: every candidate kept, no network call possible (no --fixtures needed)", async () => {
    ROOT = await projectRoot(false);
    const reviewersPath = await writeReviewers(ROOT);
    const diffPath = await writeDiff(ROOT);
    process.chdir(ROOT);

    await reviewCommand(["jev-select", "--diff", diffPath, "--reviewers", reviewersPath, "--json"]);

    const parsed = JSON.parse(output()) as { decisions: Array<{ reviewer: string; decision: string; reason: string }> };
    expect(parsed.decisions).toHaveLength(CANDIDATES.length);
    expect(parsed.decisions.every((d) => d.decision === "keep")).toBe(true);
    expect(parsed.decisions[0]!.reason).toContain("not enabled");
  });

  test("enabled but no credential: every candidate kept, fail-open", async () => {
    ROOT = await projectRoot(true);
    const reviewersPath = await writeReviewers(ROOT);
    const diffPath = await writeDiff(ROOT);
    process.chdir(ROOT);
    delete process.env.OPENROUTER_API_KEY;

    await reviewCommand(["jev-select", "--diff", diffPath, "--reviewers", reviewersPath, "--json"]);

    const parsed = JSON.parse(output()) as { decisions: Array<{ decision: string; reason: string }> };
    expect(parsed.decisions.every((d) => d.decision === "keep")).toBe(true);
    expect(parsed.decisions.some((d) => d.reason.includes("OPENROUTER_API_KEY"))).toBe(true);
  });
});

describe("keryx review jev-select — scored decisions", () => {
  test("skips a low-probability non-mandatory reviewer, keeps the mandatory one even when scored low", async () => {
    ROOT = await projectRoot(true);
    const reviewersPath = await writeReviewers(ROOT);
    const diffPath = await writeDiff(ROOT);
    const fixturesDir = await writeJevFixtures(ROOT, { "review-logic": 0.01, "review-security-code": 0.01, "review-style": 0.02 });
    process.chdir(ROOT);
    process.env.OPENROUTER_API_KEY = "sk-or-test";

    await reviewCommand(["jev-select", "--diff", diffPath, "--reviewers", reviewersPath, "--fixtures", fixturesDir, "--json"]);

    const parsed = JSON.parse(output()) as { decisions: Array<{ reviewer: string; decision: string; reason: string }> };
    const logic = parsed.decisions.find((d) => d.reviewer === "review-logic")!;
    const security = parsed.decisions.find((d) => d.reviewer === "review-security-code")!;
    const style = parsed.decisions.find((d) => d.reviewer === "review-style")!;
    expect(logic.decision).toBe("keep");
    expect(logic.reason).toContain("core safety set");
    expect(security.decision).toBe("keep");
    expect(style.decision).toBe("skip");
  });

  test("keeps a candidate at/above the configured threshold", async () => {
    ROOT = await projectRoot(true, { select_skip_below: 0.5 });
    const reviewersPath = await writeReviewers(ROOT);
    const diffPath = await writeDiff(ROOT);
    const fixturesDir = await writeJevFixtures(ROOT, { "review-style": 0.5 });
    process.chdir(ROOT);
    process.env.OPENROUTER_API_KEY = "sk-or-test";

    await reviewCommand(["jev-select", "--diff", diffPath, "--reviewers", reviewersPath, "--fixtures", fixturesDir, "--json"]);

    const parsed = JSON.parse(output()) as { decisions: Array<{ reviewer: string; decision: string }> };
    expect(parsed.decisions.find((d) => d.reviewer === "review-style")!.decision).toBe("keep");
  });

  test("--out upserts a markdown block into an existing review package file", async () => {
    ROOT = await projectRoot(true);
    const reviewersPath = await writeReviewers(ROOT);
    const diffPath = await writeDiff(ROOT);
    const fixturesDir = await writeJevFixtures(ROOT, { "review-style": 0.01 });
    process.chdir(ROOT);
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    const outPath = path.join(ROOT, "scope.md");
    await writeFile(outPath, "## Other section\n\nkeep me\n", "utf8");

    await reviewCommand(["jev-select", "--diff", diffPath, "--reviewers", reviewersPath, "--fixtures", fixturesDir, "--out", outPath]);

    const written = await readFile(outPath, "utf8");
    expect(written).toContain("## Other section");
    expect(written).toContain("keep me");
    expect(written).toContain("## Jev reviewer selection (advisory)");
    expect(written).toContain("review-style");
  });
});

describe("keryx review jev-select — usage", () => {
  test("refuses both --diff and --ref at once", async () => {
    ROOT = await projectRoot(false);
    process.chdir(ROOT);
    await reviewCommand(["jev-select", "--diff", "-", "--ref", "HEAD~1"]);
    expect(process.exitCode).toBe(1);
    expect(output()).toContain("Usage: keryx review jev-select");
  });

  test("rejects an unknown flag", async () => {
    ROOT = await projectRoot(false);
    process.chdir(ROOT);
    await reviewCommand(["jev-select", "--bogus"]);
    expect(process.exitCode).toBe(1);
    expect(output()).toContain("Unknown option");
  });
});
