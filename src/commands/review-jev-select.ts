// `keryx review jev-select` — flow 344's ADAPTER. Same split every Jev-backed
// review mode in this repository already uses (see
// `src/commands/review-jev-risk.ts`'s own header): `src/review/jev-select.ts`
// is CORE — pure, no I/O, no client import — and this file is where it meets
// the filesystem, `git`, and `src/harness/decision/jev-client.ts`.
//
// Registration in `src/commands/review.ts` is one `if` branch plus one
// import, matching every prior `review-jev-*` reviewer's own registration
// note.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { optionValue } from "../lib/args";
import { pathExists, writeFileAtomic } from "../lib/fs";
import { collectReviewers, PROJECT_REVIEWER_MODULE } from "../review/reviewers";
import { DEFAULT_CONTEXT_LINES, buildReviewScope } from "../review/scope";
import { readJevSelectEnabled, readJevSelectSkipBelow, DEFAULT_SELECT_SKIP_BELOW } from "../review/jev-select-config";
import {
  DEFAULT_SELECT_STATE_BUDGET_TOKENS,
  allKeptFailOpen,
  batchSelectQuestions,
  buildJevSelectState,
  decideCandidates,
  renderJevSelectMarkdown,
  summarizeDecisions,
  summarizeDiffForSelect,
  upsertJevSelectBlock,
  type JevSelectDecision,
  type ReviewerCandidate,
} from "../review/jev-select";
import { callJevSystemOne, DEFAULT_JEV_MODEL, JEV_TOKEN_BUDGET, resolveJevApiKey, type JevQuestions } from "../harness/decision/jev-client";

export const JEV_SELECT_FLAGS = ["--diff", "--ref", "--reviewers", "--model", "--skip-below", "--max-calls", "--fixtures", "--json", "--out"];

function rejectUnknownJevSelectFlags(args: readonly string[]): void {
  const unknown = args.filter((arg) => arg.startsWith("--") && !JEV_SELECT_FLAGS.includes(arg.split("=")[0]!));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown option${unknown.length > 1 ? "s" : ""} for \`keryx review jev-select\`: ${[...new Set(unknown)].join(", ")}. ` +
        `Accepted: ${JEV_SELECT_FLAGS.join(", ")}.`,
    );
  }
}

function parseSkipBelowFlag(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`--skip-below must be a number between 0 and 1, got "${raw}".`);
  }
  return value;
}

/**
 * The candidate reviewer list, from the SAME source `keryx review reviewers
 * --json` reads (`collectReviewers`) — bundled and project reviewers alike,
 * ids plus descriptions (bundled reviewers carry `description` straight off
 * their own `SKILL.md` frontmatter, same field a project reviewer already
 * had). `--reviewers <file>|-` overrides this with a fixed list (a prior
 * `keryx review reviewers --json` capture, or a fixture), for a caller that
 * wants to score a specific candidate set without re-reading the installed
 * tree.
 */
async function loadCandidates(cwd: string, reviewersArg: string | undefined): Promise<ReviewerCandidate[]> {
  if (reviewersArg !== undefined) {
    const raw = reviewersArg === "-" ? await Bun.stdin.text() : await Bun.file(reviewersArg).text();
    const parsed = JSON.parse(raw) as unknown;
    const list: unknown[] = Array.isArray(parsed)
      ? parsed
      : [
          ...((parsed as { bundled?: unknown[] })?.bundled ?? []),
          ...((parsed as { project?: unknown[] })?.project ?? []),
        ];
    return list.map((entry) => {
      const record = entry as { name?: unknown; id?: unknown; description?: unknown };
      const id = typeof record.id === "string" ? record.id : typeof record.name === "string" ? record.name : undefined;
      if (id === undefined) {
        throw new Error(`--reviewers ${reviewersArg} carries an entry with no "id"/"name". Pass \`keryx review reviewers --json\` output.`);
      }
      return { id, ...(typeof record.description === "string" ? { description: record.description } : {}) };
    });
  }
  const inventory = await collectReviewers(cwd);
  const bundled = inventory.bundled.map((reviewer) => ({
    id: reviewer.name,
    ...(reviewer.description !== undefined ? { description: reviewer.description } : {}),
  }));
  const project = inventory.project.map((reviewer) => ({
    id: reviewer.name,
    ...(reviewer.description !== undefined ? { description: reviewer.description } : {}),
  }));
  return [...bundled, ...project];
}

