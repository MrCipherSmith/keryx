// `keryx review jev-docs` — flow 333's ADAPTER for the stale-docs reviewer.
// The CLIENT-zone half of the split every Jev-backed review mode in this
// repository already uses (`src/review/jev-rules.ts`'s file header,
// `src/review/ci-triage.ts`): `src/review/jev-docs.ts` is CORE — pure, no
// I/O, no client import — and this file is where it meets the filesystem,
// `gh`, and `src/harness/decision/jev-client.ts`.
//
// Registration in `src/commands/review.ts` is one `if` branch plus one
// import — everything else lives here, mirroring flow 330's
// `src/commands/review-jev-rules.ts` exactly (see that file's own header).

import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { optionValue } from "../lib/args";
import { hunkRegionsFromDiff } from "../review/conform-state";
import { DEFAULT_CONTEXT_LINES } from "../review/scope";
import type { ScopedRegion } from "../review/scope";
import { createFixtureConformPrPort, createGhConformPrPort, type ConformPrInfo, type ConformPrPort } from "../review/conform-pr-port";
import { readJevDocsEnabled } from "../review/jev-docs-config";
import {
  DEFAULT_JEV_DOCS_THRESHOLD,
  DEFAULT_MAX_JEV_DOCS_CALLS,
  batchDocsSections,
  boundLinkedSections,
  detectRemovedFlags,
  docsFindingStats,
  extractDocSections,
  findDeterministicFlagFindings,
  linkSectionsToDiff,
  renderJevDocsMarkdown,
  synthesizeDocsFinding,
  type DocSection,
  type DocsFinding,
} from "../review/jev-docs";
import { callJevSystemOne, DEFAULT_JEV_MODEL, resolveJevApiKey, type JevQuestions } from "../harness/decision/jev-client";

export const JEV_DOCS_FLAGS = ["--diff", "--pr", "--max-calls", "--threshold", "--model", "--repo", "--fixtures", "--json"];

function rejectUnknownJevDocsFlags(args: readonly string[]): void {
  const unknown = args.filter((arg) => arg.startsWith("--") && !JEV_DOCS_FLAGS.includes(arg.split("=")[0]!));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown option${unknown.length > 1 ? "s" : ""} for \`keryx review jev-docs\`: ${[...new Set(unknown)].join(", ")}. ` +
        `Accepted: ${JEV_DOCS_FLAGS.join(", ")}.`,
    );
  }
}

function parseMaxCalls(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_MAX_JEV_DOCS_CALLS;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0 || String(value) !== raw.trim()) {
    throw new Error(`--max-calls must be a non-negative integer, got "${raw}".`);
  }
  return value;
}

function parseThreshold(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_JEV_DOCS_THRESHOLD;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`--threshold must be a number between 0 and 1, got "${raw}".`);
  }
  return value;
}

async function readIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

/** Every `.md`/`.mdc` file under `root`. Never throws on a missing root. */
async function walkMatching(root: string, suffixes: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (suffixes.some((suffix) => entry.name.endsWith(suffix))) {
        out.push(full);
      }
    }
  }
  await walk(root);
  return out.sort();
}

/**
 * AC1: "doc sections (docs/**, README, wiki pages, skill/rule docs)" —
 * discovery is deliberately the same narrow, documented set
 * `src/review/jev-rules.ts`'s module header already chose for rule
 * discovery, extended to the doc-shaped roots this flow's AC names by name:
 * `docs/**`, the root `README.md`, `.metaproject/wiki/**`,
 * `.metaproject/skills/**` and `.metaproject/project-skills/**`
 * (`SKILL.md`), and `.metaproject/rules/**`/`rules/**` (the same rule corpus
 * `review-jev-rules` reads).
 */
async function discoverDocFiles(cwd: string): Promise<string[]> {
  const files = new Set<string>();
  for (const file of await walkMatching(join(cwd, "docs"), [".md"])) files.add(file);
  const readme = join(cwd, "README.md");
  if ((await readIfExists(readme)) !== undefined) files.add(readme);
  for (const file of await walkMatching(join(cwd, ".metaproject", "wiki"), [".md"])) files.add(file);
  for (const file of await walkMatching(join(cwd, ".metaproject", "skills"), ["SKILL.md"])) files.add(file);
  for (const file of await walkMatching(join(cwd, ".metaproject", "project-skills"), ["SKILL.md"])) files.add(file);
  for (const root of [join(cwd, ".metaproject", "rules"), join(cwd, "rules")]) {
    for (const file of await walkMatching(root, [".md", ".mdc"])) files.add(file);
  }
  return [...files].sort();
}

async function loadDocSections(cwd: string): Promise<DocSection[]> {
  const sections: DocSection[] = [];
  for (const file of await discoverDocFiles(cwd)) {
    const text = await readIfExists(file);
    if (text === undefined) continue;
    sections.push(...extractDocSections(relative(cwd, file), text));
  }
  return sections;
}

