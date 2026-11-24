import { createHash } from "node:crypto";
import { unlink } from "node:fs/promises";
import path from "node:path";
import { withFileLock, writeFileAtomic } from "../lib/fs";
import { boardGh, projectGithubConnection, verifyGithubBindingUnchanged, withCurrentGithubBinding, type GithubConnection } from "./board-github";
import { parseDiffHunks, type ReviewComment } from "./bot/post";
import { screenCommentBody } from "./bot/redaction";
import { verifyDeskSubject } from "./desk-run-service";
import { DeskRunStore } from "./desk-run-store";
import { PUBLICATION_RECEIPT, PUBLICATION_REQUEST_LIMIT, PUBLICATION_SKIPPED, type PublicationAnswer, type PublicationOptionId, type PublicationRequest, type PublicationSettings, type PublicationState } from "./desk-publication-types";
import type { DeskRunKey } from "./desk-run-types";
import { applyReviewOverlay, DESK_TEMPLATE_SELECTION, deskReportEvidence, deskReportFinding, deskReportRecommendation, projectReportSlots, projectReviewOverlay, renderDeskFinding,
  renderDeskReviewReport, reportFindingMetadata, reportTemplateFingerprint, scopedFile, type DeskReportFinding } from "./desk-review-report";
import { namedGithubEnvironment, reviewCommandOptions, reviewTool } from "./github-cli";
import { callGitHub, createGhPort, parseGhJson, renderRoundBlock } from "./pr-comments";
import { premiseHoldState } from "./premise";
import { buildRoundBlock, PUBLISHED_BODY_LIMIT, type ReviewEvent } from "./publish";
import { computeReadiness, failingItems } from "./readiness";
import { readRoundNumber } from "./round-record";
import type { ManagedReviewManifest } from "./types";
import { earlierRoundAttempts, newerRoundOf, type NewerRound } from "./update-round";
import { computeVerdict, premiseRecords, type VerdictFinding } from "./verdict";

