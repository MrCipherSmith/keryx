import { createHash } from "node:crypto";
import { unlink } from "node:fs/promises";
import path from "node:path";
import { withFileLock, writeFileAtomic } from "../lib/fs";
import { boardGh, projectGithubConnection, verifyGithubBindingUnchanged, withCurrentGithubBinding, type GithubConnection } from "./board-github";
import { parseDiffHunks, type ReviewComment } from "./bot/post";
import { screenCommentBody } from "./bot/redaction";
import { verifyDeskSubject } from "./desk-run-service";
import { DeskRunStore } from "./desk-run-store";
import { PUBLICATION_REQUEST_LIMIT, type PublicationAnswer, type PublicationOptionId, type PublicationRequest, type PublicationSettings, type PublicationState } from "./desk-publication-types";
import type { DeskRunKey } from "./desk-run-types";
import { applyReviewOverlay, deskReportEvidence, deskReportFinding, deskReportRecommendation, projectReviewOverlay, renderDeskFinding,
  renderDeskReviewReport, reportFindingMetadata, scopedFile, type DeskReportFinding } from "./desk-review-report";
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
const eventFor: Record<PublicationSettings["verdict"], ReviewEvent> = {
  approve: "APPROVE", suggestions: "APPROVE", changes: "REQUEST_CHANGES", comment: "COMMENT",
};
type Draft = { settings: PublicationSettings; savedAt: string };
type Receipt = { url?: string };
type Prepared = { state: PublicationState; comments: ReviewComment[]; publicationBody: string };
type Subject = Awaited<ReturnType<typeof verifyDeskSubject>>;
type PreviewCache = { key: string; expires: number; subject: Subject; placements?: [string, number[]][] };
const draftLimit = 3 * PUBLICATION_REQUEST_LIMIT;
const previewCacheLimit = 2 * PUBLICATION_REQUEST_LIMIT;
const previewCacheFile = "publication-preview-cache.json";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const object = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
const text = (v: unknown) => typeof v === "string" ? v.trim() : "";

async function json<T>(root: string, relative: string, limit: number): Promise<T | undefined> {
  const content = await scopedFile(root, relative, limit);
  return content === undefined ? undefined : JSON.parse(content) as T;
}

