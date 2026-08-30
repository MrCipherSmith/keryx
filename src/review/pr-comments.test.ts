// External PR comments: collected every round, answered once, and never posted
// from a test.
//
// Every GitHub interaction in this file goes through `createFixturePort`, which
// answers reads from in-memory JSON and records writes. Nothing here opens a
// socket, holds a token, or names a real pull request. That is not a convenience:
// the mechanism being tested is one whose failure mode is posting the wrong thing
// to a human's review thread, and a mechanism that can only be exercised against a
// live pull request is a mechanism that ships unexercised.
//
// Each test is written so it FAILS if its mechanism is removed. Where that is not
// obvious from the assertion, the comment says which line of the implementation
// would have to be deleted for the test to go green for the wrong reason.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { reviewCommand } from "../commands/review";
import { loadSchema, validateJson } from "../gdskills/contracts";
import { createManagedReviewPackage } from "./managed";
import { mergeVerifications } from "./verification";
import type { NormalizedReviewFinding, StructuredReviewFinding } from "./types";
import {
  applyExternalVerdictRule,
  assertOutwardBrevity,
  buildReplyPass,
  classifySeverity,
  collectPrComments,
  createFixturePort,
  DEFAULT_MAX_REPLIES_TOTAL,
  emptyPrCommentState,
  enforceReplyBrevity,
  externalFindingsFromComments,
  guardGitHubRequest,
  parseGhJson,
  partitionExternalFindings,
  postReplyPass,
  prCommentsStatePath,
  readPrCommentState,
  recordSeenComments,
  renderPrCommentsMarkdown,
  routeReply,
  splitSentences,
  unansweredComments,
  writePrCommentState,
  type CollectedComment,
  type CommentOutcome,
  type FixturePort,
  type PrCommentState,
} from "./pr-comments";

const REPO = "acme/app";
const PR = 7;

let ROOT = "";
const ORIGINAL_CWD = process.cwd();

afterEach(async () => {
  process.chdir(ORIGINAL_CWD);
  if (ROOT) {
    await rm(ROOT, { recursive: true, force: true });
    ROOT = "";
  }
});

async function fresh(): Promise<string> {
  ROOT = await mkdtemp(path.join(tmpdir(), "keryx-pr-comments-"));
  await mkdir(path.join(ROOT, ".metaproject"), { recursive: true });
  await mkdir(path.join(ROOT, "docs", "requirements", "managed-review-feedback-loop", "schemas"), {
    recursive: true,
  });
  await writeFile(
    path.join(
      ROOT,
      "docs",
      "requirements",
      "managed-review-feedback-loop",
      "schemas",
      "managed-review-package.schema.json",
    ),
    `{"type":"object"}`,
    "utf8",
  );
  return ROOT;
}

// ---------------------------------------------------------------------------
// Fixtures: what the three endpoints return
// ---------------------------------------------------------------------------

function user(login: string, type = "User"): Record<string, unknown> {
  return { login, type };
}

function fixtures(over: Partial<Record<string, unknown[]>> = {}): Record<string, unknown> {
  return {
    "pull-comments": over["pull-comments"] ?? [
      {
        id: 11,
        pull_request_review_id: 900,
        user: user("carol"),
        body: "This drops the error instead of surfacing it.",
        path: "src/a.ts",
        line: 42,
        html_url: "https://github.com/acme/app/pull/7#discussion_r11",
        created_at: "2026-08-01T10:00:00Z",
      },
      {
        id: 12,
        pull_request_review_id: 901,
        user: user("coderabbitai[bot]", "Bot"),
        body: "Nit: this loop reallocates on every iteration.",
        path: "src/b.ts",
        line: 8,
        html_url: "https://github.com/acme/app/pull/7#discussion_r12",
        created_at: "2026-08-01T10:05:00Z",
      },
      {
        id: 13,
        pull_request_review_id: 999,
        user: user("dave"),
        body: "Is this covered anywhere?",
        path: "src/c.ts",
        line: 3,
        html_url: "https://github.com/acme/app/pull/7#discussion_r13",
        created_at: "2026-08-01T10:06:00Z",
      },
    ],
    "pull-reviews": over["pull-reviews"] ?? [
      {
        id: 900,
        user: user("carol"),
        state: "CHANGES_REQUESTED",
        body: "Two problems, both in the error path.",
        html_url: "https://github.com/acme/app/pull/7#pullrequestreview-900",
        submitted_at: "2026-08-01T10:00:00Z",
      },
      {
        id: 901,
        user: user("coderabbitai[bot]", "Bot"),
        state: "COMMENTED",
        body: "",
        html_url: "https://github.com/acme/app/pull/7#pullrequestreview-901",
        submitted_at: "2026-08-01T10:05:00Z",
      },
    ],
    "issue-comments": over["issue-comments"] ?? [
      {
        id: 21,
        user: user("erin"),
        body: "Please rebase before merging.",
        html_url: "https://github.com/acme/app/pull/7#issuecomment-21",
        created_at: "2026-08-01T11:00:00Z",
      },
      {
        id: 22,
        user: user("keryx-bot"),
        body: "Fixed in abc123.",
        html_url: "https://github.com/acme/app/pull/7#issuecomment-22",
        created_at: "2026-08-01T11:30:00Z",
      },
    ],
  };
}

function collect(port: FixturePort, over: { self?: string; handled?: PrCommentState["handled_comments"] } = {}) {
  return collectPrComments({
    port,
    repo: REPO,
    number: PR,
    self: over.self ?? "keryx-bot",
    handled: over.handled,
  });
}

// ---------------------------------------------------------------------------
// AC8 — collection from all three sources, bots identical to humans
// ---------------------------------------------------------------------------

