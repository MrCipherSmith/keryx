// `keryx review learn --reviewer <id>` (W3, flow 312 T9) — the CLI surface of
// `applyReviewerProfile`, run end to end through `reviewCommand` rather than
// unit-tested against the function alone, on the same rationale
// `review-learn-cli.test.ts` states for the per-skill path: a routing mistake
// (the flag never reaching the reviewer path, or `--pr` silently required
// alongside it) is invisible to a test that calls `applyReviewerProfile`
// directly.
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAcceptCapability } from "../learning/accept-capability";
import { reviewerIdFor } from "../learning/reviewer-id";
import { writePattern } from "../learning/store";
import type { LearnedPattern } from "../learning/types";
import { reviewCommand } from "./review";

const ORIGINAL_CWD = process.cwd();
const realLog = console.log;
const realError = console.error;

const SHA_A = "a".repeat(64);
const LOGIN = "octo-reviewer";
const REVIEWER_ID = reviewerIdFor(SHA_A, LOGIN);

let ROOT = "";
let logs: string[] = [];

function output(): string {
  return logs.join("\n");
}

function makeRecord(overrides: Partial<LearnedPattern> = {}): LearnedPattern {
  return {
    schemaVersion: 1,
    id: "review-conventions.null-check-ab12cd34",
    trigger: `${LOGIN} keeps flagging missing null checks`,
    action: "add a null check before dereferencing the pointer",
    domain: "review-conventions",
    scope: "project",
    project: { identity: SHA_A, identityKind: "remote-hash" },
    confidence: 0.61,
    confidenceLevel: "medium",
    status: "accepted",
    supersededBy: null,
    evidence: [{ kind: "reinforcement", sourceType: "reviewer-comment", sourceRef: "src/a.ts", observedAt: "2026-09-24T00:00:00.000Z", weight: 1 }],
    reviewerProfile: { reviewerId: REVIEWER_ID, generalizedFrom: 1 },
    redaction: { scanned: true, findings: [] },
    graduation: null,
    provenance: { extractor: "reviewer-comment", extractorKind: "deterministic" },
    createdAt: "2026-09-24T00:00:00.000Z",
    updatedAt: "2026-09-24T00:00:00.000Z",
    ...overrides,
  };
}

async function project(): Promise<void> {
  ROOT = await mkdtemp(path.join(tmpdir(), "keryx-review-learn-reviewer-"));
  await mkdir(path.join(ROOT, ".metaproject"), { recursive: true });
  await writeFile(
    path.join(ROOT, ".metaproject", "review-learning.config.json"),
    JSON.stringify({ schemaVersion: 1, skill: "alpha/module", repo: "o/r", authors: [LOGIN], reviewerProfiles: [LOGIN] }, null, 2),
    "utf8",
  );
  process.chdir(ROOT);
  logs = [];
  process.exitCode = 0;
  console.log = (...args: unknown[]) => void logs.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => void logs.push(args.map(String).join(" "));
}

afterEach(async () => {
  console.log = realLog;
  console.error = realError;
  process.chdir(ORIGINAL_CWD);
  process.exitCode = 0;
  if (ROOT) {
    await rm(ROOT, { recursive: true, force: true });
    ROOT = "";
  }
});

test("keryx review learn --reviewer <id> writes the reviewer profile and reports its version", async () => {
  await project();
  await writePattern(ROOT, makeRecord(), { capability: createAcceptCapability() });

  await reviewCommand(["learn", "--reviewer", REVIEWER_ID]);

  expect(process.exitCode).toBe(0);
  expect(output()).toContain(`.metaproject/rules/reviewers/${REVIEWER_ID}.mdc`);
  expect(output()).toContain("Version: 0.1.0");

  const rendered = await readFile(
    path.join(ROOT, ".metaproject", "rules", "reviewers", `${REVIEWER_ID}.mdc`),
    "utf8",
  );
  expect(rendered).toContain("add a null check before dereferencing the pointer");
  expect(rendered.toLowerCase()).not.toContain(LOGIN.toLowerCase());
});

test("--reviewer with --dry-run writes nothing", async () => {
  await project();
  await writePattern(ROOT, makeRecord(), { capability: createAcceptCapability() });

  await reviewCommand(["learn", "--reviewer", REVIEWER_ID, "--dry-run"]);

  expect(process.exitCode).toBe(0);
  expect(output()).toContain("Would write");
  await expect(
    readFile(path.join(ROOT, ".metaproject", "rules", "reviewers", `${REVIEWER_ID}.mdc`), "utf8"),
  ).rejects.toThrow();
});

test("--reviewer with --json prints a machine-readable result", async () => {
  await project();
  await writePattern(ROOT, makeRecord(), { capability: createAcceptCapability() });

  await reviewCommand(["learn", "--reviewer", REVIEWER_ID, "--json"]);

  expect(process.exitCode).toBe(0);
  const parsed = JSON.parse(output()) as { reviewer: string; version: string; added: number };
  expect(parsed.reviewer).toBe(REVIEWER_ID);
  expect(parsed.version).toBe("0.1.0");
  expect(parsed.added).toBe(1);
});

test("an unknown flag on `review learn` is refused rather than ignored", async () => {
  await project();

  await reviewCommand(["learn", "--reviewer", REVIEWER_ID, "--authors", "someone"]);

  expect(process.exitCode).toBe(1);
  expect(output()).toContain("Unknown option");
  expect(output()).toContain("--authors");
});

// The existing `--pr` path is untouched by the new flag's presence in
// LEARN_FLAGS: no `--reviewer` on the command line still takes the original
// route.
test("plain `review learn --pr` without --reviewer is unaffected", async () => {
  await project();
  await reviewCommand(["learn", "--pr", "9"]);
  expect(output()).toContain("No collected comments for o/r#9");
});