/** Same shape every `review-jev-*` adapter's own `fixtureJevFetch` uses — a canned `/systemone` response per call, consumed in order. */
async function fixtureJevFetch(dir: string): Promise<typeof fetch> {
  const raw = await readFile(path.join(dir, "jev-responses.json"), "utf8");
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

async function fixtureCandidates(dir: string): Promise<ReviewerCandidate[] | undefined> {
  const file = path.join(dir, "reviewers.json");
  if (!(await pathExists(file))) return undefined;
  const raw = JSON.parse(await readFile(file, "utf8")) as ReviewerCandidate[];
  return raw;
}

async function gitDiffForJevSelect(ref: string | undefined, contextLines: number): Promise<string> {
  const command = ["git", "diff", "--no-color", `-U${contextLines}`, ...(ref === undefined ? [] : [ref])];
  const proc = Bun.spawn(command, { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (exitCode !== 0) {
    throw new Error(`git diff failed (exit ${exitCode}): ${stderr.trim()}`);
  }
  return stdout;
}

async function readDiffText(diffArg: string | undefined, refArg: string | undefined): Promise<{ text: string; label: string }> {
  if (diffArg !== undefined) {
    const text = diffArg === "-" ? await Bun.stdin.text() : await Bun.file(diffArg).text();
    return { text, label: diffArg === "-" ? "stdin diff" : diffArg };
  }
  const text = await gitDiffForJevSelect(refArg, DEFAULT_CONTEXT_LINES);
  return { text, label: refArg ?? "working diff" };
}

function writeOutput(decisions: readonly JevSelectDecision[], skipBelow: number, asJson: boolean): void {
  const result = summarizeDecisions(decisions, skipBelow);
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(renderJevSelectMarkdown(result));
}

async function writeOut(outPath: string | undefined, decisions: readonly JevSelectDecision[], skipBelow: number): Promise<void> {
  if (outPath === undefined) return;
  const result = summarizeDecisions(decisions, skipBelow);
  if (outPath.endsWith(".json")) {
    await writeFileAtomic(outPath, `${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  const existing = await readFile(outPath, "utf8").catch(() => "");
  await writeFileAtomic(outPath, upsertJevSelectBlock(existing, renderJevSelectMarkdown(result)));
}

export async function runJevSelect(args: string[]): Promise<void> {
  rejectUnknownJevSelectFlags(args);
  const cwd = process.cwd();

  const diffArg = optionValue(args, "--diff");
  const refArg = optionValue(args, "--ref");
  if (diffArg !== undefined && refArg !== undefined) {
    throw new Error("Usage: keryx review jev-select (--diff <file>|- | --ref <base>) [--reviewers <file>|-] [--skip-below 0..1] [--json] [--out <path>]");
  }

  const fixturesDir = optionValue(args, "--fixtures");
  const skipBelowFlag = parseSkipBelowFlag(optionValue(args, "--skip-below"));
  const skipBelow = skipBelowFlag ?? (await readJevSelectSkipBelow(cwd));
  const asJson = args.includes("--json");
  const outPath = optionValue(args, "--out");
  const model = optionValue(args, "--model") ?? DEFAULT_JEV_MODEL;

  const candidates =
    fixturesDir !== undefined ? (await fixtureCandidates(fixturesDir)) ?? (await loadCandidates(cwd, optionValue(args, "--reviewers"))) : await loadCandidates(cwd, optionValue(args, "--reviewers"));

  if (candidates.length === 0) {
    writeOutput([], skipBelow, asJson);
    await writeOut(outPath, [], skipBelow);
    return;
  }

  // Opt-in gate. UNLIKE every other `review.jev.*` gate, this one never
  // refuses the round — it keeps every candidate and says why, because a
  // selection lever nobody has measured yet must never cost reviewer
  // coverage on its own account.
  if (fixturesDir === undefined && !(await readJevSelectEnabled(cwd))) {
    const decisions = allKeptFailOpen(
      candidates,
      `review.jev.select is not enabled for this project (.metaproject/tasks.config.json: {"review":{"jev":{"select":true}}}) — kept (fail-open)`,
    );
    writeOutput(decisions, skipBelow, asJson);
    await writeOut(outPath, decisions, skipBelow);
    return;
  }

  if (fixturesDir === undefined) {
    const apiKey = resolveJevApiKey(process.env);
    if (apiKey === undefined || apiKey.length === 0) {
      const decisions = allKeptFailOpen(
        candidates,
        "OPENROUTER_API_KEY is not set, and no openrouterKey is saved in the keryx shell config — kept (fail-open); no network call was made.",
      );
      writeOutput(decisions, skipBelow, asJson);
      await writeOut(outPath, decisions, skipBelow);
      return;
    }
  }

  const { text: diffText, label } = await readDiffText(diffArg, refArg);
  const scope = buildReviewScope(diffText);
  const summary = summarizeDiffForSelect(scope.regions, scope.files, DEFAULT_SELECT_STATE_BUDGET_TOKENS);
  const state = buildJevSelectState(summary);

  const fetchFn: typeof fetch = fixturesDir === undefined ? globalThis.fetch : await fixtureJevFetch(fixturesDir);
  const batches = batchSelectQuestions(candidates, state, JEV_TOKEN_BUDGET);

  const answers = new Map<string, number>();
  let failOpenReason: string | undefined;
  for (const batch of batches) {
    try {
      const result = await callJevSystemOne(fetchFn, { model, state, questions: batch.questions as unknown as JevQuestions }, { env: process.env });
      for (const candidate of batch.candidates) {
        const answer = result.answers[`q:${candidate.id}`];
        if (answer !== undefined && answer.type === "noul") {
          answers.set(candidate.id, answer.noul);
        }
      }
    } catch (error) {
      // Fail open: ANY error from ANY batch keeps every candidate this run
      // has not already scored — a partial Jev outage must not read as
      // "these reviewers scored low", which is the one failure mode this
      // whole command exists to avoid.
      failOpenReason = `jev-select call failed (${error instanceof Error ? error.message : String(error)}) — kept (fail-open)`;
      break;
    }
  }

  const decisions = decideCandidates(candidates, answers, skipBelow, failOpenReason);
  if (asJson) {
    console.log(JSON.stringify({ ...summarizeDecisions(decisions, skipBelow), target: label }, null, 2));
  } else {
    console.log(`target: ${label}`);
    console.log(renderJevSelectMarkdown(summarizeDecisions(decisions, skipBelow)));
  }
  await writeOut(outPath, decisions, skipBelow);
}

/** Exported for tests that want the default without going through the config reader, and for anything that needs the project-reviewer module name. */
export { DEFAULT_SELECT_SKIP_BELOW };
export { PROJECT_REVIEWER_MODULE };