describe("AC8 collection", () => {
  test("all three sources are read, each exactly once", async () => {
    const port = createFixturePort(fixtures());
    await collect(port);
    expect(port.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      `GET repos/${REPO}/pulls/${PR}/comments`,
      `GET repos/${REPO}/pulls/${PR}/reviews`,
      `GET repos/${REPO}/issues/${PR}/comments`,
    ]);
  });

  test("a bot's comment is collected exactly like a human's", async () => {
    const result = await collect(createFixturePort(fixtures()));
    const bot = result.comments.find((comment) => comment.id === "review-comment:12");
    const human = result.comments.find((comment) => comment.id === "review-comment:11");
    expect(bot).toBeDefined();
    expect(human).toBeDefined();
    expect(bot?.authorIsBot).toBe(true);
    // The flag is RECORDED and never filtered on. If a filter is ever added, this
    // is the assertion that goes red: the bot comment simply would not be here.
    expect(result.counts.bots).toBe(1);
    expect(result.skipped.some((skip) => skip.id === "review-comment:12")).toBe(false);
  });

  test("our own comment is excluded, and the exclusion is recorded rather than silent", async () => {
    const result = await collect(createFixturePort(fixtures()));
    expect(result.comments.some((comment) => comment.id === "issue-comment:22")).toBe(false);
    const skip = result.skipped.find((entry) => entry.id === "issue-comment:22");
    expect(skip?.reason).toBe("self-authored");
    expect(skip?.detail).toContain("keryx-bot");
  });

  test("`self` bot-suffix and case differences still resolve to us", async () => {
    const result = await collect(createFixturePort(fixtures()), { self: "KERYX-BOT[bot]" });
    expect(result.comments.some((comment) => comment.id === "issue-comment:22")).toBe(false);
  });

  test("collecting with no identity is refused, not defaulted", async () => {
    await expect(collect(createFixturePort(fixtures()), { self: "  " })).rejects.toThrow(
      /answers itself every round/,
    );
  });

  test("a review submission with an empty body is recorded as skipped, not dropped in silence", async () => {
    const result = await collect(createFixturePort(fixtures()));
    const skip = result.skipped.find((entry) => entry.id === "review:901");
    expect(skip?.reason).toBe("empty-body");
    expect(result.comments.some((comment) => comment.id === "review:901")).toBe(false);
  });

  test("a review submission WITH a body is a comment in its own right", async () => {
    const result = await collect(createFixturePort(fixtures()));
    const review = result.comments.find((comment) => comment.id === "review:900");
    expect(review?.source).toBe("review");
    expect(review?.threadId).toBeNull();
  });

  test("counts report every source, so an empty result can be told from an unread one", async () => {
    const result = await collect(createFixturePort(fixtures()));
    expect(result.counts.reviewComments).toBe(3);
    expect(result.counts.reviews).toBe(2);
    expect(result.counts.issueComments).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// AC8 — already-handled, and reopening
// ---------------------------------------------------------------------------

describe("AC8 handled and reopened", () => {
  const handled = (over: Partial<PrCommentState["handled_comments"][number]> = {}) => [
    {
      id: "review-comment:11",
      thread_id: "11",
      author: "carol",
      url: "https://github.com/acme/app/pull/7#discussion_r11",
      first_seen_round: 1,
      handled_at: "2026-08-01T12:00:00Z",
      sha: "abc123",
      disposition: "acted-on" as const,
      reply_url: "https://github.com/acme/app/pull/7#discussion_r99",
      via: "thread-reply" as const,
      ...over,
    },
  ];

  test("a handled comment is excluded, with the reason and the earlier reply named", async () => {
    const result = await collect(createFixturePort(fixtures()), { handled: handled() });
    expect(result.comments.some((comment) => comment.id === "review-comment:11")).toBe(false);
    const skip = result.skipped.find((entry) => entry.id === "review-comment:11");
    expect(skip?.reason).toBe("already-handled");
    expect(skip?.detail).toContain("discussion_r99");
  });

  test("a newer reply from someone else makes a handled comment new again", async () => {
    const withReply = fixtures({
      "pull-comments": [
        ...(fixtures()["pull-comments"] as unknown[]),
        {
          id: 14,
          in_reply_to_id: 11,
          pull_request_review_id: 900,
          user: user("carol"),
          body: "That did not address it.",
          path: "src/a.ts",
          line: 42,
          html_url: "https://github.com/acme/app/pull/7#discussion_r14",
          created_at: "2026-08-01T13:00:00Z",
        },
      ],
    });
    const result = await collect(createFixturePort(withReply), { handled: handled() });
    const reopened = result.comments.find((comment) => comment.id === "review-comment:11");
    expect(reopened?.reopened).toBe(true);
    expect(result.counts.reopened).toBe(1);
  });

  test("a newer reply from US does not reopen anything", async () => {
    const withOurReply = fixtures({
      "pull-comments": [
        ...(fixtures()["pull-comments"] as unknown[]),
        {
          id: 15,
          in_reply_to_id: 11,
          pull_request_review_id: 900,
          user: user("keryx-bot"),
          body: "Fixed in abc123.",
          path: "src/a.ts",
          line: 42,
          html_url: "https://github.com/acme/app/pull/7#discussion_r15",
          created_at: "2026-08-01T13:00:00Z",
        },
      ],
    });
    // Without the self-filter running BEFORE the reopen check, our own reply
    // would reopen the comment we just answered — a loop that answers forever.
    const result = await collect(createFixturePort(withOurReply), { handled: handled() });
    expect(result.comments.some((comment) => comment.id === "review-comment:11")).toBe(false);
    expect(result.counts.reopened).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AC9 — severity classified, never invented
// ---------------------------------------------------------------------------

describe("AC9 severity classification", () => {
  test("a comment on a CHANGES_REQUESTED review starts at major", async () => {
    const result = await collect(createFixturePort(fixtures()));
    const comment = result.comments.find((entry) => entry.id === "review-comment:11");
    expect(comment?.severity).toBe("major");
    expect(comment?.severityBasis).toBe("changes-requested");
  });

  test("everything else starts at minor", async () => {
    const result = await collect(createFixturePort(fixtures()));
    expect(result.comments.find((entry) => entry.id === "review-comment:12")?.severity).toBe("minor");
    expect(result.comments.find((entry) => entry.id === "issue-comment:21")?.severity).toBe("minor");
  });

  test("a comment we cannot classify is kept at the floor and SAYS it was not classified", async () => {
    // `review-comment:13` names review 999, which is not in the reviews list.
    const result = await collect(createFixturePort(fixtures()));
    const orphan = result.comments.find((entry) => entry.id === "review-comment:13");
    expect(orphan).toBeDefined();
    expect(orphan?.severity).toBe("minor");
    expect(orphan?.severityBasis).toBe("unclassified");
    expect(orphan?.severityDetail).toContain("NOT dropped");
    expect(result.counts.unclassified).toBe(1);
  });

  test("a derived minor and a defaulted minor are distinguishable", () => {
    const derived = classifySeverity({ source: "review-comment", state: "APPROVED", stateKnown: true, reviewId: "1" });
    const defaulted = classifySeverity({ source: "review-comment", state: null, stateKnown: false, reviewId: "1" });
    expect(derived.severity).toBe(defaulted.severity);
    // Same severity, different claim. A record that could not tell these apart is
    // the `dismissed-out-of-scope: 0` failure wearing a new field's name.
    expect(derived.basis).not.toBe(defaulted.basis);
  });

  test("an undocumented review state is unclassified rather than assumed benign", () => {
    const odd = classifySeverity({ source: "review", state: "SOMETHING_NEW", stateKnown: true, reviewId: "3" });
    expect(odd.basis).toBe("unclassified");
    expect(odd.severity).toBe("minor");
  });
});

// ---------------------------------------------------------------------------
// AC9 — conversion to findings
// ---------------------------------------------------------------------------

describe("AC9 conversion", () => {
  test("each comment becomes a finding with source external and a complete external_ref", async () => {
    const result = await collect(createFixturePort(fixtures()));
    const findings = externalFindingsFromComments(result.comments);
    expect(findings.length).toBe(result.comments.length);
    const first = findings[0] as StructuredReviewFinding;
    expect(first.source).toBe("external");
    expect(first.external_ref).toEqual({
      id: "review-comment:11",
      author: "carol",
      url: "https://github.com/acme/app/pull/7#discussion_r11",
      path: "src/a.ts",
      line: 42,
      thread_id: "11",
      submitted_at: "2026-08-01T10:00:00Z",
    });
    expect(first.reviewer).toBe("carol");
    expect(first.dedupe_key).toBe("external:review-comment:11");
  });

  test("nothing is invented in the fix field", async () => {
    const result = await collect(createFixturePort(fixtures()));
    const findings = externalFindingsFromComments(result.comments);
    expect((findings[0] as StructuredReviewFinding).suggested_fix).toStartWith("not recorded:");
  });

  test("every produced finding satisfies review-finding.schema.json", async () => {
    const result = await collect(createFixturePort(fixtures()));
    const findings = externalFindingsFromComments(result.comments);
    const schema = await loadSchema("review-finding");
    for (const finding of findings) {
      expect(await validateJson(finding, schema)).toEqual([]);
    }
  });

  test("the contract requires external_ref once source says external", async () => {
    const schema = await loadSchema("review-finding");
    const result = await collect(createFixturePort(fixtures()));
    const finding = { ...(externalFindingsFromComments(result.comments)[0] as StructuredReviewFinding) };
    delete finding.external_ref;
    const errors = await validateJson(finding, schema);
    expect(errors.some((error) => error.path.includes("external_ref"))).toBe(true);
  });

  test("a major carries a class_scope that states what was NOT enumerated", async () => {
    const result = await collect(createFixturePort(fixtures()));
    const major = externalFindingsFromComments(result.comments).find((finding) => finding.severity === "major");
    expect(major?.class_scope?.sites).toEqual(["src/a.ts:42"]);
    expect(major?.class_scope?.enumeration_method).toContain("no class enumeration was performed");
  });

  test("a body longer than the record budget is truncated visibly, never silently", async () => {
    const long = "x".repeat(2000);
    const findings = externalFindingsFromComments([comment({ body: long })]);
    expect((findings[0] as StructuredReviewFinding).problem).toContain("[truncated at 800 characters");
  });
});

function comment(over: Partial<CollectedComment> = {}): CollectedComment {
  return {
    id: "review-comment:11",
    source: "review-comment",
    author: "carol",
    authorIsBot: false,
    url: "https://github.com/acme/app/pull/7#discussion_r11",
    body: "This drops the error.",
    path: "src/a.ts",
    line: 42,
    threadId: "11",
    submittedAt: "2026-08-01T10:00:00Z",
    reviewState: "CHANGES_REQUESTED",
    severity: "major",
    severityBasis: "changes-requested",
    severityDetail: "attached to a review whose state is CHANGES_REQUESTED",
    reopened: false,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// AC10 — the verifier cannot refute an external finding
// ---------------------------------------------------------------------------

describe("AC10 external findings and the verifier", () => {
  function externalFinding(over: Partial<NormalizedReviewFinding> = {}): NormalizedReviewFinding {
    return {
      id: "EXT-001",
      global_id: "r1#EXT-001",
      reviewer: "carol",
      severity: "minor",
      problem: "This drops the error.",
      impact: "raised on the PR",
      suggested_fix: "not recorded",
      evidence: "review-comment:11",
      confidence: "high",
      source: "external",
      external_ref: {
        id: "review-comment:11",
        author: "carol",
        url: "https://x/1",
        submitted_at: "2026-08-01T10:00:00Z",
      },
      summary: "This drops the error.",
      classification: "valid_followup",
      flow_relevance: "post_flow_feedback",
      ...over,
    };
  }

  function internalFinding(): NormalizedReviewFinding {
    return {
      id: "F-001",
      global_id: "r1#F-001",
      reviewer: "review-logic",
      severity: "minor",
      problem: "off-by-one",
      impact: "wrong count",
      suggested_fix: "use <=",
      evidence: "src/x.ts:3",
      confidence: "medium",
      summary: "off-by-one",
      classification: "valid_followup",
      flow_relevance: "standalone_review",
    };
  }

  const refutation = (finding: string) => ({
    finding,
    verdict: "refuted",
    method: "execution",
    evidence: "ran `bun test src/x.test.ts`; the described failure does not occur",
    verifier: "review-verifier",
  });

  test("in filter mode an external finding is put back, with answered-disagree", () => {
    const merged = mergeVerifications([externalFinding(), internalFinding()], [refutation("r1#EXT-001"), refutation("r1#F-001")], {
      mode: "filter",
    });
    expect(merged.refuted.map((finding) => finding.id).sort()).toEqual(["EXT-001", "F-001"]);

    const { result, reclaimed } = applyExternalVerdictRule(merged);
    expect(result.refuted.map((finding) => finding.id)).toEqual(["F-001"]);
    const back = result.retained.find((finding) => finding.id === "EXT-001");
    expect(back?.disposition?.state).toBe("answered-disagree");
    expect(back?.disposition?.evidence).toContain("still owed to carol");
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]?.removed).toBe(true);
  });

  test("the counts move with the finding, so the record does not claim a removal that did not happen", () => {
    const merged = mergeVerifications([externalFinding()], [refutation("r1#EXT-001")], { mode: "filter" });
    expect(merged.counts.findingsRefuted).toBe(1);
    const { result } = applyExternalVerdictRule(merged);
    expect(result.counts.findingsRefuted).toBe(0);
    expect(result.counts.findingsRetained).toBe(merged.counts.findingsRetained + 1);
  });

  test("in annotate mode the verdict is kept and the disposition is still answered-disagree", () => {
    const merged = mergeVerifications([externalFinding()], [refutation("r1#EXT-001")], { mode: "annotate" });
    expect(merged.refuted).toHaveLength(0);
    const { result, reclaimed } = applyExternalVerdictRule(merged);
    const finding = result.retained[0] as NormalizedReviewFinding;
    expect(finding.verification?.verdict).toBe("refuted");
    expect(finding.disposition?.state).toBe("answered-disagree");
    expect(reclaimed[0]?.removed).toBe(false);
  });

  test("an internal refuted finding is untouched by the rule", () => {
    const merged = mergeVerifications([internalFinding()], [refutation("r1#F-001")], { mode: "filter" });
    const { result, reclaimed } = applyExternalVerdictRule(merged);
    expect(result.refuted).toHaveLength(1);
    expect(reclaimed).toHaveLength(0);
  });

  test("a confirmed verdict on an external finding writes no disposition", () => {
    const merged = mergeVerifications(
      [externalFinding()],
      [
        {
          finding: "r1#EXT-001",
          verdict: "confirmed",
          method: "execution",
          evidence: "reproduced",
          verifier: "review-verifier",
        },
      ],
      { mode: "filter" },
    );
    const { result } = applyExternalVerdictRule(merged);
    expect(result.retained[0]?.disposition).toBeUndefined();
  });

  test("answered-disagree is not a dismissal state", async () => {
    const { FINDING_DISMISSAL_STATES } = await import("./types");
    expect(FINDING_DISMISSAL_STATES).not.toContain("answered-disagree");
  });
});

// ---------------------------------------------------------------------------
// AC9 — the findings cap never truncates an external comment
// ---------------------------------------------------------------------------

test("AC9: the per-reviewer findings cap does not truncate external comments", async () => {
  const root = await fresh();
  const comments: CollectedComment[] = Array.from({ length: 6 }, (_, index) =>
    comment({
      id: `review-comment:${100 + index}`,
      body: `Problem ${index}.`,
      line: index + 1,
      url: `https://github.com/acme/app/pull/7#discussion_r${100 + index}`,
      threadId: String(100 + index),
    }),
  );
  const internal = Array.from({ length: 6 }, (_, index) => ({
    id: `F-${index}`,
    reviewer: "review-logic",
    severity: "minor" as const,
    problem: `internal ${index}`,
    impact: "x",
    suggested_fix: "y",
    evidence: "z",
    confidence: "medium" as const,
  }));

  const result = await createManagedReviewPackage({
    cwd: root,
    mode: "ingest",
    reviewId: "2026-08-30-pr-7",
    target: { kind: "pr", ref: "https://github.com/acme/app/pull/7" },
    reportText: "# Report",
    findings: [...internal, ...externalFindingsFromComments(comments)],
    maxFindingsPerReviewer: 2,
    now: new Date("2026-08-30T10:00:00Z"),
  });

  const written = JSON.parse(
    await readFile(path.join(root, result.path, "findings.json"), "utf8"),
  ) as StructuredReviewFinding[];
  const externals = written.filter((finding) => finding.source === "external");
  // The cap bit the internal reviewer (6 -> 2) and did not touch the six
  // comments. Remove the `partitionExternalFindings` call in `managed.ts` and
  // this drops to 2.
  expect(externals).toHaveLength(6);
  expect(written.filter((finding) => finding.reviewer === "review-logic")).toHaveLength(2);
  expect(result.caps.findings?.counts.truncated).toBe(4);
});

test("partitionExternalFindings splits on `source`, and absent reads as internal", () => {
  const split = partitionExternalFindings([
    { source: "external" } as StructuredReviewFinding,
    {} as StructuredReviewFinding,
    { source: "internal" } as StructuredReviewFinding,
  ]);
  expect(split.external).toHaveLength(1);
  expect(split.internal).toHaveLength(2);
});

// ---------------------------------------------------------------------------
// AC11 / AC18 — brevity, enforced in code
// ---------------------------------------------------------------------------

describe("AC11/AC18 brevity", () => {
  test("sentences are counted the way a reader counts them", () => {
    expect(splitSentences("Fixed.")).toHaveLength(1);
    expect(splitSentences("Fixed in abc123. Tests added.")).toHaveLength(2);
    expect(splitSentences("No terminator here")).toHaveLength(1);
  });

  test("a URL is not three sentences", () => {
    // The rule TELLS you to link. A counter that punished the link would make
    // the compliant reply the one that fails.
    expect(splitSentences("Recorded in the flow. See https://x.test/a.b.c/journal.md")).toHaveLength(2);
  });

  test("an abbreviation is not a sentence boundary", () => {
    expect(splitSentences("Not applicable here, e.g. in the parser. Recorded.")).toHaveLength(2);
    // `no.` must not swallow the stop at the end of a word ending in "no".
    expect(splitSentences("We moved it to the casino. Recorded.")).toHaveLength(2);
  });

  test("inline code containing a full stop is not a boundary", () => {
    expect(splitSentences("Renamed to `a.b.c` in the config. Done.")).toHaveLength(2);
  });

  test("a reply within budget is passed through unchanged", () => {
    const result = enforceReplyBrevity("Fixed in abc123. Test added.");
    expect(result.truncated).toBe(false);
    expect(result.body).toBe("Fixed in abc123. Test added.");
  });

  test("a reply over budget is CUT, not warned about", () => {
    const result = enforceReplyBrevity("One. Two. Three. Four.", {
      link: "https://x.test/flow/journal.md",
    });
    expect(result.truncated).toBe(true);
    expect(result.dropped).toEqual(["Three.", "Four."]);
    expect(result.body).toBe("One. Two. https://x.test/flow/journal.md");
    // The whole point: the long version is not reachable from this function's
    // return value, so nothing downstream can post it.
    expect(splitSentences(result.body).length).toBeLessThanOrEqual(2);
  });

  test("truncating with nowhere to point is refused", () => {
    expect(() => enforceReplyBrevity("One. Two. Three.")).toThrow(/no link/);
  });

  test("a fenced code block in a reply is refused: link, do not paste", () => {
    expect(() => enforceReplyBrevity("Fixed.\n```ts\nconst a = 1;\n```")).toThrow(/link, do not paste/);
  });

  test("an empty reply is refused: silence is not an acceptable outcome", () => {
    expect(() => enforceReplyBrevity("   ")).toThrow(/Refusing an empty/);
  });

  test("AC18: a long outward artifact without a link is refused; with a link it passes", () => {
    expect(() => assertOutwardBrevity("One. Two. Three.", { what: "PR body" })).toThrow(/no link/);
    expect(() =>
      assertOutwardBrevity("One. Two. Three. Detail: https://x.test/flow/journal.md", { what: "PR body" }),
    ).not.toThrow();
    expect(() =>
      assertOutwardBrevity("One. Two. Three. Detail: [journal](../journal.md)", { what: "PR body" }),
    ).not.toThrow();
  });

  test("the budget default is two", () => {
    expect(() => enforceReplyBrevity("One. Two. Three.", { link: "https://x/y" })).not.toThrow();
    expect(enforceReplyBrevity("One. Two. Three.", { link: "https://x/y" }).sentences).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// AC12 — never resolve or hide a thread we did not open
// ---------------------------------------------------------------------------

describe("AC12 the port cannot resolve anything", () => {
  test("the five allowed endpoints are allowed", () => {
    for (const path of [
      `repos/${REPO}/pulls/${PR}/comments`,
      `repos/${REPO}/pulls/${PR}/reviews`,
      `repos/${REPO}/issues/${PR}/comments`,
    ]) {
      expect(() => guardGitHubRequest({ method: "GET", path })).not.toThrow();
    }
    expect(() =>
      guardGitHubRequest({ method: "POST", path: `repos/${REPO}/pulls/${PR}/comments/11/replies` }),
    ).not.toThrow();
    expect(() => guardGitHubRequest({ method: "POST", path: `repos/${REPO}/issues/${PR}/comments` })).not.toThrow();
  });

  test("resolving, hiding and dismissing are unreachable through the port", () => {
    for (const path of [
      "graphql",
      `repos/${REPO}/pulls/${PR}/reviews/900/dismissals`,
      `repos/${REPO}/pulls/comments/11`,
      `repos/${REPO}/issues/comments/21`,
    ]) {
      expect(() => guardGitHubRequest({ method: "POST", path })).toThrow(/Resolving, hiding, minimising/);
    }
  });

  test("a read endpoint is not a write endpoint", () => {
    // The prefix-check trap: `.../pulls/7/comments` is a legal READ and must not
    // become a legal write just because a write path starts with it.
    expect(() => guardGitHubRequest({ method: "POST", path: `repos/${REPO}/pulls/${PR}/comments` })).toThrow();
    expect(() => guardGitHubRequest({ method: "GET", path: `repos/${REPO}/pulls/${PR}/comments/11/replies` })).toThrow();
  });

  test("the module's source contains no thread-resolving mutation", () => {
    // Belt and braces against a future edit that adds a second port bypassing
    // `guardGitHubRequest`. The names are the GraphQL mutations that would do it.
    const source = readFileSync(path.join(import.meta.dir, "pr-comments.ts"), "utf8");
    for (const forbidden of ["resolveReviewThread", "unresolveReviewThread", "minimizeComment"]) {
      // Allowed only inside the sentence explaining why they are absent.
      const occurrences = source.split(forbidden).length - 1;
      const inProse = source.split(`\`${forbidden}\``).length - 1;
      expect(occurrences).toBe(inProse);
    }
  });

  test("a whole reply pass issues only allowed writes", async () => {
    const root = await fresh();
    const port = createFixturePort(fixtures());
    const collected = await collect(port);
    const pass = buildReplyPass({
      repo: REPO,
      number: PR,
      comments: collected.comments,
      outcomes: everyCommentAnswered(collected.comments),
    });
    await postReplyPass({
      port,
      cwd: root,
      repo: REPO,
      number: PR,
      pass,
      sha: "abc123",
      round: { index: 3, isFinal: true },
      state: emptyPrCommentState(REPO, PR),
      now: new Date("2026-08-30T12:00:00Z"),
    });
    for (const post of port.posts) {
      expect(() => guardGitHubRequest(post)).not.toThrow();
    }
  });
});

function everyCommentAnswered(comments: readonly CollectedComment[]): CommentOutcome[] {
  return comments.map((entry) => ({
    comment: entry.id,
    disposition: "acted-on" as const,
    text: "Fixed in abc123.",
  }));
}

// ---------------------------------------------------------------------------
// AC11 — replies go in the thread, and once, at the end
// ---------------------------------------------------------------------------

describe("AC11 routing and timing", () => {
  test("an inline comment is answered inside its own thread", () => {
    const routed = routeReply(REPO, PR, comment({ threadId: "11" }));
    expect(routed.mode).toBe("thread-reply");
    expect(routed.endpoint).toBe(`repos/${REPO}/pulls/${PR}/comments/11/replies`);
  });

  test("a reply lands on the thread ROOT, not on the reply it answers", () => {
    // `in_reply_to_id` points at the first comment of the thread; posting to the
    // last comment's id is a 404 on a real PR and an orphan thread in the best case.
    const routed = routeReply(REPO, PR, comment({ id: "review-comment:14", threadId: "11" }));
    expect(routed.endpoint).toContain("/comments/11/replies");
  });

  test("a review submission and a PR comment become one top-level comment, with the reason recorded", () => {
    const review = routeReply(REPO, PR, comment({ source: "review", threadId: null }));
    expect(review.mode).toBe("issue-comment");
    expect(review.reason).toContain("no reply endpoint for a review");
    const issue = routeReply(REPO, PR, comment({ source: "issue-comment", threadId: null }));
    expect(issue.endpoint).toBe(`repos/${REPO}/issues/${PR}/comments`);
  });

  test("a non-final round is refused", async () => {
    const root = await fresh();
    const port = createFixturePort(fixtures());
    const collected = await collect(port);
    const pass = buildReplyPass({
      repo: REPO,
      number: PR,
      comments: collected.comments,
      outcomes: everyCommentAnswered(collected.comments),
    });
    await expect(
      postReplyPass({
        port,
        cwd: root,
        repo: REPO,
        number: PR,
        pass,
        sha: "abc123",
        round: { index: 2, isFinal: false },
        state: emptyPrCommentState(REPO, PR),
      }),
    ).rejects.toThrow(/answered ONCE/);
    expect(port.posts).toHaveLength(0);
  });

  test("a dry run plans every request and posts nothing", async () => {
    const root = await fresh();
    const port = createFixturePort(fixtures());
    const collected = await collect(port);
    const pass = buildReplyPass({
      repo: REPO,
      number: PR,
      comments: collected.comments,
      outcomes: everyCommentAnswered(collected.comments),
    });
    const result = await postReplyPass({
      port,
      cwd: root,
      repo: REPO,
      number: PR,
      pass,
      sha: "abc123",
      round: { index: 3, isFinal: true },
      state: emptyPrCommentState(REPO, PR),
      dryRun: true,
    });
    expect(result.requests).toHaveLength(collected.comments.length);
    expect(port.posts).toHaveLength(0);
    expect(result.posted).toHaveLength(0);
  });

  test("a top-level reply names what it answers, and the anchor costs no sentence", async () => {
    const root = await fresh();
    const port = createFixturePort(fixtures());
    const collected = await collect(port);
    const review = collected.comments.find((entry) => entry.id === "review:900") as CollectedComment;
    const pass = buildReplyPass({
      repo: REPO,
      number: PR,
      comments: [review],
      outcomes: [{ comment: review.id, disposition: "acted-on", text: "Fixed in abc123." }],
    });
    await postReplyPass({
      port,
      cwd: root,
      repo: REPO,
      number: PR,
      pass,
      sha: "abc123",
      round: { index: 1, isFinal: true },
      state: emptyPrCommentState(REPO, PR),
    });
    const body = (port.posts[0]?.body as { body: string }).body;
    expect(body).toContain("pullrequestreview-900");
    expect(body).toContain("Fixed in abc123.");
  });
});

// ---------------------------------------------------------------------------
// AC13 — one reply, one disposition, idempotent across a restart
// ---------------------------------------------------------------------------

describe("AC13 exactly one reply per comment", () => {
  test("a comment nobody decided about stops the pass", async () => {
    const collected = await collect(createFixturePort(fixtures()));
    expect(() =>
      buildReplyPass({
        repo: REPO,
        number: PR,
        comments: collected.comments,
        outcomes: everyCommentAnswered(collected.comments).slice(1),
      }),
    ).toThrow(/nobody decided about/);
  });

  test("two outcomes for one comment are refused", async () => {
    const collected = await collect(createFixturePort(fixtures()));
    const outcomes = everyCommentAnswered(collected.comments);
    expect(() =>
      buildReplyPass({
        repo: REPO,
        number: PR,
        comments: collected.comments,
        outcomes: [...outcomes, outcomes[0] as CommentOutcome],
      }),
    ).toThrow(/second reply saying the same thing/);
  });

  test("`unknown` is refused as an outcome", async () => {
    const collected = await collect(createFixturePort(fixtures()));
    const first = collected.comments[0] as CollectedComment;
    expect(() =>
      buildReplyPass({
        repo: REPO,
        number: PR,
        comments: [first],
        outcomes: [{ comment: first.id, disposition: "unknown", text: "Nothing changed." }],
      }),
    ).toThrow(/an external comment ends in one of/);
  });

  test("a round that changed nothing still replies, with a terminal disposition", async () => {
    const root = await fresh();
    const port = createFixturePort(fixtures());
    const collected = await collect(port);
    const first = collected.comments[0] as CollectedComment;
    const pass = buildReplyPass({
      repo: REPO,
      number: PR,
      comments: [first],
      outcomes: [
        {
          comment: first.id,
          disposition: "dismissed-out-of-scope",
          text: "Not changed in this flow; recorded as out of scope.",
          link: "https://x.test/flow/journal.md",
        },
      ],
    });
    const result = await postReplyPass({
      port,
      cwd: root,
      repo: REPO,
      number: PR,
      pass,
      sha: "abc123",
      round: { index: 4, isFinal: true },
      state: emptyPrCommentState(REPO, PR),
    });
    expect(result.posted).toHaveLength(1);
    expect(result.state.handled_comments[0]?.disposition).toBe("dismissed-out-of-scope");
  });

  test("the second run after a session restart posts nothing", async () => {
    const root = await fresh();
    const port = createFixturePort(fixtures());
    const collected = await collect(port);
    const pass = buildReplyPass({
      repo: REPO,
      number: PR,
      comments: collected.comments,
      outcomes: everyCommentAnswered(collected.comments),
    });
    const first = await postReplyPass({
      port,
      cwd: root,
      repo: REPO,
      number: PR,
      pass,
      sha: "abc123",
      round: { index: 3, isFinal: true },
      state: emptyPrCommentState(REPO, PR),
      now: new Date("2026-08-30T12:00:00Z"),
    });
    expect(first.posted).toHaveLength(collected.comments.length);
    const postedFirstRun = port.posts.length;

    // The restart. Nothing from the first run is carried in memory: the state is
    // re-read from disk, exactly as a resumed session would.
    const reread = await readPrCommentState(root, REPO, PR);
    expect(reread.handled_comments).toHaveLength(collected.comments.length);
    const second = await postReplyPass({
      port,
      cwd: root,
      repo: REPO,
      number: PR,
      pass,
      sha: "abc123",
      round: { index: 3, isFinal: true },
      state: reread,
      now: new Date("2026-08-30T13:00:00Z"),
    });
    expect(second.posted).toHaveLength(0);
    expect(second.skipped).toHaveLength(collected.comments.length);
    expect(port.posts).toHaveLength(postedFirstRun);
  });

  test("a crash mid-pass leaves the posted replies recorded, and the rerun finishes the rest", async () => {
    const root = await fresh();
    const readPort = createFixturePort(fixtures());
    const collected = await collect(readPort);
    const pass = buildReplyPass({
      repo: REPO,
      number: PR,
      comments: collected.comments,
      outcomes: everyCommentAnswered(collected.comments),
    });

    let posts = 0;
    const flaky = {
      async request(request: Parameters<FixturePort["request"]>[0]): Promise<unknown> {
        if (request.method === "POST") {
          posts += 1;
          if (posts === 2) {
            throw new Error("network died");
          }
          return { id: posts, html_url: `https://x.test/reply/${posts}` };
        }
        return [];
      },
    };

    await expect(
      postReplyPass({
        port: flaky,
        cwd: root,
        repo: REPO,
        number: PR,
        pass,
        sha: "abc123",
        round: { index: 3, isFinal: true },
        state: emptyPrCommentState(REPO, PR),
      }),
    ).rejects.toThrow("network died");

    // Written after EVERY post, not once at the end: the first reply is on disk.
    // Remove that write and this reads 0 — and the rerun answers everyone twice.
    const afterCrash = await readPrCommentState(root, REPO, PR);
    expect(afterCrash.handled_comments).toHaveLength(1);

    const finishing = createFixturePort(fixtures());
    const second = await postReplyPass({
      port: finishing,
      cwd: root,
      repo: REPO,
      number: PR,
      pass,
      sha: "abc123",
      round: { index: 3, isFinal: true },
      state: afterCrash,
    });
    expect(second.posted).toHaveLength(collected.comments.length - 1);
    expect(second.skipped).toHaveLength(1);
  });

  test("the durable record carries every property the criterion names", async () => {
    const root = await fresh();
    const port = createFixturePort(fixtures());
    const collected = await collect(port);
    let state = emptyPrCommentState(REPO, PR);
    state = recordSeenComments(state, collected.comments, 1, "keryx-bot");
    const pass = buildReplyPass({
      repo: REPO,
      number: PR,
      comments: collected.comments,
      outcomes: everyCommentAnswered(collected.comments),
    });
    const result = await postReplyPass({
      port,
      cwd: root,
      repo: REPO,
      number: PR,
      pass,
      sha: "deadbee",
      round: { index: 5, isFinal: true },
      state,
      now: new Date("2026-08-30T12:00:00Z"),
    });
    const entry = result.state.handled_comments[0];
    expect(Object.keys(entry ?? {}).sort()).toEqual(
      ["author", "disposition", "first_seen_round", "handled_at", "id", "reply_url", "sha", "thread_id", "url", "via"].sort(),
    );
    // `first_seen_round` comes from the round that SAW it, not the round that
    // answered it. Recomputing it here would say everything arrived last.
    expect(entry?.first_seen_round).toBe(1);
    expect(entry?.sha).toBe("deadbee");
    expect(entry?.handled_at).toBe("2026-08-30T12:00:00.000Z");
  });

  test("state lives under .metaproject/reviews and never inside a flow", async () => {
    const root = await fresh();
    const file = prCommentsStatePath(root, REPO, PR);
    expect(path.relative(root, file)).toBe(path.join(".metaproject", "reviews", "pr-comments", "acme__app__7.json"));
    await writePrCommentState(root, emptyPrCommentState(REPO, PR));
    expect(JSON.parse(await readFile(file, "utf8")).schemaVersion).toBe(1);
  });

  test("unansweredComments answers the completion gate's question from disk", async () => {
    const collected = await collect(createFixturePort(fixtures()));
    let state = recordSeenComments(emptyPrCommentState(REPO, PR), collected.comments, 1);
    expect(unansweredComments(state).map((entry) => entry.id).sort()).toEqual(
      collected.comments.map((entry) => entry.id).sort(),
    );
    state = {
      ...state,
      handled_comments: collected.comments.map((entry) => ({
        id: entry.id,
        thread_id: entry.threadId,
        author: entry.author,
        url: entry.url,
        first_seen_round: 1,
        handled_at: "2026-08-30T12:00:00Z",
        sha: "abc",
        disposition: "acted-on" as const,
        reply_url: "https://x/1",
        via: "thread-reply" as const,
      })),
    };
    expect(unansweredComments(state)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// AC11 — the reply cap
// ---------------------------------------------------------------------------

describe("AC11 the reply cap reports its backlog", () => {
  const many = (count: number): CollectedComment[] =>
    Array.from({ length: count }, (_, index) =>
      comment({
        id: `review-comment:${200 + index}`,
        threadId: String(200 + index),
        url: `https://x.test/c/${200 + index}`,
      }),
    );

  test("the default cap is thirty", () => {
    expect(DEFAULT_MAX_REPLIES_TOTAL).toBe(30);
  });

  test("beyond the cap: one summary comment and a named backlog", async () => {
    const root = await fresh();
    const comments = many(4);
    const pass = buildReplyPass({
      repo: REPO,
      number: PR,
      comments,
      outcomes: everyCommentAnswered(comments),
      maxReplies: 2,
      flowLink: "https://x.test/flow/journal.md",
    });
    expect(pass.replies).toHaveLength(2);
    expect(pass.backlog).toHaveLength(2);
    expect(pass.summary?.mode).toBe("overflow-summary");
    expect(pass.summary?.body).toContain("https://x.test/flow/journal.md");

    const port = createFixturePort(fixtures());
    const result = await postReplyPass({
      port,
      cwd: root,
      repo: REPO,
      number: PR,
      pass,
      sha: "abc123",
      round: { index: 1, isFinal: true },
      state: emptyPrCommentState(REPO, PR),
    });
    // Two individual replies plus exactly one summary — never one comment per
    // backlogged item, which is the noise the cap exists to prevent.
    expect(port.posts).toHaveLength(3);
    expect(result.backlog).toEqual(["review-comment:202", "review-comment:203"]);
    expect(result.state.backlog).toEqual(["review-comment:202", "review-comment:203"]);
    // A backlogged comment is ANSWERED (by the summary), so the completion gate
    // does not stall on it — and the record points at the comment that answered it.
    expect(unansweredComments(recordSeenComments(result.state, comments, 1))).toEqual([]);
    const backlogged = result.state.handled_comments.find((entry) => entry.id === "review-comment:202");
    expect(backlogged?.reply_url).toBe(pass.summary === null ? null : "https://github.com/fixture/pull/1#issuecomment-3");
  });

  test("an escalated comment leaves the reply queue and is reported", async () => {
    const comments = many(2);
    const pass = buildReplyPass({
      repo: REPO,
      number: PR,
      comments,
      outcomes: [
        { comment: comments[0]?.id ?? "", disposition: "acted-on", text: "Fixed." },
        { comment: comments[1]?.id ?? "", disposition: "acted-on", text: "n/a", escalate: true },
      ],
    });
    expect(pass.replies).toHaveLength(1);
    expect(pass.escalations.map((entry) => entry.id)).toEqual([comments[1]?.id ?? ""]);
  });
});

// ---------------------------------------------------------------------------
// The offline seam itself
// ---------------------------------------------------------------------------

describe("the offline seam", () => {
  test("gh --paginate concatenates documents, and the parser reads them", () => {
    expect(parseGhJson('[{"id":1}][{"id":2}]')).toEqual([{ id: 1 }, { id: 2 }]);
    expect(parseGhJson('[{"id":1}]')).toEqual([{ id: 1 }]);
    expect(parseGhJson("")).toEqual([]);
  });

  test("a read with no fixture is an empty list, which is a real state", async () => {
    const result = await collect(createFixturePort({}));
    expect(result.comments).toEqual([]);
    expect(result.counts.reviewComments).toBe(0);
  });

  test("the fixture port refuses a forbidden request exactly as the live one would", async () => {
    const port = createFixturePort({});
    await expect(port.request({ method: "POST", path: "graphql", body: {} })).rejects.toThrow(/Resolving/);
  });

  test("the CLI runs the whole loop against a fixture directory, posting nothing", async () => {
    const root = await fresh();
    const dir = path.join(root, "fx");
    await mkdir(dir, { recursive: true });
    const files = fixtures();
    for (const [key, value] of Object.entries(files)) {
      await writeFile(path.join(dir, `${key}.json`), JSON.stringify(value), "utf8");
    }
    process.chdir(root);

    const logged: string[] = [];
    const originalLog = console.log;
    console.log = (...parts: unknown[]) => {
      logged.push(parts.map(String).join(" "));
    };
    try {
      await reviewCommand([
        "comments",
        "collect",
        "--repo",
        REPO,
        "--pr",
        String(PR),
        "--self",
        "keryx-bot",
        "--round",
        "1",
        "--out",
        path.join(root, "ext.json"),
        "--fixtures",
        dir,
      ]);
      const findings = JSON.parse(await readFile(path.join(root, "ext.json"), "utf8")) as StructuredReviewFinding[];
      expect(findings.every((finding) => finding.source === "external")).toBe(true);

      const outcomes = findings.map((finding) => ({
        comment: finding.external_ref?.id,
        disposition: "acted-on",
        text: "Fixed in abc123.",
      }));
      await writeFile(path.join(root, "outcomes.json"), JSON.stringify(outcomes), "utf8");

      await reviewCommand([
        "comments",
        "reply",
        "--repo",
        REPO,
        "--pr",
        String(PR),
        "--outcomes",
        path.join(root, "outcomes.json"),
        "--sha",
        "abc123",
        "--final",
        "--dry-run",
        "--fixtures",
        dir,
      ]);
    } finally {
      console.log = originalLog;
    }

    const output = logged.join("\n");
    expect(output).toContain("dry run");
    expect(output).toContain(`POST repos/${REPO}/pulls/${PR}/comments/11/replies`);
    // Nothing was written into the durable record by a dry run, so a real run
    // afterwards still has work to do.
    const state = await readPrCommentState(root, REPO, PR);
    expect(state.handled_comments).toEqual([]);
    expect(state.seen.length).toBeGreaterThan(0);
  });

  test("`comments reply` without --final refuses", async () => {
    const root = await fresh();
    const dir = path.join(root, "fx");
    await mkdir(dir, { recursive: true });
    for (const [key, value] of Object.entries(fixtures())) {
      await writeFile(path.join(dir, `${key}.json`), JSON.stringify(value), "utf8");
    }
    await writeFile(path.join(root, "outcomes.json"), "[]", "utf8");
    process.chdir(root);
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...parts: unknown[]) => {
      errors.push(parts.map(String).join(" "));
    };
    const originalExit = process.exitCode;
    try {
      await reviewCommand([
        "comments",
        "reply",
        "--repo",
        REPO,
        "--pr",
        String(PR),
        "--outcomes",
        path.join(root, "outcomes.json"),
        "--sha",
        "abc",
        "--self",
        "keryx-bot",
        "--fixtures",
        dir,
      ]);
    } finally {
      console.error = originalError;
      process.exitCode = originalExit;
    }
    expect(errors.join("\n")).toMatch(/nobody decided about|answered ONCE/);
  });

  test("the record written into the review package names the filtered as well as the collected", async () => {
    const result = await collect(createFixturePort(fixtures()));
    const markdown = renderPrCommentsMarkdown({ repo: REPO, number: PR, round: 2, result });
    expect(markdown).toContain("## External comments");
    expect(markdown).toContain("unclassified_severity=1");
    expect(markdown).toContain("self-authored");
    expect(markdown).toContain("(bot)");
  });
});