/** `keryx <verb>` mentions are "linked to changed code" when `src/commands/<verb>.ts` is one of the diff's own changed files. */
function changedCommandNamesFromRegions(regions: readonly ScopedRegion[]): Set<string> {
  const names = new Set<string>();
  for (const region of regions) {
    const match = /^src\/commands\/([a-z0-9-]+)\.ts$/.exec(region.path);
    if (match?.[1] !== undefined) names.add(match[1]);
  }
  return names;
}

async function fixturePrPort(dir: string): Promise<ConformPrPort> {
  const raw = await readFile(join(dir, "pr.json"), "utf8");
  return createFixtureConformPrPort({ pr: JSON.parse(raw) as ConformPrInfo });
}

/** `--fixtures <dir>/jev-responses.json`: one canned `/systemone` response per batch, consumed in call order — same shape `review-jev-rules.ts`'s own fixture fetch uses. */
async function fixtureJevFetch(dir: string): Promise<typeof fetch> {
  const raw = await readFile(join(dir, "jev-responses.json"), "utf8");
  const responses = JSON.parse(raw) as unknown[];
  let index = 0;
  const fn = async (): Promise<Response> => {
    if (index >= responses.length) {
      throw new Error(`fixture jev-responses.json has only ${responses.length} response(s); a call beyond that was made.`);
    }
    const body = JSON.stringify(responses[index]);
    index += 1;
    return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  };
  return fn as unknown as typeof fetch;
}

export interface JevDocsComputedResult {
  readonly status: "DONE" | "DONE_WITH_CONCERNS";
  readonly reviewer: "review-jev-docs";
  readonly summary: string;
  readonly findings: readonly DocsFinding[];
  readonly stats: ReturnType<typeof docsFindingStats>;
  readonly tokens: { readonly jevCalls: number; readonly inputTokens?: number; readonly outputTokens?: number; readonly costUsd?: number };
  readonly selection: { readonly maxCalls: number; readonly linkedSections: number; readonly selectedSections: number; readonly droppedSections: number };
}

export interface JevDocsRunOptions {
  readonly cwd: string;
  readonly regions: readonly ScopedRegion[];
  readonly targetLabel: string;
  readonly maxCalls?: number;
  readonly threshold?: number;
  readonly model?: string;
  readonly fetchFn?: typeof fetch;
}

/**
 * Everything past "which hunks": doc discovery, deterministic linking,
 * deterministic flag findings, batching, the Jev calls, and finding
 * synthesis. Shared by the CLI (`runJevDocs`, below) and the TUI's
 * `/staledocs` (`src/tui/jev-docs-command.ts`).
 *
 * Callers MUST have already passed the opt-in and credential gates
 * (`jevDocsGateRefusal`) — this makes network calls unconditionally when
 * there is anything to score.
 */
export async function computeJevDocsResult(options: JevDocsRunOptions): Promise<JevDocsComputedResult> {
  const { cwd, regions, targetLabel } = options;
  const maxCalls = options.maxCalls ?? DEFAULT_MAX_JEV_DOCS_CALLS;
  const threshold = options.threshold ?? DEFAULT_JEV_DOCS_THRESHOLD;
  const model = options.model ?? DEFAULT_JEV_MODEL;
  const fetchFn = options.fetchFn ?? globalThis.fetch;

  const sections = await loadDocSections(cwd);
  const changedFiles = new Set(regions.map((r) => r.path));
  const linked = linkSectionsToDiff(sections, regions, changedCommandNamesFromRegions(regions));
  const selection = boundLinkedSections(linked, maxCalls);

  // AC2's deterministic-without-Jev flag check — runs regardless of the Jev
  // budget, over every discovered section, not only the ones selected above.
  const removedFlags = detectRemovedFlags(regions);
  const flagFindings = findDeterministicFlagFindings(sections, removedFlags, changedFiles);

  const batches = batchDocsSections(selection.selected);
  const jevFindings: DocsFinding[] = [];
  let jevCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  let sawUsage = false;

  for (const batch of batches) {
    const result = await callJevSystemOne(fetchFn, { model, state: batch.state, questions: batch.questions as JevQuestions }, { env: process.env });
    jevCalls += 1;
    if (result.usage.input_tokens !== undefined) {
      inputTokens += result.usage.input_tokens;
      sawUsage = true;
    }
    if (result.usage.output_tokens !== undefined) {
      outputTokens += result.usage.output_tokens;
      sawUsage = true;
    }
    if (result.usage.cost !== undefined) {
      costUsd += result.usage.cost;
      sawUsage = true;
    }
    for (const item of batch.items) {
      const key = `${item.section.file}::${item.section.line}`;
      const answer = result.answers[key];
      if (answer === undefined || answer.type !== "noul") continue;
      const finding = synthesizeDocsFinding(item, answer.noul, threshold);
      if (finding !== undefined) jevFindings.push(finding);
    }
  }

  const findings = [...flagFindings, ...jevFindings].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  const stats = docsFindingStats(findings);
  const status = findings.length > 0 ? "DONE_WITH_CONCERNS" : "DONE";
  const summary =
    `Checked ${sections.length} doc section(s) against ${targetLabel}; ${linked.length} linked to changed code, ` +
    `${selection.selected.length} scored by Jev (${selection.dropped.length} dropped by --max-calls ${maxCalls}); ` +
    `${flagFindings.length} deterministic flag finding(s), ${jevFindings.length} Jev-scored finding(s).`;

  return {
    status,
    reviewer: "review-jev-docs",
    summary,
    findings,
    stats,
    tokens: sawUsage ? { jevCalls, inputTokens, outputTokens, costUsd } : { jevCalls },
    selection: { maxCalls, linkedSections: linked.length, selectedSections: selection.selected.length, droppedSections: selection.dropped.length },
  };
}

