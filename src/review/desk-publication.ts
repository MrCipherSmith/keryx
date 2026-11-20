import { createHash } from "node:crypto";
import { lstat, readFile, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { isNotFound, withFileLock, writeFileAtomic } from "../lib/fs";
import { boardGh, projectGithubConnection, verifyGithubBindingUnchanged, withCurrentGithubBinding, type GithubConnection } from "./board-github";
import { parseDiffHunks, type ReviewComment } from "./bot/post";
import { screenCommentBody } from "./bot/redaction";
import { verifyDeskSubject } from "./desk-run-service";
import { DeskRunStore } from "./desk-run-store";
import type { PublicationAnswer, PublicationOptionId, PublicationRequest, PublicationSettings, PublicationState } from "./desk-publication-types";
import type { DeskRunKey } from "./desk-run-types";
import { namedGithubEnvironment, reviewCommandOptions, reviewTool } from "./github-cli";
import { callGitHub, createGhPort, parseGhJson, renderRoundBlock } from "./pr-comments";
import { premiseHoldState } from "./premise";
import { buildRoundBlock, PUBLISHED_BODY_LIMIT, type ReviewEvent } from "./publish";
import { computeReadiness, failingItems } from "./readiness";
import { readRoundNumber } from "./round-record";
import type { ManagedReviewManifest } from "./types";
import { computeVerdict, premiseRecords, type VerdictFinding } from "./verdict";

const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const sha = /^[a-f\d]{40}$/i;
const overlayPath = ".metaproject/review-publish-template.md";
const placeholder = "{{review}}";
const eventFor: Record<PublicationSettings["verdict"], ReviewEvent> = {
  approve: "APPROVE", suggestions: "APPROVE", changes: "REQUEST_CHANGES", comment: "COMMENT",
};
type Finding = { id: string; severity: VerdictFinding["severity"]; problem: string; file: string | null; line: number | null; impact: string; suggested_fix: string; selectedAnswer?: string };
type Draft = { settings: PublicationSettings; body: string; comments: ReviewComment[]; savedAt: string };
type Receipt = { url?: string };
type Prepared = { state: PublicationState; comments: ReviewComment[]; publicationBody: string };
const object = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
const text = (v: unknown) => typeof v === "string" ? v.trim() : "";
const escapedLocation = (v: string) => v.replace(/[\p{Cc}`<>]/gu, "");

async function scopedFile(root: string, relative: string, limit: number): Promise<string | undefined> {
  const target = path.join(root, relative);
  try {
    const stat = await lstat(target);
    if (!stat.isFile() || stat.size > limit || await realpath(target) !== path.join(await realpath(root), relative)) return;
    return await readFile(target, "utf8");
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

async function json<T>(root: string, relative: string, limit: number): Promise<T | undefined> {
  const content = await scopedFile(root, relative, limit);
  return content === undefined ? undefined : JSON.parse(content) as T;
}

function findingOf(entry: VerdictFinding, raw: Record<string, unknown> | undefined): Finding {
  const file = text(raw?.file ?? raw?.path);
  const line = raw?.line ?? raw?.start_line;
  return {
    id: entry.id, severity: entry.severity, problem: text(raw?.problem) || entry.problem,
    file: file || null, line: typeof line === "number" && Number.isSafeInteger(line) && line > 0 ? line : null,
    impact: text(raw?.impact), suggested_fix: text(raw?.suggested_fix),
  };
}

function markdown(finding: Finding) {
  const location = finding.file && escapedLocation(finding.file);
  return [
    `**${finding.severity.toUpperCase()} · ${escapedLocation(finding.id)}**${location ? ` · \`${location}${finding.line ? `:${finding.line}` : ""}\`` : ""}`,
    finding.problem, finding.impact && `Impact: ${finding.impact}`, finding.suggested_fix && `Suggested fix: ${finding.suggested_fix}`,
    finding.selectedAnswer && `**Selected answer:** ${finding.selectedAnswer}`,
  ].filter(Boolean).join("\n\n");
}

function recommendation(coverage: boolean, findings: Finding[]): PublicationSettings["verdict"] {
  if (findings.some(finding => finding.severity === "blocker" || finding.severity === "major")) return "changes";
  if (!coverage) return "comment";
  return findings.length ? "suggestions" : "approve";
}

function publicationLink(key: DeskRunKey, id: unknown): string | undefined {
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0
    ? `https://github.com/${key.repo}/pull/${key.number}#pullrequestreview-${id}` : undefined;
}

async function findPreviousPublication(cwd: string, key: DeskRunKey, auth: GithubConnection, marker: string) {
  const args = ["api", "--hostname", "github.com", "--paginate", `repos/${key.repo}/pulls/${key.number}/reviews?per_page=100`];
  const data = parseGhJson(await boardGh(cwd, args, auth));
  if (!Array.isArray(data)) return;
  for (const item of data) {
    const row = object(item);
    if (text(object(row?.user)?.login).toLowerCase() === key.viewer.toLowerCase() &&
        typeof row?.body === "string" && row.body.includes(marker)) return publicationLink(key, row.id);
  }
}

async function prepare(input: {
  cwd: string; directory: string; run: NonNullable<ReturnType<DeskRunStore["byId"]>>["run"];
  key: DeskRunKey; auth: GithubConnection; request: PublicationRequest; current: boolean;
}): Promise<Prepared> {
  const { cwd, directory, run, key, auth, request, current } = input;
  const packageDir = path.join(directory, "package");
  const target = `https://github.com/${key.repo}/pull/${key.number}`;
  const manifest = await json<ManagedReviewManifest>(directory, "package/manifest.json", 2 * 1024 * 1024);
  if (manifest?.target?.ref.toLowerCase() !== target.toLowerCase() ||
      manifest.target.base !== run.baseSha || manifest.target.head !== run.headSha) {
    throw new Error("configuration: This review has no matching local package to publish.");
  }
  const [recorded, verdict, draft, receipt, overlayFile, readiness] = await Promise.all([
    premiseRecords(packageDir), computeVerdict(packageDir),
    json<Draft>(directory, "publication-draft.json", 3 * 1024 * 1024),
    json<Receipt>(directory, "publication-receipt.json", 4096),
    scopedFile(cwd, overlayPath, 8192), computeReadiness(packageDir),
  ]);
  const overlay = overlayFile?.split(placeholder).length === 2 ? overlayFile : undefined;
  const recordFor = (entry: VerdictFinding) => recorded.records.find(row =>
    row.id === entry.id && (!row.reviewer || row.reviewer === entry.reviewer));
  const questionId = (entry: VerdictFinding) => text(recordFor(entry)?.global_id) || entry.id;
  const questions = verdict.held.map<PublicationState["questions"][number]>(entry => {
    const premise = object(recordFor(entry)?.premise);
    const id = questionId(entry);
    const labels = Array.isArray(premise?.options) ? [...new Set(premise.options.map(text).filter(Boolean))] : [];
    const options = labels.map(label => ({
      // Store the option's identity, so a reordered report never changes a saved choice.
      id: `option:${createHash("sha256").update(JSON.stringify([id, label])).digest("hex")}` as PublicationOptionId,
      label,
    }));
    const question = { id, text: text(premise?.question) || entry.problem };
    const recommendation = premise?.verdict === "challenged" ? "dismiss" as const : "uphold" as const;
    return options.length ? { ...question, options } : { ...question, recommendation };
  });
  const saved = request.settings ?? draft?.settings;
  const selections = new Map<string, PublicationAnswer>();
  const selectedLabels = new Map<string, string>();
  for (const question of questions) {
    if (!saved || !Object.hasOwn(saved.answers, question.id)) continue;
    const answer = saved.answers[question.id];
    if (question.options) {
      const selected = question.options.find(option => option.id === answer);
      if (selected) {
        selections.set(question.id, selected.id);
        selectedLabels.set(question.id, selected.label);
      }
    } else if (answer === "uphold" || answer === "dismiss") selections.set(question.id, answer);
  }
  const answers = Object.fromEntries(selections);
  const findings = [...verdict.open, ...verdict.minors].map(entry => findingOf(entry, recordFor(entry)));
  for (const entry of verdict.held) {
    const id = questionId(entry);
    const selectedAnswer = selectedLabels.get(id);
    if (selectedAnswer || selections.get(id) === "uphold") findings.push({
      ...findingOf(entry, recordFor(entry)), ...(selectedAnswer && { selectedAnswer }),
    });
  }
  const answered = questions.every(question => Object.hasOwn(answers, question.id));
  const failing = failingItems(readiness).filter(item =>
    item.id !== "premise-decisions" || !answered ||
    recorded.records.some(row => premiseHoldState(row, recorded.decisions) === "awaiting" && !Object.hasOwn(answers, text(row.global_id ?? row.id))));
  const complete = run.result?.coverage === "complete" && failing.length === 0;
  const settings: PublicationSettings = {
    inline: saved?.inline ?? false, general: saved?.general ?? true, keryxTemplate: saved?.keryxTemplate ?? true,
    overlay: !!overlay && saved?.overlay === true, verdict: saved?.verdict ?? recommendation(complete, findings), answers,
  };
  const comments: ReviewComment[] = [];
  const inBody: Finding[] = [];
  let inlineUnavailable = false;
  if (settings.inline && current && findings.some(finding => finding.file && finding.line)) {
    try {
      const diff = await boardGh(cwd, ["api", "--hostname", "github.com", "-H", "Accept: application/vnd.github.v3.diff",
        `repos/${key.repo}/pulls/${key.number}`], auth);
      const hunks = parseDiffHunks(diff);
      for (const finding of findings) {
        if (finding.file && finding.line && hunks.get(finding.file)?.has(finding.line)) {
          comments.push({ path: finding.file, line: finding.line, side: "RIGHT",
            body: markdown(finding) });
        } else inBody.push(finding);
      }
    } catch (error) {
      if (!(error instanceof Error && error.message.startsWith("unavailable:"))) throw error;
      inlineUnavailable = true;
      inBody.push(...findings);
    }
  } else inBody.push(...findings);
  const reviewLabels = { approve: "Approved", suggestions: "Approved with suggestions", changes: "Changes requested", comment: "Review comments" };
  const header = `Reviewed \`${run.headSha.slice(0, 12)}\` against \`${run.baseSha.slice(0, 12)}\`.`;
  const status = !complete
    ? `**Partial review.** Reviewer coverage or readiness is incomplete.${failing.length ? ` Open checks: ${failing.map(item => item.id).join(", ")}.` : ""}`
    : "";
  const summary = [
    settings.keryxTemplate ? `## ${reviewLabels[settings.verdict]}` : "", status, header,
    ...(settings.general ? [
      settings.keryxTemplate && (inBody.length || comments.length) ? "### Findings" : "",
      ...inBody.map(markdown),
      comments.length ? `${comments.length} inline comment(s).` : inBody.length ? "" : "No findings selected for publication.",
    ] : inBody.length ? [`${inBody.length} finding(s) without an inline location omitted from this review.`] : []),
  ].filter(Boolean).join("\n\n");
  let body = settings.overlay && overlay ? overlay.replace(placeholder, () => summary) : summary;
  const visibleBody = body;
  const round = buildRoundBlock({ body, round: readRoundNumber(packageDir) ?? 1,
    reviewId: manifest.reviewId, reviewedHead: run.headSha, findings: inBody });
  if (settings.keryxTemplate) body += `\n\n${renderRoundBlock(round)}`;
  const marker = `<!-- keryx-desktop-review ${request.id} -->`;
  body += `\n\n${marker}`;
  const publishedUrl = receipt && (receipt.url ?? await findPreviousPublication(cwd, key, auth, marker));
  const digest = createHash("sha256").update(JSON.stringify([request.id, key, run.headSha, settings, body, comments, questions])).digest("hex");
  const approval = eventFor[settings.verdict] === "APPROVE";
  const blockedReason = publishedUrl ? "This review has already been published."
    : receipt ? "A previous submission has an unknown result. Check the pull request before sending another review."
    : !current ? "The pull request is closed or its revision moved. You can still save this draft locally."
    : !answered ? "Answer each finding question before publishing."
    : approval && !complete ? "A partial review cannot approve. Select Comment only or Request changes."
    : inlineUnavailable ? "The pull request diff is unavailable. Retry or turn off inline comments."
    : comments.length > 100 || body.length > PUBLISHED_BODY_LIMIT ? "This draft exceeds the GitHub review size limit."
    : !settings.general && !comments.length ? "Enable General comment or select inline comments that are on the diff." : undefined;
  return { state: { version: 1, settings, body: visibleBody, inlineCount: comments.length, questions, overlayAvailable: !!overlay,
    canSubmit: !blockedReason, digest, ...(blockedReason ? { blockedReason } : {}),
    ...(draft ? { savedAt: draft.savedAt } : {}), ...(publishedUrl ? { publishedUrl } : {}) }, comments, publicationBody: body };
}

export async function requestDeskPublication(cwd: string, key: DeskRunKey, request: PublicationRequest): Promise<PublicationState> {
  if (!uuid.test(request.id) || !/^[\w-]+\/[\w.-]+$/.test(key.repo) || !Number.isSafeInteger(key.number) || key.number < 1) {
    throw new Error("configuration: Invalid review publication target.");
  }
  const connection = await projectGithubConnection(cwd, process.env, key.viewer);
  // Pin the credential used by the send too, even when the project's viewer was discovered through gh's default account.
  const auth: GithubConnection = connection.login ? connection : {
    ...connection, login: key.viewer, env: await namedGithubEnvironment(cwd, key.viewer, connection.env),
  };
  const store = new DeskRunStore(undefined, true);
  const directory = store.directory(request.id);
  const attempt = (() => {
    try { return store.byId(request.id); }
    finally { store.close(); }
  })();
  const run = attempt?.run;
  if (!attempt || !run?.result?.reviewed || run.source === "existing" ||
      (run.state !== "completed" && run.state !== "partial") ||
      attempt.key.number !== key.number || attempt.key.repositoryId !== key.repositoryId ||
      attempt.key.repo.toLowerCase() !== key.repo.toLowerCase() || attempt.key.viewer.toLowerCase() !== key.viewer.toLowerCase() ||
      !sha.test(run.baseSha) || !sha.test(run.headSha) ||
      run.result.reviewed.baseSha !== run.baseSha || run.result.reviewed.headSha !== run.headSha) {
    throw new Error("access: A verified local review for this account and pull request was not found.");
  }
  const pr = await verifyDeskSubject(cwd, key, undefined, auth);
  const current = pr.state === "OPEN" && pr.baseRefOid === run.baseSha && pr.headRefOid === run.headSha;
  const render = () => prepare({ cwd, directory, run, key, auth, request, current });
  if (request.kind === "preview") {
    const { state } = await render();
    verifyGithubBindingUnchanged(auth);
    return state;
  }
  return withFileLock(path.join(directory, "publication.lock"), async () => {
    const { state, comments, publicationBody } = await render();
    const savedAt = new Date().toISOString();
    const draft: Draft = { settings: state.settings, body: state.body, comments, savedAt };
    const save = () => writeFileAtomic(path.join(directory, "publication-draft.json"), JSON.stringify(draft), { mode: 0o600 });
    if (request.kind === "save") {
      verifyGithubBindingUnchanged(auth);
      await save();
      return { ...state, savedAt };
    }
    if (request.digest !== state.digest) throw new Error("stale: The review preview changed. Refresh it before submitting.");
    if (!state.canSubmit) throw new Error(`configuration: ${state.blockedReason}`);
    const outbound = { event: eventFor[state.settings.verdict], body: publicationBody, comments, commit_id: run.headSha };
    const screen = await Promise.all([outbound.body, ...comments.map(comment => comment.body)].map(body => screenCommentBody(cwd, body)));
    if (screen.some(result => !result.ok)) throw new Error("configuration: The security output check withheld this draft. Review the selected content before submitting.");
    await verifyDeskSubject(cwd, key, run, auth);
    await save();
    const receiptPath = path.join(directory, "publication-receipt.json");
    // Persist the intent before the network call. A lost response must not cause a duplicate review.
    await writeFileAtomic(receiptPath, "{}", { mode: 0o600 });
    const options = reviewCommandOptions(cwd, auth.env);
    let rejected: number | undefined;
    const port = createGhPort(async (argv, stdin) => {
      const proc = withCurrentGithubBinding(auth, () => Bun.spawn([reviewTool("gh", auth.env), "api", "--hostname", "github.com", ...argv.slice(2)], {
        cwd, env: options.env, stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
        stdout: "pipe", stderr: "pipe", signal: AbortSignal.timeout(options.timeout),
      }));
      const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      if (exitCode !== 0) {
        const status = /\(HTTP (400|401|403|404|422)\)/.exec(stderr)?.[1];
        if (status) rejected = Number(status);
      }
      return { stdout, stderr: "", exitCode };
    });
    let posted: unknown;
    try {
      posted = await callGitHub(port, { method: "POST", path: `repos/${key.repo}/pulls/${key.number}/reviews`, body: outbound });
    } catch (error) {
      if (rejected !== undefined || (error instanceof Error && error.message.startsWith("access:"))) {
        await unlink(receiptPath);
        // eslint-disable-next-line preserve-caught-error -- GitHub errors can contain private review bodies.
        if (rejected === 422) throw new Error("configuration: GitHub rejected this review. Check the verdict and inline comments. Authors cannot approve their own pull requests.");
        // eslint-disable-next-line preserve-caught-error -- GitHub errors can contain private review bodies.
        if (rejected !== undefined) throw new Error("permission: GitHub refused the review. Check the project's account and its permission to submit reviews.");
        throw error;
      }
      // eslint-disable-next-line preserve-caught-error -- GitHub subprocess errors may contain private response bodies.
      throw new Error("unavailable: Submission could not be confirmed. Check the pull request before sending another review.");
    }
    const publishedUrl = publicationLink(key, object(posted)?.id);
    if (!publishedUrl) {
      throw new Error("unavailable: Submission could not be confirmed. Check the pull request before sending another review.");
    }
    await writeFileAtomic(receiptPath, JSON.stringify({ url: publishedUrl }), { mode: 0o600 });
    return { ...state, savedAt, publishedUrl, canSubmit: false, blockedReason: "This review has already been published." };
  });
}
