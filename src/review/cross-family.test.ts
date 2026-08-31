// `cross_family_review`, flow 209 AC2 — the field that shipped with no reader,
// in the commit whose own AC3 forbade exactly that.
//
// Every test here drives the REAL CLI in BOTH directions: `reviewCommand(["ingest",
// ...])` writes a package to a real temp directory, and `reviewCommand(["status",
// ...])` — a separate call that shares no state with it — reads the record back
// off disk. That separation is the whole test. `attempts.count` was written and
// read inside one process and stayed green for a release; a same-process
// assertion here would prove nothing that mattered.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { reviewCommand } from "../commands/review";
import { providersCommand } from "../commands/providers";
import { checkCrossFamilyReview, parseCrossFamilyReviewInput } from "./cross-family";
import type { ManagedReviewManifest } from "./types";
import type { CrossFamilyReviewDecision } from "../lib/provider-config";

const ORIGINAL_CWD = process.cwd();
let ROOT = "";
let logs: string[] = [];
let errors: string[] = [];
const realLog = console.log;
const realError = console.error;

beforeEach(async () => {
  ROOT = await mkdtemp(path.join(tmpdir(), "gd-cross-family-"));
  await mkdir(path.join(ROOT, ".metaproject"), { recursive: true });
  // The committed schema, so the block is validated by the real contract. A
  // manifest property `additionalProperties: false` rejects would make every
  // ingest throw, and this is where that is noticed rather than in production.
  await mkdir(path.join(ROOT, "docs", "requirements", "managed-review-feedback-loop", "schemas"), {
    recursive: true,
  });
  await writeFile(
    path.join(ROOT, "docs", "requirements", "managed-review-feedback-loop", "schemas", "managed-review-package.schema.json"),
    await readFile(
      path.join(ORIGINAL_CWD, "docs", "requirements", "managed-review-feedback-loop", "schemas", "managed-review-package.schema.json"),
      "utf8",
    ),
    "utf8",
  );
  logs = [];
  errors = [];
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  process.exitCode = 0;
});

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

/** A granted cross-family decision, shaped exactly as the producer emits one. */
const GRANTED: CrossFamilyReviewDecision = {
  schemaVersion: 1,
  mode: "cross-family",
  requested: true,
  author_family: "anthropic",
  reviewer_family: "openai",
  reviewer_provider: "openai",
  reviewer_model: null,
  reason:
    'cross-family review was requested and granted: the change was authored on anthropic and will be reviewed on openai via provider "openai"',
  candidates: [{ provider: "openai", model: null, family: "openai" }],
};

async function writeReport(): Promise<string> {
  const report = path.join(ROOT, "report.md");
  await writeFile(report, "# Round\n\n- [F-001] minor: a name that does not say what it holds\n", "utf8");
  return report;
}

/** Run `keryx review ingest`, optionally handing it a decision file. */
async function ingest(reviewId: string, decision?: unknown): Promise<string> {
  const args = [
    "ingest",
    "--review-id",
    reviewId,
    "--target",
    "report",
    "--ref",
    await writeReport(),
    "--report",
    await writeReport(),
  ];
  if (decision !== undefined) {
    const file = path.join(ROOT, `${reviewId}-cross-family.json`);
    await writeFile(file, `${JSON.stringify(decision, null, 2)}\n`, "utf8");
    args.push("--cross-family-review", file);
  }
  await reviewCommand(args);
  return path.join(ROOT, ".metaproject", "reviews", reviewId, "manifest.json");
}

// ---------------------------------------------------------------------------
// The producer: the block reaches the durable record
// ---------------------------------------------------------------------------

test("AC2: `review ingest --cross-family-review` writes the block into manifest.json", async () => {
  process.chdir(ROOT);

  // The wrapper form, exactly as `keryx providers cross-family --json` prints it.
  const manifestPath = await ingest("2026-08-31-cf-written", { cross_family_review: GRANTED });

  // Off disk, not off a return value: the point is that the RECORD carries it.
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ManagedReviewManifest;
  expect(manifest.cross_family_review).toEqual(GRANTED);
  expect(process.exitCode).toBe(0);
});

test("AC2: an ingest given no decision records NOTHING, and says so rather than saying single-family", async () => {
  process.chdir(ROOT);

  const manifestPath = await ingest("2026-08-31-cf-absent");

  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ManagedReviewManifest;
  // Absent, not `null`, and not a fabricated `single-family`. The two are
  // different facts and only the absence is honest about which one this is.
  expect("cross_family_review" in manifest).toBe(false);
  expect(logs.join("\n")).toContain("cross_family_review: not recorded");
  expect(logs.join("\n")).toContain("this is NOT `single-family`");
});

test("AC2: an unreadable decision file is refused, never defaulted to single-family", async () => {
  process.chdir(ROOT);
  const file = path.join(ROOT, "broken.json");
  await writeFile(file, '{"cross_family_review": {"mode": "cross-family"}}', "utf8");

  await reviewCommand([
    "ingest",
    "--review-id",
    "2026-08-31-cf-refused",
    "--target",
    "report",
    "--ref",
    await writeReport(),
    "--report",
    await writeReport(),
    "--cross-family-review",
    file,
  ]);

  expect(process.exitCode).toBe(1);
  expect(errors.join("\n")).toContain("is not a usable cross_family_review block");
});

