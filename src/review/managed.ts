import { mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { validateAgainstSchemaObject } from "../contracts/validator";
import { loadSchema, validateJson } from "../gdskills/contracts";
import { pathExists, writeFileAtomic } from "../lib/fs";
import { flowsRoot, listFlowDirs, readFlow, resolveFlowDir, slugify } from "../flow/store";
import type { FlowState } from "../flow/types";
import {
  FINDING_CLASSIFICATIONS,
  MANAGED_REVIEW_MODES,
  REVIEW_COVERAGE_STATUSES,
  REVIEW_FINDING_CONFIDENCES,
  REVIEW_PACKAGE_STATUSES,
  REVIEW_TARGET_KINDS,
  type FlowMatchResult,
  type ManagedReviewInput,
  type ManagedReviewManifest,
  type ManagedReviewMode,
  type ManagedReviewPackageResult,
  type ManagedReviewValidationResult,
  type NormalizedReviewFinding,
  type ReviewCoverageEntry,
  type ReviewFindingClassScope,
  type ReviewFindingConfidence,
  type ReviewFindingsSource,
  type ReviewerResultLike,
  type StructuredReviewFinding,
} from "./types";

const REQUIRED_ARTIFACTS = ["scope", "coverage", "report", "findings", "learning", "decisions"] as const;

export function reviewsRoot(cwd: string): string {
  return path.join(cwd, ".metaproject", "reviews");
}

export async function findRelatedFlow(input: {
  cwd: string;
  flowId?: string | undefined;
  target: { kind: string; ref: string };
}): Promise<FlowMatchResult | null> {
  if (input.flowId) {
    const dir = await resolveFlowDir(input.cwd, input.flowId);
    const flow = await readFlow(input.cwd, dir);
    return { id: flow.id, dir, reason: "explicit-flow-id" };
  }

  const dirs = await listFlowDirs(input.cwd);
  for (const dir of dirs) {
    const flow = await readFlow(input.cwd, dir);
    if (matchesTarget(flow, dir, input.target.kind, input.target.ref)) {
      return { id: flow.id, dir, reason: matchReason(flow, dir, input.target.kind, input.target.ref) };
    }
  }

  return null;
}

export async function createManagedReviewPackage(
  input: ManagedReviewInput,
): Promise<ManagedReviewPackageResult> {
  const at = (input.now ?? new Date()).toISOString();
  const reviewId = input.reviewId ?? defaultReviewId(input.mode, input.target.kind, input.target.ref, at);
  const flowMatch = await resolvePackageFlow(input);
  const packageDir = packagePath(input.cwd, input.mode, reviewId, flowMatch);
  const coverage = normalizeCoverage(input.coverage, input.reviewers);
  const report = await readReport(input);
  const findings = await normalizeFindings({
    report,
    mode: input.mode,
    attachedToFlow: flowMatch !== null,
    source: input.findings,
    reviewers: coverage.filter((entry) => entry.status === "run").map((entry) => entry.reviewer),
  });
  const manifest = buildManifest({
    input,
    reviewId,
    packageDir,
    flowMatch,
    coverage,
    at,
  });

  const validation = await validateManagedReviewManifest(input.cwd, manifest);
  if (!validation.valid) {
    throw new Error(`Invalid managed review manifest: ${validation.errors.map((item) => `${item.path} ${item.message}`).join("; ")}`);
  }

  const violations = classScopeViolations(findings);
  if (violations.length > 0) {
    // Before the package is written, so a refused ingest leaves nothing behind
    // that a later round could mistake for a recorded review.
    throw new Error(
      `Refusing to record findings that do not enumerate their class: ${violations
        .map((finding) => `${finding.id} (${finding.severity})`)
        .join(", ")}. A blocker or major must carry class_scope with sites and enumeration_method — every site holding the shape, and how the set was derived.`,
    );
  }

  await mkdir(packageDir, { recursive: true });
  await writeFileAtomic(path.join(packageDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFileAtomic(path.join(packageDir, "scope.md"), renderScope(input, flowMatch, at));
  await writeFileAtomic(path.join(packageDir, "coverage.md"), renderCoverage(coverage));
  await writeFileAtomic(path.join(packageDir, "report.md"), renderReport(report, input.mode));
  await writeFileAtomic(
    path.join(packageDir, "findings.json"),
    `${JSON.stringify(findings.map(toContractFinding), null, 2)}\n`,
  );
  await writeFileAtomic(path.join(packageDir, "learning.md"), renderLearning(findings));
  await writeFileAtomic(path.join(packageDir, "decisions.md"), renderDecisions(findings));

  return {
    reviewId,
    path: path.relative(input.cwd, packageDir),
    manifest,
  };
}

export async function getManagedReviewStatus(cwd: string, ref: string): Promise<ManagedReviewManifest> {
  const manifestPath = ref.endsWith("manifest.json")
    ? path.resolve(cwd, ref)
    : path.join(await resolveReviewPackagePath(cwd, ref), "manifest.json");
  return JSON.parse(await readFile(manifestPath, "utf8")) as ManagedReviewManifest;
}

export async function completeManagedReview(cwd: string, ref: string): Promise<ManagedReviewManifest> {
  const packageDir = await resolveReviewPackagePath(cwd, ref);
  const manifestPath = path.join(packageDir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ManagedReviewManifest;
  const missing = await missingArtifacts(packageDir);
  if (missing.length > 0) {
    throw new Error(`Cannot complete managed review; missing artifacts: ${missing.join(", ")}`);
  }
  const updated: ManagedReviewManifest = {
    ...manifest,
    status: "closed",
    updatedAt: new Date().toISOString(),
  };
  const validation = await validateManagedReviewManifest(cwd, updated);
  if (!validation.valid) {
    throw new Error(`Invalid managed review manifest: ${validation.errors.map((item) => `${item.path} ${item.message}`).join("; ")}`);
  }
  await writeFileAtomic(manifestPath, `${JSON.stringify(updated, null, 2)}\n`);
  return updated;
}

export async function validateManagedReviewManifest(
  cwd: string,
  manifest: ManagedReviewManifest,
): Promise<ManagedReviewValidationResult> {
  const errors: ManagedReviewValidationResult["errors"] = [];

  // The committed JSON Schema is the source of truth. When it is present we run
  // the deterministic in-repo validator (src/contracts/validator) against it so
  // the schema file — not the hand-rolled checks below — governs the required
  // fields, enums, and additionalProperties rules. The hand-rolled checks are
  // kept as a floor: they still run so behavior does not regress if the schema
  // file is absent, and they catch cases the schema does not model (e.g. empty
  // artifact paths). Errors from both layers are merged and de-duplicated.
  const schema = await loadDocpackSchema(cwd);
  if (schema) {
    for (const error of validateAgainstSchemaObject(schema, manifest).errors) {
      errors.push(error);
    }
  }

  if (manifest.schemaVersion !== 1) {
    errors.push({ path: "$.schemaVersion", message: "Expected 1" });
  }
  if (!manifest.reviewId) {
    errors.push({ path: "$.reviewId", message: "Missing review id" });
  }
  if (!MANAGED_REVIEW_MODES.includes(manifest.mode)) {
    errors.push({ path: "$.mode", message: `Expected one of ${MANAGED_REVIEW_MODES.join(", ")}` });
  }
  if (!REVIEW_PACKAGE_STATUSES.includes(manifest.status)) {
    errors.push({ path: "$.status", message: `Expected one of ${REVIEW_PACKAGE_STATUSES.join(", ")}` });
  }
  if (!REVIEW_TARGET_KINDS.includes(manifest.target.kind)) {
    errors.push({ path: "$.target.kind", message: `Expected one of ${REVIEW_TARGET_KINDS.join(", ")}` });
  }
  if (!manifest.target.ref) {
    errors.push({ path: "$.target.ref", message: "Missing target ref" });
  }
  for (const artifact of REQUIRED_ARTIFACTS) {
    if (!manifest.artifacts[artifact]) {
      errors.push({ path: `$.artifacts.${artifact}`, message: "Missing artifact path" });
    }
  }
  for (const [index, entry] of manifest.coverage.entries()) {
    if (!entry.reviewer) {
      errors.push({ path: `$.coverage[${index}].reviewer`, message: "Missing reviewer" });
    }
    if (!REVIEW_COVERAGE_STATUSES.includes(entry.status)) {
      errors.push({ path: `$.coverage[${index}].status`, message: `Expected one of ${REVIEW_COVERAGE_STATUSES.join(", ")}` });
    }
    if (entry.reason === undefined) {
      errors.push({ path: `$.coverage[${index}].reason`, message: "Missing reason" });
    }
  }

  const seen = new Set<string>();
  const deduped = errors.filter((error) => {
    const key = `${error.path}${error.message}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
  return { valid: deduped.length === 0, errors: deduped };
}

async function resolvePackageFlow(input: ManagedReviewInput): Promise<FlowMatchResult | null> {
  if (input.mode === "review-flow") {
    return null;
  }
  return findRelatedFlow({ cwd: input.cwd, flowId: input.flowId, target: input.target });
}

function packagePath(
  cwd: string,
  mode: ManagedReviewMode,
  reviewId: string,
  flowMatch: FlowMatchResult | null,
): string {
  if ((mode === "attach-review" || mode === "ingest") && flowMatch) {
    return path.join(flowsRoot(cwd), flowMatch.dir, "reviews", reviewId);
  }
  if (mode === "attach-review") {
    throw new Error("attach-review requires an explicit or matched flow");
  }
  return path.join(reviewsRoot(cwd), reviewId);
}

function buildManifest(args: {
  input: ManagedReviewInput;
  reviewId: string;
  packageDir: string;
  flowMatch: FlowMatchResult | null;
  coverage: ReviewCoverageEntry[];
  at: string;
}): ManagedReviewManifest {
  const artifactPath = (name: string) => path.relative(args.input.cwd, path.join(args.packageDir, name));
  const manifest: ManagedReviewManifest = {
    schemaVersion: 1,
    reviewId: args.reviewId,
    mode: args.input.mode,
    status: "draft",
    target: args.input.target,
    artifacts: {
      scope: artifactPath("scope.md"),
      coverage: artifactPath("coverage.md"),
      report: artifactPath("report.md"),
      findings: artifactPath("findings.json"),
      learning: artifactPath("learning.md"),
      decisions: artifactPath("decisions.md"),
    },
    coverage: args.coverage,
    createdAt: args.at,
    updatedAt: args.at,
  };
  if (args.flowMatch) {
    manifest.flow = {
      id: args.flowMatch.id,
      path: `.metaproject/flows/${args.flowMatch.dir}`,
    };
  }
  return manifest;
}

function normalizeCoverage(
  coverage: ReviewCoverageEntry[] | undefined,
  reviewers: string[] | undefined,
): ReviewCoverageEntry[] {
  if (coverage && coverage.length > 0) {
    return coverage;
  }
  const selected = reviewers && reviewers.length > 0 ? reviewers : ["review-orchestrator"];
  return selected.map((reviewer) => ({
    reviewer,
    status: "run",
    reason: "selected for managed review package",
  }));
}

async function readReport(input: ManagedReviewInput): Promise<string> {
  if (input.reportText !== undefined) {
    return input.reportText;
  }
  if (input.reportPath) {
    return readFile(path.resolve(input.cwd, input.reportPath), "utf8");
  }
  if (input.mode === "ingest") {
    throw new Error("ingest requires --report or reportText");
  }
  return `# Managed Review Report\n\nNo reviewer findings recorded yet.\n`;
}

type NormalizeFindingsArgs = {
  report: string;
  mode: ManagedReviewMode;
  attachedToFlow: boolean;
  source: ReviewFindingsSource | undefined;
  reviewers: string[];
};

/**
 * The findings of one review round, in order of decreasing fidelity.
 *
 * 1. `input.findings` — what the caller still holds.
 * 2. A `keryx:findings` block inside the report — the same array, travelling in
 *    the one artifact the CLI already moves.
 * 3. The markdown parser — legacy only.
 *
 * The ordering is the whole design and is worth stating rather than inferring.
 * A reviewer produces `reviewer-finding.schema.json`: id, severity, problem,
 * impact, suggested_fix, evidence, confidence, reviewer, class_scope. The
 * orchestrator then renders that to prose, and prose is where four of those
 * fields stop existing — not "become hard to parse", stop existing: read the
 * consolidated report in `fixtures/`, which carries no confidence anywhere and
 * no evidence field under any label. Re-parsing therefore cannot be made
 * lossless by a better regex, which is why the structured array is taken from
 * the producer and the parser is demoted to reading what is already on disk.
 */
async function normalizeFindings(args: NormalizeFindingsArgs): Promise<NormalizedReviewFinding[]> {
  const structured = args.source ?? parseEmbeddedFindings(args.report);
  if (structured !== null && structured !== undefined) {
    return triage(await fromStructuredSource(structured, args.reviewers), args);
  }
  return triage(parseLegacyReport(args.report, args.reviewers), args);
}

function triage(
  findings: Array<StructuredReviewFinding & { summary: string; class_scope_present?: boolean | undefined }>,
  args: NormalizeFindingsArgs,
): NormalizedReviewFinding[] {
  const classification = args.mode === "ingest" ? "valid_followup" : "skill_learning_candidate";
  return findings.map((finding) => {
    const triaged: NormalizedReviewFinding = {
      ...finding,
      classification,
      flow_relevance: args.attachedToFlow ? "post_flow_feedback" : "standalone_review",
    };
    // `learning_candidate` is the one triage judgement the finding contract has
    // a slot for, so it is the one that survives into `findings.json`. Set only
    // when true: the schema defaults it to false, and writing the default onto
    // every finding says nothing while implying a decision was recorded.
    if (finding.learning_candidate === undefined && classification === "skill_learning_candidate") {
      triaged.learning_candidate = true;
    }
    return triaged;
  });
}

/** The persisted record: exactly the properties `review-finding.schema.json` allows. */
function toContractFinding(finding: StructuredReviewFinding): StructuredReviewFinding {
  const record: StructuredReviewFinding = {
    id: finding.id,
    reviewer: finding.reviewer,
    severity: finding.severity,
    problem: finding.problem,
    impact: finding.impact,
    suggested_fix: finding.suggested_fix,
    evidence: finding.evidence,
    confidence: finding.confidence,
  };
  if (finding.file !== undefined) {
    record.file = finding.file;
  }
  if (finding.line !== undefined) {
    record.line = finding.line;
  }
  if (finding.symbol !== undefined) {
    record.symbol = finding.symbol;
  }
  if (finding.dedupe_key !== undefined) {
    record.dedupe_key = finding.dedupe_key;
  }
  if (finding.blocking_merge !== undefined) {
    record.blocking_merge = finding.blocking_merge;
  }
  if (finding.related_skill !== undefined) {
    record.related_skill = finding.related_skill;
  }
  if (finding.learning_candidate !== undefined) {
    record.learning_candidate = finding.learning_candidate;
  }
  if (finding.class_scope !== undefined) {
    record.class_scope = finding.class_scope;
  }
  return record;
}

// ---------------------------------------------------------------------------
// Structured source
// ---------------------------------------------------------------------------

/**
 * The `keryx:findings` block: the structured array carried inside the report.
 *
 * The report is the artifact the pipeline already moves — `keryx review ingest
 * --report <path>` takes one file and nothing else — so a fenced block inside it
 * needs no new flag, no new convention for where a sidecar lives, and no way for
 * the two halves to be separated in transit. A legacy report simply has no such
 * block, which is what makes the fallback automatic rather than a mode switch
 * someone has to remember to set.
 */
const EMBEDDED_FINDINGS_BLOCK = /^```[^\n]*\bkeryx:findings\b[^\n]*\n([\s\S]*?)\n^```\s*$/m;

function parseEmbeddedFindings(report: string): ReviewFindingsSource | null {
  const match = report.match(EMBEDDED_FINDINGS_BLOCK);
  if (!match?.[1]) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]) as unknown;
  } catch (error) {
    throw new Error(
      `The report carries a keryx:findings block that is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return parsed as ReviewFindingsSource;
}

/**
 * Flatten whatever the producer handed over into one array of findings.
 *
 * Both the normalized array and the reviewer's own `{ reviewer, findings }`
 * result are accepted, because an orchestrator holding five reviewer payloads
 * should be able to pass the five rather than merge them by hand — and because
 * the wrapper is where the ORIGINATING reviewer is recorded. That name was
 * hardcoded to `review-orchestrator` for every finding this pipeline ever wrote,
 * which made every record claim the consolidator found it.
 */
async function fromStructuredSource(
  source: ReviewFindingsSource,
  reviewers: string[],
): Promise<Array<StructuredReviewFinding & { summary: string; class_scope_present?: boolean }>> {
  const flattened: Array<Partial<StructuredReviewFinding>> = [];
  for (const entry of Array.isArray(source) ? source : [source]) {
    if (isReviewerResult(entry)) {
      for (const finding of entry.findings) {
        if (finding.reviewer || entry.reviewer === undefined) {
          flattened.push(finding);
          continue;
        }
        flattened.push({ ...finding, reviewer: entry.reviewer });
      }
      continue;
    }
    flattened.push(entry as Partial<StructuredReviewFinding>);
  }

  const findings = flattened.map((finding) => coerceStructured(finding, reviewers));
  const errors = await schemaErrors(findings);
  if (errors.length > 0) {
    // Fail closed, and before anything is written: a structured payload is a
    // claim that the fields exist, so an incomplete one is a bug in the producer
    // and not something to paper over with the placeholders the legacy path
    // uses. Recording it would put a finding into `prior_findings` that the next
    // round's dispatch then rejects — the failure this whole change removes,
    // reintroduced one layer down.
    throw new Error(
      `Refusing to record structured findings that do not satisfy review-finding.schema.json: ${errors
        .map((error) => `${error.path} ${error.message}`)
        .join("; ")}`,
    );
  }
  return findings;
}

function isReviewerResult(value: unknown): value is ReviewerResultLike {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Array.isArray((value as { findings?: unknown }).findings)
  );
}

async function schemaErrors(
  findings: readonly StructuredReviewFinding[],
): Promise<Array<{ path: string; message: string }>> {
  const schema = await loadSchema("review-finding");
  const errors: Array<{ path: string; message: string }> = [];
  for (const [index, finding] of findings.entries()) {
    // The PROJECTION is what gets written and what a later round reads, so it is
    // what the contract has to accept. Validating the in-memory object instead
    // would fail on the triage fields this function's whole purpose is to keep
    // out of the record.
    for (const error of await validateJson(toContractFinding(finding), schema)) {
      errors.push({ path: error.path.replace(/^\$/, `$[${index}]`), message: error.message });
    }
  }
  return errors;
}

/**
 * Carry a structured finding across, filling in NOTHING that the contract
 * requires.
 *
 * The one supplied value is `reviewer`, and only because the reviewer's own
 * result records it on the wrapper rather than on each finding. Everything else
 * is passed through as given, so an absent `impact` stays absent and
 * {@link schemaErrors} refuses the payload. Defaulting a required field here
 * would produce a record that validates and says nothing — which is how
 * `findings.json` came to be full of `review-orchestrator`.
 */
function coerceStructured(
  finding: Partial<StructuredReviewFinding>,
  reviewers: string[],
): StructuredReviewFinding & { summary: string; class_scope_present?: boolean } {
  const record = { ...finding } as StructuredReviewFinding & {
    summary: string;
    class_scope_present?: boolean;
  };
  if (typeof record.reviewer !== "string" || record.reviewer === "") {
    record.reviewer = defaultReviewer(reviewers);
  }
  record.summary = typeof finding.problem === "string" ? finding.problem : "";
  record.class_scope_present = finding.class_scope !== undefined;
  return record;
}

/**
 * Which reviewer a finding belongs to when the producer did not say.
 *
 * A single running reviewer is an unambiguous answer. Several is not, and
 * naming one of them would be a fabrication of exactly the kind the hardcoded
 * `review-orchestrator` was — so the consolidator is named, honestly, as the
 * only thing known to have handled it.
 */
function defaultReviewer(reviewers: string[]): string {
  return reviewers.length === 1 && reviewers[0] ? reviewers[0] : "review-orchestrator";
}

// ---------------------------------------------------------------------------
// Legacy markdown source
// ---------------------------------------------------------------------------

/**
 * Read a pre-existing markdown review report.
 *
 * Kept, not deleted: every review package already on disk is a markdown report,
 * and a pipeline that can only read what it wrote after today strands them all.
 *
 * What it produces is written in the structured shape, so a legacy round is
 * still round-trippable — but the four fields markdown does not carry are filled
 * with a stated provenance rather than an invention. A reader of
 * `findings.json` can tell a recorded `impact` from an absent one, which is the
 * property that matters: `confidence` in particular is `low` on this path
 * because a regex over prose is a low-confidence derivation, whatever the
 * reviewer's own confidence was.
 */
function parseLegacyReport(
  report: string,
  reviewers: string[],
): Array<StructuredReviewFinding & { summary: string; class_scope_present: boolean }> {
  const findings: Array<StructuredReviewFinding & { summary: string; class_scope_present: boolean }> = [];
  const lines = report.split("\n");
  for (const [index, line] of lines.entries()) {
    const heading = findingHeading(line);
    if (heading === null) {
      continue;
    }
    const id = heading.id;
    const summary = heading.summary || "Review finding";
    // The block is everything up to the next finding, because severity and
    // class_scope live on lines BELOW the heading in every report format the
    // reviewer skills emit. Reading only the heading line, as this did, made
    // severity depend on whether the word happened to appear in the title.
    const block = findingBlock(lines, index);
    const location = parseLocation(labelledField(block, ["file", "location"]));
    const finding: StructuredReviewFinding & { summary: string; class_scope_present: boolean } = {
      id,
      severity: severityFor(line, block),
      reviewer: legacyReviewer(block, reviewers),
      // `- [F-001] major: the summary` puts the severity in the title, so the
      // heading text is not the problem statement until that prefix comes off.
      problem: labelledField(block, ["problem", "issue"]) ?? summary.replace(SEVERITY_PREFIX, ""),
      impact: labelledField(block, ["impact", "why it matters"]) ?? NOT_RECORDED("impact"),
      suggested_fix:
        labelledField(block, ["suggested fix", "suggested_fix", "fix", "recommendation"]) ??
        NOT_RECORDED("suggested_fix"),
      evidence:
        labelledField(block, ["evidence", "proof", "found by", "found independently by"]) ??
        NOT_RECORDED("evidence"),
      confidence: legacyConfidence(block),
      summary,
      class_scope_present: hasClassScope(block),
    };
    const classScope = parseClassScope(block);
    if (classScope !== null) {
      finding.class_scope = classScope;
    }
    if (location.file !== undefined) {
      finding.file = location.file;
    }
    if (location.line !== undefined) {
      finding.line = location.line;
    }
    findings.push(finding);
  }
  return findings;
}

const SEVERITY_PREFIX = /^\s*(?:\*\*|__)?(?:blocker|major|minor|info)(?:\*\*|__)?\s*[:—–-]\s*/i;

const NOT_RECORDED = (field: string): string =>
  `not recorded: derived from a markdown review report, which carried no ${field} field`;

/** `- **Label**: value`, continued onto following lines until a blank or a new label. */
function labelledField(block: string, labels: readonly string[]): string | undefined {
  const lines = block.split("\n");
  for (const [index, line] of lines.entries()) {
    const match = line.match(LABEL_LINE);
    const label = match?.[1]?.trim().toLowerCase().replace(/\*\*|__|`/g, "");
    if (label === undefined || !labels.includes(label)) {
      continue;
    }
    const parts = [(match?.[2] ?? "").trim()];
    for (let i = index + 1; i < lines.length; i += 1) {
      const next = lines[i] ?? "";
      if (next.trim() === "" || /^\s*[-*+]\s/.test(next) || /^\s*(?:\*\*|__)/.test(next)) {
        break;
      }
      parts.push(next.trim());
    }
    const value = parts.join(" ").trim().replace(/^[`*_]+|[`*_]+$/g, "").trim();
    if (value !== "") {
      return value;
    }
  }
  return undefined;
}

/** The label half and the value half of a `- **Label**: value` line. */
const LABEL_LINE = /^[\s>]*(?:[-*+]\s+)?((?:\*\*|__)?[A-Za-z][A-Za-z _-]*(?:\*\*|__)?)\s*[:=]\s*(.*)$/;

/** `src/lib/serve-server.ts:739` — with or without backticks, with or without a line. */
function parseLocation(value: string | undefined): { file?: string; line?: number } {
  if (value === undefined) {
    return {};
  }
  const match = value.replace(/`/g, "").trim().match(/^([^\s:]+?\.[A-Za-z0-9]+)(?::(\d+))?\b/);
  if (!match?.[1]) {
    return {};
  }
  const line = match[2] === undefined ? undefined : Number(match[2]);
  return line === undefined || Number.isNaN(line) ? { file: match[1] } : { file: match[1], line };
}

/**
 * The originating reviewer, read out of the report rather than assumed.
 *
 * Consolidated reports name it — `**Found independently by**: review-logic
 * (blocker), review-architecture (major)` — and the first name in that list is
 * the one that found it. When the report says nothing, {@link defaultReviewer}
 * answers, which is the same honest fallback the structured path uses.
 */
function legacyReviewer(block: string, reviewers: string[]): string {
  const attribution = labelledField(block, ["reviewer", "found by", "found independently by", "reviewers"]);
  const named = attribution?.match(/\breview-[a-z0-9-]+\b/i);
  if (named?.[0]) {
    return named[0].toLowerCase();
  }
  return defaultReviewer(reviewers);
}

function legacyConfidence(block: string): ReviewFindingConfidence {
  const declared = labelledField(block, ["confidence"])?.toLowerCase();
  if (declared !== undefined) {
    for (const value of REVIEW_FINDING_CONFIDENCES) {
      if (declared.startsWith(value)) {
        return value;
      }
    }
  }
  // Not "medium". A field recovered by keyword-scanning prose is a low-confidence
  // derivation whatever the reviewer believed, and saying otherwise would let a
  // fix round treat a guess as the reviewer's own judgement.
  return "low";
}

/**
 * `sites` and `enumeration_method`, pulled out of a markdown class_scope block.
 *
 * Best effort, and deliberately NOT the guard: {@link classScopeViolations}
 * stays on {@link hasClassScope}, the shape check, so a report is refused for
 * exactly the reasons it was refused before this change. Extraction failing
 * where the shape check passes costs a `class_scope` in the persisted record and
 * nothing else.
 */
function parseClassScope(block: string): ReviewFindingClassScope | null {
  const lines = block.split("\n");
  const start = lines.findIndex((line) => /class[_ ]scope/i.test(line));
  if (start === -1) {
    return null;
  }
  const rest = lines.slice(start).join("\n");
  const sitesMatch = rest.match(/\bsites\b\s*[:=]\s*([\s\S]*?)(?=\benumeration_method\b|$)/i);
  const methodMatch = rest.match(/\benumeration_method\b\s*[:=]\s*([\s\S]*?)(?=\n\s*\n|$)/i);
  const sites = sitesMatch?.[1] === undefined ? [] : parseSites(sitesMatch[1]);
  const method = unquote(methodMatch?.[1]?.replace(/\s+/g, " ").trim() ?? "");
  if (sites.length === 0 || method === "") {
    return null;
  }
  return { sites, enumeration_method: method };
}

function unquote(value: string): string {
  const trimmed = value.trim().replace(/[.;,]$/, "").trim();
  return /^(["'`])[\s\S]*\1$/.test(trimmed) ? trimmed.slice(1, -1).trim() : trimmed;
}

function parseSites(raw: string): string[] {
  const text = raw.replace(/\s+/g, " ").trim().replace(/[;,]\s*$/, "");
  if (text === "") {
    return [];
  }
  if (text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text.slice(0, text.lastIndexOf("]") + 1)) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.map((item) => String(item)).filter((item) => item !== "");
      }
    } catch {
      // Not JSON after all; fall through to the separator forms below.
    }
  }
  const separator = text.includes(";") ? ";" : ",";
  return text
    .split(separator)
    .map((item) => item.replace(/^[-*+\s`"]+|[\s`",]+$/g, "").trim())
    .filter((item) => item !== "");
}

/** A markdown heading or list marker — the two markers a finding heading carries. */
const HEADING_MARKER = /^(?:#{1,6}|[-*+])\s+/;
/** `F-001`, optionally bracketed, at the start of what is left of the line. */
const FINDING_IDENTIFIER = /^(\[)?\s*(F-\d{3,})\b\s*(\])?/i;
/** What separates an identifier from its title: a colon or a dash of any length. */
const TITLE_SEPARATOR = /^\s*[:—–-]+\s*/;
/** What follows an identifier that is being REFERRED to inside a sentence. */
const REFERENCE_PUNCTUATION = /^[,.;)\]]/;

/**
 * A line that OPENS a finding, as opposed to one that mentions an id in prose.
 *
 * Position alone cannot tell the two apart, and trying was the defect this
 * replaces. Requiring the id to lead the line stopped counting mid-sentence
 * cross-references, but ordinary text wrapping routinely puts a reference at
 * line start: ingesting one real report produced eight phantom findings from a
 * single prose section, and rewriting that section reproduced them a second
 * time from the paragraph describing the defect.
 *
 * So a heading is identified POSITIVELY. It is one of the three shapes the
 * reviewer skills emit:
 *
 *   `### F-001 — the summary`      marker + separator
 *   `### [F-001] the summary`      marker + bracketed id
 *   `- [F-001] major: the summary` marker + bracketed id
 *
 * and the same two shapes without a marker.
 *
 * So the marker is stripped but decides nothing; what decides is that the id is
 * either BRACKETED or followed by a TITLE SEPARATOR. Everything else is a
 * reference: an id followed by `,`, `.`, `;` or `)` whatever precedes it, and a
 * bare `F-001 and F-002 belong to #220`, which is a sentence that happens to
 * start with an id.
 *
 * The cost of this direction is stated rather than hidden: a heading written as
 * a bare `F-001 the summary`, with neither bracket nor separator, is read as
 * prose and its finding is not recorded. No producer in this repository emits
 * that shape, and the alternative — accepting it — is what produced the
 * phantoms. A phantom `major` makes the class-scope guard refuse a report over
 * a finding that does not exist.
 */
function findingHeading(line: string): { id: string; summary: string } | null {
  const marked = line.replace(/^\s+/, "");
  const marker = marked.match(HEADING_MARKER);
  const afterMarker = marker === null ? marked : marked.slice(marker[0].length);

  const identifier = afterMarker.match(FINDING_IDENTIFIER);
  if (identifier === null || identifier[2] === undefined) {
    return null;
  }
  // An unbalanced bracket is prose: `F-001]` closes something this line did not
  // open, and `[F-001` never became a label.
  const bracketed = identifier[1] !== undefined;
  if (bracketed !== (identifier[3] !== undefined)) {
    return null;
  }

  const rest = afterMarker.slice(identifier[0].length);
  if (REFERENCE_PUNCTUATION.test(rest)) {
    return null;
  }

  const id = identifier[2].toUpperCase();
  const separator = rest.match(TITLE_SEPARATOR);
  if (separator !== null) {
    return { id, summary: rest.slice(separator[0].length).trim() };
  }
  // No separator, so the bracket has to carry the intent. A marker does not:
  // `- F-012 and F-014 are the same class` is a bullet of prose, and accepting
  // it would put the phantoms back through a different door.
  if (bracketed) {
    return { id, summary: rest.trim() };
  }
  return null;
}

/** The lines of one finding: from its heading to the next finding or the end. */
function findingBlock(lines: string[], headingIndex: number): string {
  const out: string[] = [];
  for (let i = headingIndex + 1; i < lines.length; i += 1) {
    // The same predicate as the loop that found the heading. When these two
    // disagreed, a phantom did not merely add a finding — it also truncated the
    // real finding above it, taking that finding's `class_scope` with it.
    if (findingHeading(lines[i] ?? "") !== null) {
      break;
    }
    out.push(lines[i] ?? "");
  }
  return out.join("\n");
}

/**
 * Does this finding enumerate its class?
 *
 * A SHAPE check over markdown, not schema validation — stated rather than
 * implied. It requires the block to name `class_scope` and to supply both
 * halves, because either alone is the thing it was added to prevent: a list of
 * sites with no method is unverifiable, and a method with no sites enumerates
 * nothing. `review-finding.schema.json` is the strict form and is what
 * `keryx skills contracts validate` applies to a JSON finding.
 */
function hasClassScope(block: string): boolean {
  const lower = block.toLowerCase();
  return (
    (lower.includes("class_scope") || lower.includes("class scope")) &&
    lower.includes("sites") &&
    lower.includes("enumeration_method")
  );
}

/**
 * Findings that must enumerate their class and do not.
 *
 * Fail-closed at ingest rather than a warning, because the rule this enforces
 * was added after eleven review rounds in which a fix repaired the one site a
 * finding named and left its siblings for the next round to find. A rule that
 * only lives in a schema no path validates against is matched against nothing —
 * which is the `allowlist-not-a-boundary` lesson, applied to this flow's own
 * work.
 */
export function classScopeViolations(
  findings: readonly NormalizedReviewFinding[],
): NormalizedReviewFinding[] {
  return findings.filter(
    (finding) =>
      (finding.severity === "blocker" || finding.severity === "major") &&
      finding.class_scope_present !== true,
  );
}

/**
 * The severity of one finding, from its heading and body.
 *
 * Precedence matters and was learned by executing this on a real report. Reading
 * the heading alone recorded every finding as `minor`, because every reviewer
 * format puts severity on the line below. Then reading heading-plus-body
 * keyword-scanned the prose, and a `minor` finding whose text merely DISCUSSED
 * blockers was recorded as a blocker — which tripped the class-scope guard on a
 * finding that did not need one.
 *
 * So: an explicit declaration wins wherever it appears; only in its absence does
 * a keyword count, and then the heading outranks the body.
 */
function severityFor(heading: string, block: string): NormalizedReviewFinding["severity"] {
  const declared = `${heading}\n${block}`.match(
    /^[\s>*_-]*(?:\*\*|__)?severity(?:\*\*|__)?\s*[:=]\s*(?:\*\*|__|`)?\s*(blocker|major|minor|info)\b/im,
  );
  if (declared?.[1]) {
    return declared[1].toLowerCase() as NormalizedReviewFinding["severity"];
  }
  const fromHeading = severityFromLine(heading);
  // `severityFromLine` cannot say "nothing here", so ask whether the heading
  // actually named one rather than trusting its `minor` default.
  if (/\b(blocker|major|info)\b/i.test(heading)) {
    return fromHeading;
  }
  return severityFromLine(block);
}

function severityFromLine(line: string): NormalizedReviewFinding["severity"] {
  const lower = line.toLowerCase();
  if (lower.includes("blocker")) {
    return "blocker";
  }
  if (lower.includes("major")) {
    return "major";
  }
  if (lower.includes("info")) {
    return "info";
  }
  return "minor";
}

function renderScope(
  input: ManagedReviewInput,
  flowMatch: FlowMatchResult | null,
  at: string,
): string {
  return `# Review Scope

target: ${input.target.kind}
ref: ${input.target.ref}
mode: ${input.mode}
flow: ${flowMatch ? `${flowMatch.id} (${flowMatch.reason})` : "none"}
created_at: ${at}
context_mode: light
`;
}

function renderCoverage(coverage: ReviewCoverageEntry[]): string {
  return `# Reviewer Coverage

${coverage.map((entry) => `reviewer: ${entry.reviewer}\nstatus: ${entry.status}\nreason: ${entry.reason}`).join("\n\n")}
`;
}

function renderReport(report: string, mode: ManagedReviewMode): string {
  return report.trim().length > 0 ? `${report.trim()}\n` : `# Managed Review Report\n\nmode: ${mode}\n`;
}

function renderLearning(findings: NormalizedReviewFinding[]): string {
  const candidates = findings.filter((finding) => finding.classification === "skill_learning_candidate");
  if (candidates.length === 0) {
    return `# Learning

## Skill Learning

- none
`;
  }
  return `# Learning

## Skill Learning

${candidates.map((finding) => `- \`${finding.reviewer}\` <- ${finding.id}: ${finding.summary}`).join("\n")}
`;
}

function renderDecisions(findings: NormalizedReviewFinding[]): string {
  if (findings.length === 0) {
    return `# Decisions

- none
`;
  }
  // `classification` and `flow_relevance` are recorded HERE and not in
  // `findings.json`, because `review-finding.schema.json` is
  // `additionalProperties: false` and neither is a property of the finding: the
  // reviewer states what is wrong, the pipeline states what it intends to do
  // about it. Carrying the pipeline's judgement inside the reviewer's record is
  // what made `findings.json` unusable as `prior_findings[].finding`.
  return `# Decisions

${findings
  .map(
    (finding) =>
      `- ${finding.id}: create follow-up task or learning proposal (${finding.classification}, ${finding.flow_relevance}).`,
  )
  .join("\n")}
`;
}

function defaultReviewId(mode: ManagedReviewMode, kind: string, ref: string, at: string): string {
  const date = at.slice(0, 10);
  const normalizedRef = ref.replace(/^https?:\/\//, "").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${date}-${mode === "attach-review" ? kind : mode}-${slugify(normalizedRef || kind)}`;
}

function matchesTarget(flow: FlowState, dir: string, kind: string, ref: string): boolean {
  if (kind === "pr" && flow.pr.url === ref) {
    return true;
  }
  if (kind === "issue" && flow.source.ref === ref) {
    return true;
  }
  if (kind === "branch") {
    const branchSlug = slugify(ref.replace(/^refs\/heads\//, ""));
    return flow.slug === branchSlug || dir.endsWith(`-${branchSlug}`) || flow.title.includes(ref);
  }
  return false;
}

function matchReason(flow: FlowState, dir: string, kind: string, ref: string): FlowMatchResult["reason"] {
  if (kind === "pr" && flow.pr.url === ref) {
    return "pr-url";
  }
  if (kind === "issue" && flow.source.ref === ref) {
    return "issue-url";
  }
  if (kind === "branch" && matchesTarget(flow, dir, kind, ref)) {
    return "branch";
  }
  return "none";
}

async function missingArtifacts(packageDir: string): Promise<string[]> {
  const missing: string[] = [];
  for (const artifact of ["scope.md", "coverage.md", "report.md", "findings.json", "learning.md", "decisions.md"]) {
    if (!(await pathExists(path.join(packageDir, artifact)))) {
      missing.push(artifact);
    }
  }
  return missing;
}

async function resolveReviewPackagePath(cwd: string, ref: string): Promise<string> {
  const absolute = path.resolve(cwd, ref);
  if (await pathExists(path.join(absolute, "manifest.json"))) {
    return absolute;
  }
  if (await pathExists(absolute) && absolute.endsWith("manifest.json")) {
    return path.dirname(absolute);
  }

  const standalone = path.join(reviewsRoot(cwd), ref);
  if (await pathExists(path.join(standalone, "manifest.json"))) {
    return standalone;
  }

  for (const flowDir of await listFlowDirs(cwd)) {
    const reviewsDir = path.join(flowsRoot(cwd), flowDir, "reviews");
    if (!(await pathExists(reviewsDir))) {
      continue;
    }
    for (const entry of await readdir(reviewsDir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name === ref) {
        return path.join(reviewsDir, entry.name);
      }
    }
  }

  throw new Error(`Managed review package not found: ${ref}`);
}

async function loadDocpackSchema(cwd: string): Promise<Record<string, unknown> | null> {
  const schemaPath = path.join(
    cwd,
    "docs",
    "requirements",
    "managed-review-feedback-loop",
    "schemas",
    "managed-review-package.schema.json",
  );
  if (!(await pathExists(schemaPath))) {
    return null;
  }
  const parsed = JSON.parse(await readFile(schemaPath, "utf8")) as unknown;
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

export function isFindingClassification(value: string): boolean {
  return FINDING_CLASSIFICATIONS.includes(value as (typeof FINDING_CLASSIFICATIONS)[number]);
}