const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const sha = /^[a-f\d]{40}$/i;
const eventFor: Record<PublicationSettings["verdict"], ReviewEvent> = {
  approve: "APPROVE", suggestions: "APPROVE", changes: "REQUEST_CHANGES", comment: "COMMENT",
};
type Draft = { settings: PublicationSettings; savedAt: string };
/** How many earlier attempts an update round looks through for a draft to take answers from. */
const answerSourceLimit = 8;
type Operation = PublicationRequest | { kind: "automatic"; id: string; settings: PublicationSettings };
type Receipt = { url?: string };
type Prepared = { state: PublicationState; comments: ReviewComment[]; publicationBody: string; discussion?: string };
type Subject = Awaited<ReturnType<typeof verifyDeskSubject>>;
type HeadMoved = NonNullable<PublicationState["headMoved"]>;
type PreviewCache = { key: string; expires: number; subject: Subject; placements?: [string, number[]][]; discussion?: string;
  /** GitHub's definitive answer for one current head: ahead of the reviewed head, or not (diverged, behind, identical). */
  headStatus?: { head: string; ahead: boolean } };
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
  request: Operation, revision: { baseSha: string; headSha: string }): Promise<PreviewCache> {
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

async function publicationDiscussion(cwd: string, key: DeskRunKey, auth: GithubConnection) {
  const base = `repos/${key.repo}`;
  const resources = [`pulls/${key.number}/reviews`, `pulls/${key.number}/comments`, `issues/${key.number}/comments`];
  const pages = await Promise.all(resources.map(resource => boardGh(cwd, [
    "api", "--hostname", "github.com", "--paginate", "--slurp", `${base}/${resource}?per_page=100`,
  ], auth)));
  return hash(pages);
}

/**
 * Whether the reviewed head is still in the pull request: GitHub reports the current head `ahead` of it.
 * Anything else (a force-push or rebase reports `diverged`, an older head `behind`) or any failed read, a transient
 * `unavailable:` included, keeps the refusal: posting `commit_id` for a commit outside the PR is never attempted, the
 * draft still saves locally, and a refresh asks again. A definitive status is cached per current head (T14 B5); a failed
 * read is not, so the next preview asks again.
 */
async function reviewedHeadInPull(cwd: string, key: DeskRunKey, auth: GithubConnection, cache: PreviewCache,
  reviewedHead: string, currentHead: string): Promise<boolean> {
  if (cache.headStatus?.head === currentHead) return cache.headStatus.ahead;
  let status: string;
  try {
    status = (await boardGh(cwd, ["api", "--hostname", "github.com",
      `repos/${key.repo}/compare/${reviewedHead}...${currentHead}?per_page=1`, "--jq", ".status"], auth)).trim();
  } catch {
    return false; // Fail closed, as described above.
  }
  if (!["ahead", "behind", "diverged", "identical"].includes(status)) return false;
  cache.headStatus = { head: currentHead, ahead: status === "ahead" };
  return status === "ahead";
}

/** The finding answers of the newest earlier attempt that saved a publication draft; never its other settings. */
async function earlierAnswers(directories: readonly string[]): Promise<Record<string, unknown> | undefined> {
  for (const directory of directories) {
    // An unreadable earlier draft only means nothing is pre-selected from it; the current draft does not depend on it.
    const earlier = await json<Draft>(directory, "publication-draft.json", draftLimit).catch(() => undefined);
    if (earlier) return object(object(object(earlier)?.settings)?.answers);
  }
}

/** The as-is variant's first body line: it names the reviewed commit and says the PR moved on. */
function headMovedLine(moved: HeadMoved): string {
  return `Reviewed commit \`${moved.reviewedHead}\`. The pull request has moved to \`${moved.currentHead}\` since; ` +
    "this review does not cover the newer commits.";
}

async function prepare(input: {
  cwd: string; directory: string; run: NonNullable<ReturnType<DeskRunStore["byId"]>>["run"];
  key: DeskRunKey; auth: GithubConnection; request: Operation; current: boolean; headMoved?: HeadMoved; cache: PreviewCache;
  /** The pull request is open on the reviewed base. */
  open: boolean;
  /** Earlier-round attempts of the same Review, newest first: an attempt without a draft of its own takes their answers. */
  earlier: readonly string[];
  /** A later round of the same Review exists: this attempt is superseded and is not published as is (T14 B6). */
  newerRound?: NewerRound | undefined;
}): Promise<Prepared> {
  const { cwd, directory, run, key, auth, request, current, open, headMoved, cache, earlier, newerRound } = input;
  const packageDir = path.join(directory, "package");
  const target = `https://github.com/${key.repo}/pull/${key.number}`;
  const manifest = await json<ManagedReviewManifest>(directory, "package/manifest.json", 2 * 1024 * 1024);
  if (manifest?.target?.ref.toLowerCase() !== target.toLowerCase() ||
      manifest.target.base !== run.baseSha || manifest.target.head !== run.headSha) {
    throw new Error("configuration: This review has no matching local package to publish.");
  }
  const [recorded, verdict, draft, receipt, skipped, { overlay, overlayWarning }, readiness, report] = await Promise.all([
    premiseRecords(packageDir), computeVerdict(packageDir),
    json<Draft>(directory, "publication-draft.json", draftLimit),
    json<Receipt>(directory, PUBLICATION_RECEIPT, 4096),
    scopedFile(directory, PUBLICATION_SKIPPED, 64),
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
  // An update round starts with the answers given to the same findings before; only answers, never the verdict or content.
  const savedAnswers: Record<string, unknown> | undefined = saved?.answers ?? await earlierAnswers(earlier);
  const selections = new Map<string, PublicationAnswer>();
  const selectedLabels = new Map<string, string>();
  for (const question of questions) {
    if (!savedAnswers || !Object.hasOwn(savedAnswers, question.id)) continue;
    const answer = savedAnswers[question.id];
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
  const discussion = overlay?.kind === "slots" && overlay.rereadDiscussion && (current || headMoved) &&
    (request.kind === "preview" || request.kind === "submit" || request.kind === "automatic")
    ? cache.discussion ?? await publicationDiscussion(cwd, key, auth) : undefined;
  if (discussion) cache.discussion = discussion;
  const verdictOverride = saved?.verdictOverride === undefined ? saved?.verdict ?? null : saved.verdictOverride;
  const settings: PublicationSettings = headMoved
    // The as-is variant is a Comment only, and the current diff cannot place lines on the reviewed commit.
    ? { inline: false, general: saved?.general ?? true, keryxTemplate: true, overlay: !!overlay,
      verdict: "comment", verdictOverride: "comment", answers }
    : { inline: saved?.inline ?? false, general: saved?.general ?? true, keryxTemplate: true,
      overlay: !!overlay, verdict: verdictOverride ?? deskReportRecommendation(complete, publishable), verdictOverride, answers };
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
  const slots = projectReportSlots(overlay, report, roundNumber, settings.verdict, !solo);
  const emptyOverlay = overlay?.kind === "slots" && Object.keys(slots).length === 0;
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
    slots,
    ...(settings.general && { refuted }),
    howRun: `${solo ? "Single reviewer" : "Review orchestrator"} · ${run.options?.mode === "auto" ? "Auto" : "Manual"}.${reported}`,
  });
  let body = applyReviewOverlay(summary, overlay);
  if (headMoved) body = `${headMovedLine(headMoved)}\n\n${body}`;
  const visibleBody = body;
  const round = buildRoundBlock({ body, round: roundNumber,
    reviewId: manifest.reviewId, reviewedHead: run.headSha, findings: settings.general ? inBody : [] });
  body += `\n\n${renderRoundBlock(round)}`;
  const marker = `<!-- keryx-desktop-review ${request.id} -->`;
  body += `\n\n${marker}`;
  const publishedUrl = receipt && (receipt.url ?? await findPreviousPublication(cwd, key, auth, marker));
  // A further push changes the current head, so it must make an earlier as-is preview stale.
  const digest = hash([request.id, key, run.headSha, settings, body, comments, questions, discussion,
    ...(headMoved ? [headMoved.currentHead] : [])]);
  const approval = eventFor[settings.verdict] === "APPROVE";
  const templateChanged = request.kind === "automatic" &&
    await json<string>(directory, DESK_TEMPLATE_SELECTION, 128) !== reportTemplateFingerprint(overlay);
  const blockedReason = publishedUrl ? "This review has already been published."
    : receipt ? "A previous submission has an unknown result. Check the pull request before sending another review."
    // A closed pull request or a changed base comes first: no round of this review can publish then (T16 B2).
    : !current && (!open || !headMoved && newerRound === undefined)
      ? "The pull request is closed or its revision moved. You can still save this draft locally."
    : !current && newerRound !== undefined ? supersededReason(newerRound)
    : answerLimitExceeded ? "This review has too many answers to submit together. Split the review into smaller runs."
    : !answered ? "Answer each finding question before publishing."
    : overlay?.kind === "slots" && !settings.general ? "Enable General comment to include the project report overlay."
    : request.kind === "automatic" && (headMoved || skipped || !complete || overlayWarning || emptyOverlay || templateChanged || overlay?.requiresApproval)
      ? "This review needs a publication decision in Desktop."
    : !englishReviewText([visibleBody, ...comments.map(comment => comment.body)].join("\n"))
      ? "GitHub reviews must be written in English. This draft contains non-English prose."
    : approval && !complete ? "A partial review cannot approve. Select Comment only or Request changes."
    : inlineUnavailable ? "The pull request diff is unavailable. Retry or turn off inline comments."
    : comments.length > 100 || body.length > PUBLISHED_BODY_LIMIT || comments.some(comment => comment.body.length > PUBLISHED_BODY_LIMIT)
      ? "This draft exceeds the GitHub review size limit. Change what is included or split the review."
    : !settings.general && !comments.length ? headMoved
      ? "Enable General comment. Inline comments are not available when publishing for an earlier commit."
      : "Enable General comment or select inline comments that are on the diff." : undefined;
  return { state: { version: 1, settings, body: visibleBody, inlineCount: comments.length, inlineComments: comments,
    questions: answerLimitExceeded ? [] : questions, overlayAvailable: !!overlay && !emptyOverlay,
    ...(overlay?.requiresApproval && { overlayRequiresApproval: true }),
    canSubmit: !blockedReason, digest, ...(blockedReason ? { blockedReason } : {}),
    ...(overlayWarning ? { overlayWarning } : emptyOverlay ? { overlayWarning: "This draft has no project overlay content. Only the Keryx template is shown." } : {}),
    ...(draft ? { savedAt: draft.savedAt } : {}), ...(publishedUrl ? { publishedUrl } : skipped ? { skipped: true } : {}),
    ...(headMoved && { headMoved }) },
    comments, publicationBody: body, ...(discussion && { discussion }) };
}

/** Why a superseded attempt is not published, in terms of what its newer round can do (T16 B1). */
function supersededReason({ round, status }: NewerRound): string {
  if (status === "running") return `Round ${round} of this review is still running. Publish from it when it finishes. You can still save this draft locally.`;
  if (status === "no-result") return `Round ${round} of this review is newer but has no result. Start a new round or save this draft locally.`;
  return `Round ${round} of this review is newer. Publish from that round. You can still save this draft locally.`;
}

function englishReviewText(body: string): boolean {
  // Ignore source quotations and identifiers. Generated prose is requested in English at review time.
  const prose = body.replace(/^`{3,}[^\n]*\n[\s\S]*?^`{3,}[^\n]*$/gm, "").replace(/`+[^`\n]+`+/g, "")
    .replace(/^\s*>.*$/gm, "").replace(/https?:\/\/\S+/g, "");
  return !/[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u.test(prose);
}

export function requestDeskPublication(cwd: string, key: DeskRunKey, request: PublicationRequest,
  confirmSubmit?: (state: PublicationState) => Promise<void>): Promise<PublicationState> {
  return publication(cwd, key, request, confirmSubmit);
}

export async function publishCompletedDeskReview(cwd: string, key: DeskRunKey, id: string): Promise<void> {
  await publication(cwd, key, { kind: "automatic", id, settings: {
    inline: false, general: true, keryxTemplate: true, overlay: true,
    verdict: "comment", verdictOverride: "comment", answers: {},
  } });
}

async function publication(cwd: string, key: DeskRunKey, request: Operation,
  confirmSubmit?: (state: PublicationState) => Promise<void>): Promise<PublicationState> {
  if (!uuid.test(request.id) || !/^[\w-]+\/[\w.-]+$/.test(key.repo) || !Number.isSafeInteger(key.number) || key.number < 1) {
    throw new Error("configuration: Invalid review publication target.");
  }
  const connection = await projectGithubConnection(cwd, process.env, key.viewer);
  const store = new DeskRunStore(undefined, true);
  const directory = store.directory(request.id);
  const { attempt, earlier, newerRound } = (() => {
    try {
      const found = store.byId(request.id);
      if (!found) return { attempt: found, earlier: [] as string[], newerRound: undefined };
      // One rule for the attempts before this round (update-round.ts): same Review, earlier rounds, not withdrawn. The
      // rules read placement only, so the lean query serves them without reports, receipts or transcripts (T16 B6).
      const placements = store.roundPlacements(found.key);
      return { attempt: found, newerRound: newerRoundOf(placements, found.run),
        earlier: earlierRoundAttempts(placements, found.run).slice(0, answerSourceLimit).map(item => store.directory(item.id)) };
    } finally { store.close(); }
  })();
  const run = attempt?.run;
  if (!attempt || !run?.result?.reviewed || run.source === "existing" ||
      (run.state !== "completed" && run.state !== "partial") ||
      (request.kind === "automatic" && (!run.options?.autoPublish || run.state !== "completed" || run.decision || attempt.cwd !== cwd)) ||
      attempt.key.number !== key.number || attempt.key.repositoryId !== key.repositoryId ||
      attempt.key.repo.toLowerCase() !== key.repo.toLowerCase() || attempt.key.viewer.toLowerCase() !== key.viewer.toLowerCase() ||
      !sha.test(run.baseSha) || !sha.test(run.headSha) ||
      run.result.reviewed.baseSha !== run.baseSha || run.result.reviewed.headSha !== run.headSha) {
    throw new Error("access: A verified local review for this account and pull request was not found.");
  }
  const cache = await previewSubject(cwd, directory, key, connection, request, run);
  const pr = cache.subject;
  const open = pr.state === "OPEN" && pr.baseRefOid === run.baseSha;
  const current = open && pr.headRefOid === run.headSha;
  // Automatic publication never posts the as-is variant, so it is refused before any further GitHub read.
  if (request.kind === "automatic" && open && !current) throw new Error("configuration: This review needs a publication decision in Desktop.");
  // Same base, a newer head that still contains the reviewed commit: the draft becomes the as-is Comment for it.
  // An attempt a later round of its Review superseded is never published as is: that round may already cover the new head.
  const headMoved: HeadMoved | undefined = open && !current && newerRound === undefined && sha.test(pr.headRefOid) &&
    await reviewedHeadInPull(cwd, key, connection, cache, run.headSha, pr.headRefOid)
    ? { reviewedHead: run.headSha, currentHead: pr.headRefOid } : undefined;
  // The write requires the PR exactly as rendered: the reviewed range, or the as-is variant's current head.
  const expected = headMoved ? { baseSha: run.baseSha, headSha: headMoved.currentHead } : run;
  const render = () => prepare({ cwd, directory, run, key, auth: connection, request, current, open, ...(headMoved && { headMoved }), cache, earlier, newerRound });
  if (request.kind === "preview") {
    const { state } = await render();
    verifyGithubBindingUnchanged(connection);
    return state;
  }
  return withFileLock(path.join(directory, "publication.lock"), async () => {
    const { state, comments, publicationBody, discussion } = await render();
    if (request.kind === "skip") {
      if (state.publishedUrl) return state;
      await writeFileAtomic(path.join(directory, PUBLICATION_SKIPPED), "true", { mode: 0o600 });
      return { ...state, skipped: true };
    }
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
    if (request.kind === "submit" && request.digest !== state.digest) throw new Error("stale: The review preview changed. Refresh it before submitting.");
    if (!state.canSubmit) throw new Error(`configuration: ${state.blockedReason}`);
    if (request.kind === "submit" && !confirmSubmit) throw new Error("permission: Confirm the exact review before publishing.");
    const outbound = { event: eventFor[state.settings.verdict], body: publicationBody, comments, commit_id: run.headSha };
    for (const body of [outbound.body, ...comments.map(comment => comment.body)]) {
      if (!(await screenCommentBody(cwd, body)).ok) {
        throw new Error("configuration: The security output check withheld this draft. Review the selected content before submitting.");
      }
    }
    if (request.kind === "submit") await confirmSubmit?.(state);
    await verifyDeskSubject(cwd, key, expected, connection);
    // Pin only after independently verifying the active viewer with the default connection.
    const auth: GithubConnection = connection.login ? connection : {
      ...connection, login: key.viewer, env: await namedGithubEnvironment(cwd, key.viewer, connection.env),
    };
    if (auth !== connection) await verifyDeskSubject(cwd, key, expected, auth);
    if (discussion && discussion !== await publicationDiscussion(cwd, key, auth)) {
      throw new Error("stale: The pull request discussion changed. Refresh the preview and check the draft before publishing.");
    }
    await save();
    const receiptPath = path.join(directory, PUBLICATION_RECEIPT);
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
    const { skipped: _skipped, ...published } = state;
    return { ...published, savedAt, publishedUrl, canSubmit: false, blockedReason: "This review has already been published." };
  });
}