// ---------------------------------------------------------------------------
// The consumer: a LATER invocation reads it back, and can refuse
// ---------------------------------------------------------------------------

test("AC2: `keryx review status` reads the block back off disk in a separate invocation", async () => {
  process.chdir(ROOT);
  await ingest("2026-08-31-cf-readback", { cross_family_review: GRANTED });
  logs = [];

  await reviewCommand(["status", "2026-08-31-cf-readback"]);

  const printed = logs.join("\n");
  expect(printed).toContain("cross_family_review: mode=cross-family");
  expect(printed).toContain("author_family=anthropic");
  expect(printed).toContain("reviewer=openai via openai");
  expect(process.exitCode).toBe(0);
});

test("AC2: `review status` REFUSES a cross-family record that names no reviewer", async () => {
  // The refusal is what makes this a consumer rather than a printer. A record
  // claiming a cross-family review while naming nobody cannot be grouped later,
  // which is the only thing the block exists to make possible.
  process.chdir(ROOT);
  const manifestPath = await ingest("2026-08-31-cf-noreviewer", { cross_family_review: GRANTED });
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ManagedReviewManifest;
  (manifest.cross_family_review as { reviewer_family: string | null }).reviewer_family = null;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  errors = [];

  await reviewCommand(["status", "2026-08-31-cf-noreviewer"]);

  expect(process.exitCode).toBe(1);
  expect(errors.join("\n")).toContain("reviewer family or provider is null");
});

test("AC2: `review status` REFUSES a reviewer that was never among the candidates", async () => {
  process.chdir(ROOT);
  const manifestPath = await ingest("2026-08-31-cf-uncandidate", { cross_family_review: GRANTED });
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ManagedReviewManifest;
  (manifest.cross_family_review as unknown as { candidates: unknown[] }).candidates = [
    { provider: "mistral", model: null, family: "mistral" },
  ];
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  errors = [];

  await reviewCommand(["status", "2026-08-31-cf-uncandidate"]);

  expect(process.exitCode).toBe(1);
  expect(errors.join("\n")).toContain("is not among the 1 candidate(s)");
});

test("AC2: a package carrying no block reports the absence and exits 0", async () => {
  // An absence in an old package is a fact about old packages, not a
  // contradiction inside a new one. Failing on it would make the check
  // impossible to adopt, which is how a checker gets removed.
  process.chdir(ROOT);
  await ingest("2026-08-31-cf-legacy");
  logs = [];
  errors = [];

  await reviewCommand(["status", "2026-08-31-cf-legacy"]);

  expect(process.exitCode).toBe(0);
  expect(logs.join("\n")).toContain("cross_family_review: not recorded");
});

// ---------------------------------------------------------------------------
// The two ends meet: what the producer prints is what the consumer accepts
// ---------------------------------------------------------------------------

test("AC2: the block `keryx providers cross-family --json` prints is accepted verbatim", async () => {
  // The seam, driven end to end. If the emitted shape and the accepted shape
  // ever diverge, the field is unreadable again and this is where that shows —
  // rather than in a hand-written fixture that agrees with itself.
  logs = [];
  providersCommand(["cross-family", "--json"]);
  const emitted: unknown = JSON.parse(logs.join("\n"));

  const parsed = parseCrossFamilyReviewInput(emitted, "keryx providers cross-family --json");

  expect(checkCrossFamilyReview(parsed)).toEqual([]);
  // Without `--opt-in` the answer is always single-family, with a reason. The
  // reason is the field that makes the record auditable, so its presence is
  // asserted rather than assumed.
  expect(parsed.mode).toBe("single-family");
  expect(parsed.reason.length).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// The checker, in both directions
// ---------------------------------------------------------------------------

test("AC2: a single-family record naming a reviewer is a contradiction", () => {
  const problems = checkCrossFamilyReview({
    ...GRANTED,
    mode: "single-family",
  });

  expect(problems.map((problem) => problem.code)).toEqual(["contradiction"]);
});

test("AC2: a granted review of the authoring family is a contradiction", () => {
  const problems = checkCrossFamilyReview({ ...GRANTED, author_family: "openai" });

  expect(problems.map((problem) => problem.code)).toEqual(["contradiction"]);
});

test("AC2: an absent record is `not-recorded` and never fails a command", () => {
  expect(checkCrossFamilyReview(undefined).map((problem) => problem.code)).toEqual(["not-recorded"]);
  expect(checkCrossFamilyReview(null).map((problem) => problem.code)).toEqual(["not-recorded"]);
});

test("AC2: a decision the producer really emits passes the checker", () => {
  expect(checkCrossFamilyReview(GRANTED)).toEqual([]);
  expect(
    checkCrossFamilyReview({
      schemaVersion: 1,
      mode: "single-family",
      requested: false,
      author_family: "anthropic",
      reviewer_family: null,
      reviewer_provider: null,
      reviewer_model: null,
      reason: "cross-family review was not requested; it is opt-in",
      candidates: [],
    }),
  ).toEqual([]);
});