/**
 * AC5's gate, reusable by any adapter (the CLI below, and the TUI's
 * `/staledocs`): opt-in first, credential second, both before any doc read
 * or network call. Returns the refusal message to print/show, or `undefined`
 * when the run may proceed.
 */
export async function jevDocsGateRefusal(cwd: string): Promise<string | undefined> {
  if (!(await readJevDocsEnabled(cwd))) {
    return (
      "`review.jev.docs` is not enabled for this project (.metaproject/tasks.config.json: " +
      '`{"review":{"jev":{"docs":true}}}`). review-jev-docs sends redacted doc-section text and hunk text to ' +
      "OpenRouter/TypeSafe, so it is opt-in — nothing was read and no network call was made."
    );
  }
  const apiKey = resolveJevApiKey(process.env);
  if (apiKey === undefined || apiKey.length === 0) {
    return (
      "OPENROUTER_API_KEY is not set, and no openrouterKey is saved in the keryx shell config: review-jev-docs needs " +
      "a Jev/OpenRouter credential and made no network call."
    );
  }
  return undefined;
}

/** The diff this run checks — a minimal copy of `review-jev-rules.ts`'s own `gitDiffForJevRules`, same reasoning (that helper lives in a file this flow was told to touch only additively). */
async function gitDiffForJevDocs(ref: string | undefined, contextLines: number): Promise<string> {
  const command = ["git", "diff", "--no-color", `-U${contextLines}`, ...(ref === undefined ? [] : [ref])];
  const proc = Bun.spawn(command, { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (exitCode !== 0) {
    throw new Error(`git diff failed (exit ${exitCode}): ${stderr.trim()}`);
  }
  return stdout;
}

export async function runJevDocs(args: string[]): Promise<void> {
  rejectUnknownJevDocsFlags(args);
  const cwd = process.cwd();

  const diffRef = optionValue(args, "--diff");
  const prArg = optionValue(args, "--pr");
  const provided = [diffRef, prArg].filter((value) => value !== undefined);
  if (provided.length !== 1) {
    throw new Error("Usage: keryx review jev-docs (--diff <ref> | --pr <n>) [--max-calls N] [--threshold 0..1] [--json]");
  }

  // AC5: opt-in per project, refused before any read or network call.
  const refusal = await jevDocsGateRefusal(cwd);
  if (refusal !== undefined) {
    console.error(refusal);
    process.exitCode = 1;
    return;
  }

  const fixturesDir = optionValue(args, "--fixtures");
  const model = optionValue(args, "--model") ?? DEFAULT_JEV_MODEL;
  const maxCalls = parseMaxCalls(optionValue(args, "--max-calls"));
  const threshold = parseThreshold(optionValue(args, "--threshold"));

  let regions: readonly ScopedRegion[];
  let targetLabel: string;
  if (prArg !== undefined) {
    const number = Number(prArg);
    if (!Number.isInteger(number) || number <= 0) {
      throw new Error(`--pr must be a positive integer, got "${prArg}".`);
    }
    const port: ConformPrPort = fixturesDir === undefined ? createGhConformPrPort(undefined, optionValue(args, "--repo")) : await fixturePrPort(fixturesDir);
    const info = await port.pr(number);
    regions = hunkRegionsFromDiff(info.diff);
    targetLabel = `PR #${info.number} — ${info.title}`;
  } else {
    const diff = await gitDiffForJevDocs(diffRef, DEFAULT_CONTEXT_LINES);
    regions = hunkRegionsFromDiff(diff);
    targetLabel = diffRef ?? "working diff";
  }

  const fetchFn: typeof fetch = fixturesDir === undefined ? globalThis.fetch : await fixtureJevFetch(fixturesDir);
  const result = await computeJevDocsResult({ cwd, regions, targetLabel, maxCalls, threshold, model, fetchFn });

  if (args.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(renderJevDocsMarkdown(result));
}
