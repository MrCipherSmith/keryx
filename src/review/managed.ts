import { mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathExists, writeFileAtomic } from "../lib/fs";
import { flowsRoot, listFlowDirs, readFlow, resolveFlowDir, slugify } from "../flow/store";
import type { FlowState } from "../flow/types";
import {
  FINDING_CLASSIFICATIONS,
  MANAGED_REVIEW_MODES,
  REVIEW_COVERAGE_STATUSES,
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
  const findings = normalizeFindings(report, input.mode, flowMatch !== null);
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

  await mkdir(packageDir, { recursive: true });
  await writeFileAtomic(path.join(packageDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFileAtomic(path.join(packageDir, "scope.md"), renderScope(input, flowMatch, at));
  await writeFileAtomic(path.join(packageDir, "coverage.md"), renderCoverage(coverage));
  await writeFileAtomic(path.join(packageDir, "report.md"), renderReport(report, input.mode));
  await writeFileAtomic(path.join(packageDir, "findings.json"), `${JSON.stringify(findings, null, 2)}\n`);
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
  await loadDocpackSchema(cwd);
  const errors: ManagedReviewValidationResult["errors"] = [];

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

  return { valid: errors.length === 0, errors };
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

function normalizeFindings(
  report: string,
  mode: ManagedReviewMode,
  attachedToFlow: boolean,
): NormalizedReviewFinding[] {
  const findings: NormalizedReviewFinding[] = [];
  const lines = report.split("\n");
  for (const line of lines) {
    const match = line.match(/\b(F-\d{3,})\b[:\]\s-]*(.*)/i);
    if (!match?.[1]) {
      continue;
    }
    const id = match[1].toUpperCase();
    const summary = match[2]?.trim() || "Review finding";
    findings.push({
      id,
      severity: severityFromLine(line),
      reviewer: "review-orchestrator",
      summary,
      classification: mode === "ingest" ? "valid_followup" : "skill_learning_candidate",
      flow_relevance: attachedToFlow ? "post_flow_feedback" : "standalone_review",
    });
  }
  return findings;
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

${candidates.map((finding) => `- \`review-orchestrator\` <- ${finding.id}: ${finding.summary}`).join("\n")}
`;
}

function renderDecisions(findings: NormalizedReviewFinding[]): string {
  if (findings.length === 0) {
    return `# Decisions

- none
`;
  }
  return `# Decisions

${findings.map((finding) => `- ${finding.id}: create follow-up task or learning proposal (${finding.classification}).`).join("\n")}
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

async function loadDocpackSchema(cwd: string): Promise<unknown> {
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
  return JSON.parse(await readFile(schemaPath, "utf8")) as unknown;
}

export function isFindingClassification(value: string): boolean {
  return FINDING_CLASSIFICATIONS.includes(value as (typeof FINDING_CLASSIFICATIONS)[number]);
}