async function previewSubject(cwd: string, directory: string, key: DeskRunKey, auth: GithubConnection,
  request: PublicationRequest, revision: { baseSha: string; headSha: string }): Promise<PreviewCache> {
  const cacheKey = hash([cwd, key, revision, auth.binding, auth.env.GH_TOKEN, auth.env.GITHUB_TOKEN]);
  const cached = request.kind === "preview" && !request.refresh
    ? await json<PreviewCache>(directory, previewCacheFile, previewCacheLimit).catch(() => undefined) : undefined;
  const previous = cached?.key === cacheKey && cached.expires > Date.now() && cached.subject ? cached : undefined;
  // An unbound project can switch its effective gh account without a Keryx binding update.
  if (auth.login && previous) return previous;
  const subject = await verifyDeskSubject(cwd, key, undefined, auth);
  if (previous && previous.subject.baseRefOid === subject.baseRefOid && previous.subject.headRefOid === subject.headRefOid) {
    return { ...previous, subject };
  }
  return { key: cacheKey, expires: Date.now() + 15_000, subject };
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
  key: DeskRunKey; auth: GithubConnection; request: PublicationRequest; current: boolean; cache: PreviewCache;
}): Promise<Prepared> {
  const { cwd, directory, run, key, auth, request, current, cache } = input;
  const packageDir = path.join(directory, "package");
  const target = `https://github.com/${key.repo}/pull/${key.number}`;
  const manifest = await json<ManagedReviewManifest>(directory, "package/manifest.json", 2 * 1024 * 1024);
  if (manifest?.target?.ref.toLowerCase() !== target.toLowerCase() ||
      manifest.target.base !== run.baseSha || manifest.target.head !== run.headSha) {
    throw new Error("configuration: This review has no matching local package to publish.");
  }
  const [recorded, verdict, draft, receipt, { overlay, overlayWarning }, readiness, report] = await Promise.all([
    premiseRecords(packageDir), computeVerdict(packageDir),
    json<Draft>(directory, "publication-draft.json", draftLimit),
    json<Receipt>(directory, "publication-receipt.json", 4096),
    projectReviewOverlay(cwd), computeReadiness(packageDir), scopedFile(directory, "package/report.md", 2 * 1024 * 1024),
  ]);
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
  const metadata = reportFindingMetadata(report);
  const forReport = (entry: VerdictFinding) => deskReportFinding(entry, recordFor(entry), metadata.get(entry.id));
  const findings = [...verdict.open, ...verdict.minors, ...(verdict.info ?? [])].map(forReport);
  for (const entry of verdict.held) {
    const id = questionId(entry);
    const selectedAnswer = selectedLabels.get(id);
    if (selectedAnswer || selections.get(id) === "uphold") findings.push({
      ...forReport(entry), ...(selectedAnswer && { selectedAnswer }),
    });
  }
  const publishable = findings.filter(finding => finding.severity !== "info" || finding.question || finding.locationClass === "pr-process");
  const answered = questions.every(question => Object.hasOwn(answers, question.id));
  const failing = failingItems(readiness).filter(item =>
    item.id !== "premise-decisions" || !answered ||
    recorded.records.some(row => premiseHoldState(row, recorded.decisions) === "awaiting" && !Object.hasOwn(answers, text(row.global_id ?? row.id))));
  const complete = run.result?.coverage === "complete" && failing.length === 0;
  const verdictOverride = saved?.verdictOverride === undefined ? saved?.verdict ?? null : saved.verdictOverride;
  const settings: PublicationSettings = {
    inline: saved?.inline ?? false, general: saved?.general ?? true, keryxTemplate: true,
    overlay: !!overlay, verdict: verdictOverride ?? deskReportRecommendation(complete, publishable), verdictOverride, answers,
  };
  const largestAnswers = Object.fromEntries(questions.map(question => [question.id, question.options?.[0]?.id ?? "dismiss"]));
  const answerLimitExceeded = Buffer.byteLength(JSON.stringify({
    kind: "submit", id: request.id, settings: { ...settings, answers: largestAnswers }, digest: "0".repeat(64),
  })) > PUBLICATION_REQUEST_LIMIT;
  const comments: ReviewComment[] = [];
  const inBody: DeskReportFinding[] = [];
  const revision = { repo: key.repo, head: run.headSha };
  let inlineUnavailable = false;
  if (settings.inline && current && publishable.some(finding => finding.file && finding.line)) {
    try {
      let hunks: Map<string, Set<number>>;
      if (Array.isArray(cache.placements) && cache.placements.every(entry =>
        Array.isArray(entry) && typeof entry[0] === "string" && Array.isArray(entry[1]))) {
        hunks = new Map(cache.placements.map(([file, lines]) => [file, new Set(lines)]));
      }
      else {
        const diff = await boardGh(cwd, ["api", "--hostname", "github.com", "-H", "Accept: application/vnd.github.v3.diff",
          `repos/${key.repo}/pulls/${key.number}`], auth);
        hunks = parseDiffHunks(diff);
        if (request.kind === "preview") cache.placements = [...hunks].map(([file, lines]) => [file, [...lines]]);
      }
      for (const finding of publishable) {
        if (finding.file && finding.line && !finding.question && finding.locationClass !== "pre-existing" && finding.locationClass !== "pr-process" &&
            hunks.get(finding.file)?.has(finding.line)) {
          comments.push({ path: finding.file, line: finding.line, side: "RIGHT",
            body: renderDeskFinding({ ...finding, locationClass: "in-diff" }, revision) });
        } else inBody.push(finding);
      }
    } catch (error) {
      if (!(error instanceof Error && error.message.startsWith("unavailable:"))) throw error;
      inlineUnavailable = true;
      inBody.push(...publishable);
    }
  } else inBody.push(...publishable);
  if (request.kind === "preview") {
    const encoded = JSON.stringify(cache);
    if (Buffer.byteLength(encoded) <= previewCacheLimit) {
      await writeFileAtomic(path.join(directory, previewCacheFile), encoded, { mode: 0o600 }).catch(() => undefined);
    }
  }
  const roundNumber = readRoundNumber(packageDir) ?? 1;
  const solo = run.options?.orchestrator === false;
  const coverageNote = complete ? "" : solo
    ? "**Single-reviewer coverage.**"
    : `**Partial review.** Reviewer coverage or readiness is incomplete.${failing.length ? ` Open checks: ${failing.map(item => item.id).join(", ")}.` : ""}`;
  const reported = verdict.reportedReviewers.length ? ` Reviewers: ${verdict.reportedReviewers.join(", ")}.` : "";
  const refuted = recorded.records.flatMap(row => {
    const verification = object(row.verification);
    const evidence = text(verification?.evidence);
    return verification?.verdict === "refuted" && evidence && typeof row.id === "string"
      ? [{ id: row.id, decision: `Refuted — ${evidence}` }] : [];
  });
  for (const entry of verdict.held) {
    if (selections.get(questionId(entry)) === "dismiss") refuted.push({ id: entry.id, decision: "Dismissed by the operator." });
  }
  const summary = renderDeskReviewReport({
    ...revision, base: run.baseSha, round: roundNumber, verdict: settings.verdict,
    findings: settings.general ? publishable : publishable.filter(finding => !inBody.includes(finding)),
    bodyFindings: settings.general ? inBody : [], inlineCount: comments.length, omittedCount: settings.general ? 0 : inBody.length,
    evidenceLevel: deskReportEvidence(report), coverageNote,
    ...(settings.general && { refuted }),
    howRun: `${solo ? "Single reviewer" : "Review orchestrator"} · ${run.options?.mode === "auto" ? "Auto" : "Manual"}.${reported}`,
  });
  let body = applyReviewOverlay(summary, overlay);
  const visibleBody = body;
  const round = buildRoundBlock({ body, round: roundNumber,
    reviewId: manifest.reviewId, reviewedHead: run.headSha, findings: settings.general ? inBody : [] });
  body += `\n\n${renderRoundBlock(round)}`;
  const marker = `<!-- keryx-desktop-review ${request.id} -->`;
  body += `\n\n${marker}`;
  const publishedUrl = receipt && (receipt.url ?? await findPreviousPublication(cwd, key, auth, marker));
  const digest = hash([request.id, key, run.headSha, settings, body, comments, questions]);
  const approval = eventFor[settings.verdict] === "APPROVE";
  const blockedReason = publishedUrl ? "This review has already been published."
    : receipt ? "A previous submission has an unknown result. Check the pull request before sending another review."
    : !current ? "The pull request is closed or its revision moved. You can still save this draft locally."
    : answerLimitExceeded ? "This review has too many answers to submit together. Split the review into smaller runs."
    : !answered ? "Answer each finding question before publishing."
    : approval && !complete ? "A partial review cannot approve. Select Comment only or Request changes."
    : inlineUnavailable ? "The pull request diff is unavailable. Retry or turn off inline comments."
    : comments.length > 100 || body.length > PUBLISHED_BODY_LIMIT || comments.some(comment => comment.body.length > PUBLISHED_BODY_LIMIT)
      ? "This draft exceeds the GitHub review size limit. Change what is included or split the review."
    : !settings.general && !comments.length ? "Enable General comment or select inline comments that are on the diff." : undefined;
  return { state: { version: 1, settings, body: visibleBody, inlineCount: comments.length, inlineComments: comments,
    questions: answerLimitExceeded ? [] : questions, overlayAvailable: !!overlay,
    canSubmit: !blockedReason, digest, ...(blockedReason ? { blockedReason } : {}),
    ...(overlayWarning ? { overlayWarning } : {}),
    ...(draft ? { savedAt: draft.savedAt } : {}), ...(publishedUrl ? { publishedUrl } : {}) }, comments, publicationBody: body };
}

export async function requestDeskPublication(cwd: string, key: DeskRunKey, request: PublicationRequest,
  confirmSubmit?: (state: PublicationState) => Promise<void>): Promise<PublicationState> {
  if (!uuid.test(request.id) || !/^[\w-]+\/[\w.-]+$/.test(key.repo) || !Number.isSafeInteger(key.number) || key.number < 1) {
    throw new Error("configuration: Invalid review publication target.");
  }
  const connection = await projectGithubConnection(cwd, process.env, key.viewer);
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
  const cache = await previewSubject(cwd, directory, key, connection, request, run);
  const pr = cache.subject;
  const current = pr.state === "OPEN" && pr.baseRefOid === run.baseSha && pr.headRefOid === run.headSha;
  const render = () => prepare({ cwd, directory, run, key, auth: connection, request, current, cache });
  if (request.kind === "preview") {
    const { state } = await render();
    verifyGithubBindingUnchanged(connection);
    return state;
  }
  return withFileLock(path.join(directory, "publication.lock"), async () => {
    const { state, comments, publicationBody } = await render();
    const savedAt = new Date().toISOString();
    const draft: Draft = { settings: state.settings, savedAt };
    const encoded = JSON.stringify(draft);
    if (Buffer.byteLength(encoded) > draftLimit) throw new Error("configuration: The review settings are too large to save. Split the review.");
    const save = () => writeFileAtomic(path.join(directory, "publication-draft.json"), encoded, { mode: 0o600 });
    if (request.kind === "save") {
      verifyGithubBindingUnchanged(connection);
      await save();
      return { ...state, savedAt };
    }
    if (request.digest !== state.digest) throw new Error("stale: The review preview changed. Refresh it before submitting.");
    if (!state.canSubmit) throw new Error(`configuration: ${state.blockedReason}`);
    if (!confirmSubmit) throw new Error("permission: Confirm the exact review before publishing.");
    const outbound = { event: eventFor[state.settings.verdict], body: publicationBody, comments, commit_id: run.headSha };
    for (const body of [outbound.body, ...comments.map(comment => comment.body)]) {
      if (!(await screenCommentBody(cwd, body)).ok) {
        throw new Error("configuration: The security output check withheld this draft. Review the selected content before submitting.");
      }
    }
    await confirmSubmit(state);
    await verifyDeskSubject(cwd, key, run, connection);
    // Pin only after independently verifying the active viewer with the default connection.
    const auth: GithubConnection = connection.login ? connection : {
      ...connection, login: key.viewer, env: await namedGithubEnvironment(cwd, key.viewer, connection.env),
    };
    if (auth !== connection) await verifyDeskSubject(cwd, key, run, auth);
    await save();
    const receiptPath = path.join(directory, "publication-receipt.json");
    // Persist the intent before the network call. A lost response must not cause a duplicate review.
    await writeFileAtomic(receiptPath, "{}", { mode: 0o600 });
    const options = reviewCommandOptions(cwd, auth.env);
    let rejected: number | undefined;
    let postStarted = false;
    const port = createGhPort(async (argv, stdin) => {
      const proc = withCurrentGithubBinding(auth, () => Bun.spawn([reviewTool("gh", auth.env), "api", "--hostname", "github.com", ...argv.slice(2)], {
        cwd, env: options.env, stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
        stdout: "pipe", stderr: "pipe", signal: AbortSignal.timeout(options.timeout),
      }));
      postStarted = true;
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
      if (rejected !== undefined || !postStarted) {
        await unlink(receiptPath);
        // eslint-disable-next-line preserve-caught-error -- GitHub errors can contain private review bodies.
        if (rejected === 422) throw new Error("configuration: GitHub rejected this review. Check the verdict and inline comments. Authors cannot approve their own pull requests.");
        // eslint-disable-next-line preserve-caught-error -- GitHub errors can contain private review bodies.
        if (rejected !== undefined) throw new Error("permission: GitHub refused the review. Check the project's account and its permission to submit reviews.");
        if (error instanceof Error && /^(access|configuration):/.test(error.message)) throw error;
        // eslint-disable-next-line preserve-caught-error -- Subprocess errors can include private arguments.
        throw new Error("unavailable: GitHub CLI could not start. Retry when it is available.");
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
