// Flow 451 AC4: `keryx review publish` is the only keryx path to GitHub. It runs the readiness checklist, refuses while an
// item fails, and with --partial posts a body whose first lines say what is missing. The body is shown before it is posted.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { reviewCommand } from "../commands/review";
import { buildRoundBlock, mentionsFindingId, minorSection, partialPublishHeader, PUBLISHED_BODY_LIMIT, publishReview, reviewEvent, ROUND_BLOCK_LIMIT, type PostResult, type ReviewEvent } from "./publish";
import { parseRoundBlocks, renderRoundBlock } from "./pr-comments";
import { quoteSha256 } from "./round-record";
import { computeReadiness } from "./readiness";
import type { PrSnapshot } from "./complete-head-gate";
import { headMovedLine, publicationMarker } from "./publication-guard";
import type { VerdictFinding } from "./verdict";

const minor = (id: string, problem = "a small thing"): VerdictFinding => ({ id, reviewer: "review-style", severity: "minor", problem, location: "src/a.ts:1", verification: "none" });

const PR = "https://github.com/Presight-AI/vantage-frontend/pull/7932";

let root: string;
let pkg: string;
let cwd: string;

const write = (name: string, value: unknown): void => writeFileSync(path.join(pkg, name), typeof value === "string" ? value : JSON.stringify(value, null, 2));

function makePackage(options: { ready: boolean; kind?: string }): void {
  write("manifest.json", {
    schemaVersion: 1,
    reviewId: "pr7932-r1",
    mode: "review-flow",
    status: "draft",
    target: { kind: options.kind ?? "pr", ref: options.kind === "path" ? "src" : PR },
    artifacts: { scope: "scope.md", coverage: "coverage.md", report: "report.md", findings: "findings.json", learning: "learning.md", decisions: "decisions.md" },
    coverage: [],
  });
  write("findings.json", options.ready ? [] : [{ id: "f-1", severity: "major", title: "unverified claim" }]);
  write("report.md", "# Review\n\nRequest changes.\n");
  write("coverage.md", "# Reviewer Coverage\n\nreviewer: review-logic\nstatus: run\nreason: read the diff\n");
}

function seams() {
  const posts: Array<{ ref: string; event: ReviewEvent; body: string }> = [];
  const shown: string[] = [];
  return {
    posts,
    shown,
    post: async (ref: string, event: ReviewEvent, body: string): Promise<PostResult> => {
      posts.push({ ref, event, body });
      return { ok: true, detail: "ok" };
    },
    confirm: async (body: string): Promise<boolean> => {
      shown.push(body);
      return true;
    },
  };
}

beforeEach(() => {
  cwd = process.cwd();
  root = mkdtempSync(path.join(tmpdir(), "keryx-publish-"));
  pkg = path.join(root, ".metaproject", "reviews", "pr7932-r1");
  mkdirSync(pkg, { recursive: true });
});
afterEach(() => {
  process.chdir(cwd);
  process.exitCode = 0;
  rmSync(root, { recursive: true, force: true });
});

describe("publishReview", () => {
  test("refuses a NOT READY package and lists the failing items; nothing is shown or posted", async () => {
    makePackage({ ready: false });
    const io = seams();
    await expect(publishReview(pkg, { post: io.post, confirm: io.confirm })).rejects.toThrow(/cannot publish[\s\S]*verifier/i);
    expect(io.posts).toEqual([]);
    expect(io.shown).toEqual([]);
    expect(existsSync(path.join(pkg, "published.json"))).toBe(false);
  });

  test("--partial posts a body that starts with a Partial review header naming each failing item", async () => {
    makePackage({ ready: false });
    const io = seams();
    const readiness = await computeReadiness(pkg);
    const result = await publishReview(pkg, { partial: true, event: "REQUEST_CHANGES", post: io.post, confirm: io.confirm, now: () => new Date("2026-10-15T06:00:00Z") });
    expect(result.posted).toBe(true);
    expect(result.partial).toBe(true);
    const body = io.posts[0]!.body;
    expect(body.startsWith("**Partial review.**")).toBe(true);
    expect(body).toContain("- verifier:");
    expect(body).toContain("Request changes.");
    expect(io.posts[0]).toMatchObject({ ref: PR, event: "REQUEST_CHANGES" });
    expect(io.shown).toEqual([body]);
    expect(partialPublishHeader(readiness).join("\n")).toContain("verifier");
    const record = JSON.parse(readFileSync(path.join(pkg, "published.json"), "utf8"));
    expect(record).toMatchObject({ pr: PR, event: "REQUEST_CHANGES", partial: true, failing: ["verifier"], time: "2026-10-15T06:00:00.000Z" });
  });

  test("a partial review cannot approve", async () => {
    makePackage({ ready: false });
    const io = seams();
    await expect(publishReview(pkg, { partial: true, event: "APPROVE", post: io.post, confirm: io.confirm })).rejects.toThrow(/cannot approve/);
    expect(io.posts).toEqual([]);
  });

  test("a READY package posts the report as it is, with no header, even without --partial", async () => {
    makePackage({ ready: true });
    const io = seams();
    const result = await publishReview(pkg, { event: "APPROVE", post: io.post, confirm: io.confirm });
    expect(result).toMatchObject({ posted: true, partial: false });
    const body = io.posts[0]!.body;
    expect(body.startsWith("# Review\n\nRequest changes.\n")).toBe(true);
    // Flow 458: the only additions are the hidden round block and (flow 521) the shared duplicate marker at the foot.
    expect(body.replace(/\n<!-- keryx:round .* -->\n\n<!-- keryx-desktop-review pr7932-r1#r1 -->\n$/, "")).toBe("# Review\n\nRequest changes.\n");
  });

  test("flow 458: the round block round-trips publish -> parse, and published.json records head and review id", async () => {
    makePackage({ ready: true });
    const manifest = JSON.parse(readFileSync(path.join(pkg, "manifest.json"), "utf8"));
    write("manifest.json", { ...manifest, target: { ...manifest.target, head: "abcdef1234567" } });
    write("round.json", { v: 1, round: 3 });
    write("report.md", "# Review\n\nF-1 at `src/a.ts:12` still swallows the error.\n");
    write("findings.json", [
      { id: "F-1", reviewer: "review-logic", severity: "minor", problem: "swallows", file: "src/a.ts", line: 12, quote: "catch (e) { /* SECRET-QUOTE */ }", disposition: { state: "acted-on" } },
      { id: "F-2", reviewer: "review-logic", severity: "major", problem: "not in the body", file: "src/hidden.ts", line: 4, verification: { verdict: "confirmed", method: "reproduction", evidence: "ran it", verifier: "review-verifier" } },
    ]);
    const io = seams();
    await publishReview(pkg, { event: "COMMENT", post: io.post, confirm: io.confirm, now: () => new Date("2026-10-16T00:00:00Z") });
    const body = io.posts[0]!.body;
    const blocks = parseRoundBlocks(body);
    expect(blocks).toEqual([
      { v: 1, round: 3, reviewId: "pr7932-r1", reviewedHead: "abcdef1234567", findings: [{ id: "F-1", file: "src/a.ts", line: 12, quoteSha256: quoteSha256("catch (e) { /* SECRET-QUOTE */ }"), severity: "minor", status: "acted-on" }] },
    ]);
    // Nothing the body does not already say: no raw quote, and no finding the body never names.
    expect(body).not.toContain("SECRET-QUOTE");
    expect(body).not.toContain("F-2");
    expect(body).not.toContain("src/hidden.ts");
    expect(JSON.parse(readFileSync(path.join(pkg, "published.json"), "utf8"))).toMatchObject({ reviewId: "pr7932-r1", head: "abcdef1234567", round: 3 });
  });

  test("flow 458: a value cannot close the hidden comment, and the block stays within its size limit", () => {
    const findings = Array.from({ length: 400 }, (_, i) => ({ id: `F-${i}`, severity: "minor", file: "a-->b.ts", line: i }));
    const body = findings.map((f) => `${f.id} a-->b.ts:${f.line}`).join("\n");
    const block = buildRoundBlock({ body, round: 1, reviewId: "r", reviewedHead: null, findings });
    const rendered = renderRoundBlock(block);
    expect(rendered.length).toBeLessThanOrEqual(ROUND_BLOCK_LIMIT);
    expect(rendered.indexOf("-->")).toBe(rendered.length - 3);
    expect(block.truncated).toBe(400 - block.findings.length);
    expect(parseRoundBlocks(`text\n${rendered}\n`)[0]?.findings[0]).toEqual({ id: "F-0", file: "a-->b.ts", line: 0, severity: "minor", status: "open" });
  });

  test("a body the operator did not confirm is not posted and leaves no record", async () => {
    makePackage({ ready: true });
    const io = seams();
    const result = await publishReview(pkg, { post: io.post, confirm: async () => false });
    expect(result.posted).toBe(false);
    expect(io.posts).toEqual([]);
    expect(existsSync(path.join(pkg, "published.json"))).toBe(false);
  });

  test("a failed post throws and leaves no record", async () => {
    makePackage({ ready: true });
    const io = seams();
    await expect(publishReview(pkg, { post: async () => ({ ok: false, detail: "HTTP 422" }), confirm: io.confirm })).rejects.toThrow(/HTTP 422/);
    expect(existsSync(path.join(pkg, "published.json"))).toBe(false);
  });

  test("a package that is not bound to a pull request has nothing to publish to", async () => {
    makePackage({ ready: true, kind: "path" });
    const io = seams();
    await expect(publishReview(pkg, { post: io.post, confirm: io.confirm })).rejects.toThrow(/not bound to a pull request/);
  });

  test("round-2 m4: a report names a minor by its whole id, so F-12 does not hide F-1", () => {
    expect(mentionsFindingId("see F-12 and XF-1", "F-1")).toBe(false);
    expect(mentionsFindingId("fixed F-1.", "F-1")).toBe(true);
    expect(mentionsFindingId("(review-logic#F-1)", "review-logic#F-1")).toBe(true);
    const section = minorSection([minor("F-1"), minor("F-12")], "We addressed F-12.");
    expect(section).toContain("- F-1 ");
    expect(section).not.toContain("- F-12 ");
  });

  test("round-2 m2: the minor section fits its budget and counts what it cut", () => {
    const minors = Array.from({ length: 2000 }, (_, i) => minor(`F-${i}`, "x".repeat(80)));
    const section = minorSection(minors, "report");
    expect(section.length).toBeLessThanOrEqual(PUBLISHED_BODY_LIMIT);
    expect(section).toMatch(/- … \d+ more minor finding\(s\) — see verdict-interim\.md \/ `keryx review verdict`\n$/);
    const listed = section.split("\n").filter((line) => line.startsWith("- F-")).length;
    expect(section).toContain(`${2000 - listed} more minor finding(s)`);
    expect(minorSection(minors.slice(0, 2), "report")).not.toContain("more minor finding");
    const tight = minorSection(minors, "report", 300);
    expect(tight.length).toBeLessThanOrEqual(300);
    expect(tight).toContain("more minor finding(s)");
    expect(minorSection(minors, "report", 10)).toBe("");
    expect(minorSection([], "report")).toBe("");
  });

  test("the event is one of the three GitHub knows", () => {
    expect(reviewEvent(undefined)).toBe("COMMENT");
    expect(reviewEvent("request_changes")).toBe("REQUEST_CHANGES");
    expect(() => reviewEvent("MERGE")).toThrow(/--event must be one of/);
  });
});

describe("keryx review publish", () => {
  async function publish(args: string[], extra: Record<string, unknown> = {}) {
    process.chdir(root);
    const io = seams();
    const lines: string[] = [];
    const original = console.log;
    console.log = (...parts: unknown[]) => void lines.push(parts.join(" "));
    try {
      await reviewCommand(["publish", "pr7932-r1", ...args], { isTerminal: () => false, postReview: io.post, prLookup: async () => null, prFiles: async () => null, ...extra });
    } finally {
      console.log = original;
    }
    return { io, output: lines.join("\n") };
  }

  test("prints the body before it posts, and posts it once the operator's --yes is on the command", async () => {
    makePackage({ ready: true });
    const { io, output } = await publish(["--yes", "--event", "COMMENT"], { isTerminal: () => true });
    expect(output.indexOf("--- review body")).toBeGreaterThanOrEqual(0);
    expect(output.indexOf("Request changes.")).toBeLessThan(output.indexOf("published: COMMENT"));
    expect(io.posts).toHaveLength(1);
    expect(process.exitCode ?? 0).toBe(0);
  });

  test("flow 457: --yes without a terminal (and outside the autonomous runner) is refused, naming the card", async () => {
    makePackage({ ready: true });
    process.chdir(root);
    const errors: string[] = [];
    const original = console.error;
    console.error = (...parts: unknown[]) => void errors.push(parts.join(" "));
    try {
      const io = seams();
      await reviewCommand(["publish", "pr7932-r1", "--yes"], { isTerminal: () => false, postReview: io.post, prLookup: async () => null, prFiles: async () => null });
      expect(io.posts).toEqual([]);
    } finally {
      console.error = original;
    }
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("review_publish");
    process.exitCode = 0;
  });

  test("without a terminal and without --yes it shows the body and does not post", async () => {
    makePackage({ ready: true });
    const { io, output } = await publish([]);
    expect(output).toContain("Request changes.");
    expect(output).toContain("Not posted");
    expect(output).toContain("review_publish");
    expect(io.posts).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  test("a NOT READY package is refused with exit code 1 and the failing items; --partial lets it through", async () => {
    makePackage({ ready: false });
    process.chdir(root);
    const errors: string[] = [];
    const original = console.error;
    console.error = (...parts: unknown[]) => void errors.push(parts.join(" "));
    try {
      const io = seams();
      await reviewCommand(["publish", "pr7932-r1", "--yes"], { isTerminal: () => true, postReview: io.post, prLookup: async () => null, prFiles: async () => null });
      expect(io.posts).toEqual([]);
    } finally {
      console.error = original;
    }
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("verifier");
    process.exitCode = 0;
    const { io } = await publish(["--partial", "--yes"], { isTerminal: () => true });
    expect(io.posts).toHaveLength(1);
    expect(io.posts[0]!.body.startsWith("**Partial review.**")).toBe(true);
  });

  test("an unknown flag is refused", async () => {
    makePackage({ ready: true });
    process.chdir(root);
    const errors: string[] = [];
    const original = console.error;
    console.error = (...parts: unknown[]) => void errors.push(parts.join(" "));
    try {
      await reviewCommand(["publish", "pr7932-r1", "--force"], { isTerminal: () => false });
    } finally {
      console.error = original;
    }
    expect(errors.join("\n")).toContain("Unknown option");
  });
});

// Flow 521 T7: the session path shares Desktop's receipt, duplicate marker and moved-head first line, pins the review to
// the reviewed commit, publishes a moved head only as a Comment (D1), and re-reads the head after the operator's yes.
describe("publishReview: the publication guard shared with Desktop", () => {
  const REVIEWED = "a".repeat(40);
  const NEWER = "b".repeat(40);
  const receipt = () => path.join(pkg, "publication-receipt.json");
  const withHead = (report = "# Review\n\nRequest changes.\n"): void => {
    makePackage({ ready: true });
    const manifest = JSON.parse(readFileSync(path.join(pkg, "manifest.json"), "utf8"));
    write("manifest.json", { ...manifest, target: { ...manifest.target, head: REVIEWED } });
    write("report.md", report);
  };
  const at = (...heads: Array<string | Partial<PrSnapshot>>) => {
    let call = 0;
    return async (): Promise<PrSnapshot> => {
      const next = heads[Math.min(call++, heads.length - 1)]!;
      return typeof next === "string" ? { exists: true, state: "OPEN", headSha: next } : { exists: true, state: "OPEN", headSha: REVIEWED, ...next };
    };
  };
  const posting = () => {
    const posts: Array<{ event: ReviewEvent; body: string; commitId: string | undefined }> = [];
    return { posts, post: async (_ref: string, event: ReviewEvent, body: string, commitId?: string): Promise<PostResult> => {
      posts.push({ event, body, commitId });
      return { ok: true, detail: "posted", url: `${PR}#pullrequestreview-${posts.length}` };
    } };
  };

  test("the body ends with the marker Desktop also writes, and the review is pinned to the reviewed commit", async () => {
    withHead();
    const io = posting();
    const result = await publishReview(pkg, { post: io.post, confirm: async () => true, readiness: { prLookup: at(REVIEWED) } });
    expect(io.posts).toHaveLength(1);
    expect(io.posts[0]!.commitId).toBe(REVIEWED);
    expect(io.posts[0]!.body.trimEnd().endsWith(publicationMarker("pr7932-r1#r1"))).toBe(true);
    expect(result.url).toBe(`${PR}#pullrequestreview-1`);
    expect(JSON.parse(readFileSync(receipt(), "utf8"))).toEqual({ url: `${PR}#pullrequestreview-1` });
    expect(JSON.parse(readFileSync(path.join(pkg, "published.json"), "utf8"))).toMatchObject({ url: `${PR}#pullrequestreview-1` });
  });

  test("publishing the same package twice is refused the second time; nothing is posted again", async () => {
    withHead();
    const io = posting();
    await publishReview(pkg, { post: io.post, confirm: async () => true });
    let asked = false;
    await expect(publishReview(pkg, { post: io.post, confirm: async () => (asked = true) })).rejects.toThrow(/already been published: .*pullrequestreview-1/);
    expect(io.posts).toHaveLength(1);
    expect(asked).toBe(false);
  });

  test("a lost response keeps the receipt; the next publish finds the review by its marker or stays refused", async () => {
    withHead();
    const lost = async (): Promise<PostResult> => ({ ok: false, detail: "gh exited 1", uncertain: true });
    await expect(publishReview(pkg, { post: lost, confirm: async () => true })).rejects.toThrow(/could not be confirmed/);
    expect(JSON.parse(readFileSync(receipt(), "utf8"))).toEqual({});
    const io = posting();
    const markers: string[] = [];
    await expect(publishReview(pkg, { post: io.post, confirm: async () => true, findPublished: async (_ref, marker) => (markers.push(marker), undefined) }))
      .rejects.toThrow(/unknown result/);
    expect(markers).toEqual([publicationMarker("pr7932-r1#r1")]);
    await expect(publishReview(pkg, { post: io.post, confirm: async () => true, findPublished: async () => `${PR}#pullrequestreview-9` }))
      .rejects.toThrow(/already been published: .*pullrequestreview-9/);
    expect(JSON.parse(readFileSync(receipt(), "utf8"))).toEqual({ url: `${PR}#pullrequestreview-9` });
    expect(io.posts).toEqual([]);
  });

  test("a certain refusal drops the receipt, so the operator can publish again", async () => {
    withHead();
    await expect(publishReview(pkg, { post: async () => ({ ok: false, detail: "HTTP 422" }), confirm: async () => true })).rejects.toThrow(/HTTP 422/);
    expect(existsSync(receipt())).toBe(false);
    const io = posting();
    await publishReview(pkg, { post: io.post, confirm: async () => true });
    expect(io.posts).toHaveLength(1);
  });

  test("D1: on a moved head only a Comment is published, pinned to the reviewed commit, with the shared first line", async () => {
    withHead();
    const io = posting();
    for (const event of ["REQUEST_CHANGES", "APPROVE"] as const) {
      await expect(publishReview(pkg, { event, partial: true, post: io.post, confirm: async () => true, readiness: { prLookup: at(NEWER) } }))
        .rejects.toThrow(/moved from the reviewed commit aaaaaaa to bbbbbbb[\s\S]*--event COMMENT/);
    }
    expect(io.posts).toEqual([]);
    // The plain report does not name the reviewed commit, so the readiness head item fails and --partial is needed.
    await publishReview(pkg, { event: "COMMENT", partial: true, post: io.post, confirm: async () => true, readiness: { prLookup: at(NEWER) } });
    expect(io.posts[0]!.commitId).toBe(REVIEWED);
    expect(io.posts[0]!.body.split("\n")[0]).toBe(headMovedLine({ reviewedHead: REVIEWED, currentHead: NEWER }));
    expect(JSON.parse(readFileSync(path.join(pkg, "published.json"), "utf8"))).toMatchObject({ head: REVIEWED, prHead: NEWER });
  });

  test("D1: a report whose first line already names the reviewed commit keeps it and gets no second one", async () => {
    withHead(`Reviewed aaaaaaa — the PR has since moved on to bbbbbbb.\n\n# Review\n`);
    const io = posting();
    await publishReview(pkg, { event: "COMMENT", post: io.post, confirm: async () => true, readiness: { prLookup: at(NEWER) } });
    expect(io.posts[0]!.body.startsWith("Reviewed aaaaaaa — the PR has since moved on to bbbbbbb.")).toBe(true);
    expect(io.posts[0]!.body).not.toContain("The pull request has moved to");
  });

  test("the first line a moved head writes passes the head gate of review complete", async () => {
    const { completeHeadGate } = await import("./complete-head-gate");
    const report = `${headMovedLine({ reviewedHead: REVIEWED, currentHead: NEWER })}\n\n# Review\n`;
    await expect(completeHeadGate({ manifest: { target: { kind: "pr", ref: PR, head: REVIEWED } } as never, report, lookup: at(NEWER) })).resolves.toEqual({ warnings: [] });
  });

  test("a merged or closed pull request takes no review", async () => {
    for (const state of ["MERGED", "CLOSED"]) {
      withHead();
      const io = posting();
      await expect(publishReview(pkg, { partial: true, post: io.post, confirm: async () => true, readiness: { prLookup: at({ state }) } }))
        .rejects.toThrow(new RegExp(`is ${state.toLowerCase()}`));
      expect(io.posts).toEqual([]);
    }
  });

  test("a push while the operator reads makes the confirmed body stale: nothing is posted and no receipt is left", async () => {
    withHead();
    // The head is read before the body is built, by the readiness checklist, and again after the operator's yes.
    const io = posting();
    await expect(publishReview(pkg, { post: io.post, confirm: async () => true, readiness: { prLookup: at(REVIEWED, REVIEWED, NEWER) } }))
      .rejects.toThrow(/^stale: .*aaaaaaa → bbbbbbb/);
    expect(io.posts).toEqual([]);
    expect(existsSync(receipt())).toBe(false);
  });
});

// Flow 521 round 3 of PR 1302: the session path's acceptance matches Desktop's, and its receipt survives either place.
describe("publishReview: round-3 fixes of the shared publication guard", () => {
  const REVIEWED = "a".repeat(40);
  const NEWER = "b".repeat(40);
  const withHead = (report = "# Review\n\nRequest changes.\n"): void => {
    makePackage({ ready: true });
    const manifest = JSON.parse(readFileSync(path.join(pkg, "manifest.json"), "utf8"));
    write("manifest.json", { ...manifest, target: { ...manifest.target, head: REVIEWED } });
    write("report.md", report);
  };
  const at = (...heads: Array<string | undefined>) => {
    let call = 0;
    return async (): Promise<PrSnapshot | null> => {
      const next = heads[Math.min(call++, heads.length - 1)];
      return next === undefined ? null : { exists: true, state: "OPEN", headSha: next };
    };
  };
  const posting = (url?: string) => {
    const posts: string[] = [];
    return { posts, post: async (_ref: string, _event: ReviewEvent, body: string): Promise<PostResult> => {
      posts.push(body);
      return { ok: true, detail: "posted", ...(url === undefined ? {} : { url }) };
    } };
  };

  test("a round a later round of its Review follows is refused, as Desktop refuses it", async () => {
    withHead();
    const io = posting("u");
    await expect(publishReview(pkg, { post: io.post, confirm: async () => true, laterRound: async () => 2 }))
      .rejects.toThrow(/Round 2 of this Review already follows this one/);
    expect(io.posts).toEqual([]);
  });

  test("a moved head whose reviewed commit left the PR's history is refused; one still in it is published as is", async () => {
    withHead();
    const io = posting("u");
    const asked: string[] = [];
    await expect(publishReview(pkg, { partial: true, post: io.post, confirm: async () => true, readiness: { prLookup: at(NEWER) },
      reviewedHeadInPull: async (_ref, reviewed, current) => (asked.push(`${reviewed.slice(0, 1)}..${current.slice(0, 1)}`), false) }))
      .rejects.toThrow(/no longer in the pull request's history/);
    expect(asked).toEqual(["a..b"]);
    expect(io.posts).toEqual([]);
    await publishReview(pkg, { partial: true, post: io.post, confirm: async () => true, readiness: { prLookup: at(NEWER) }, reviewedHeadInPull: async () => true });
    expect(io.posts).toHaveLength(1);
  });

  test("the moved-head first line follows the head gate: a comment line is skipped, and naming the commit is not enough", async () => {
    withHead("<!-- keryx:slot -->\nReviewed aaaaaaa — the PR has since moved on to bbbbbbb.\n\n# Review\n");
    const kept = posting("u");
    await publishReview(pkg, { post: kept.post, confirm: async () => true, readiness: { prLookup: at(NEWER) } });
    expect(kept.posts[0]).not.toContain("The pull request has moved to");
    rmSync(path.join(pkg, "publication-receipt.json"));
    withHead("Notes on aaaaaaa.\n\n# Review\n");
    const added = posting("u");
    await publishReview(pkg, { partial: true, post: added.post, confirm: async () => true, readiness: { prLookup: at(NEWER) } });
    expect(added.posts[0]!.split("\n")[0]).toBe(headMovedLine({ reviewedHead: REVIEWED, currentHead: NEWER }));
  });

  test("a head that cannot be read again after the operator's yes is not reported as a moved head", async () => {
    withHead();
    const io = posting("u");
    await expect(publishReview(pkg, { post: io.post, confirm: async () => true, readiness: { prLookup: at(REVIEWED, REVIEWED, undefined) } }))
      .rejects.toThrow(/^The pull request could not be read again after the review was confirmed/);
    expect(io.posts).toEqual([]);
  });

  test("without GitHub's URL the receipt names the pull request, so Desktop counts the review as published", async () => {
    withHead();
    await publishReview(pkg, { post: posting().post, confirm: async () => true });
    expect(JSON.parse(readFileSync(path.join(pkg, "publication-receipt.json"), "utf8"))).toEqual({ url: PR });
  });

  test("the receipt is written to the Attempt and to the package: losing the Attempt's copy does not allow a second post", async () => {
    withHead();
    const attempt = path.join(root, "attempt");
    mkdirSync(attempt);
    const publication = { directory: attempt, id: "0b0c1d2e-0000-4000-8000-000000000001" };
    const url = "https://github.com/x/y/pull/1#pullrequestreview-7";
    await publishReview(pkg, { post: posting(url).post, confirm: async () => true, publication });
    for (const dir of [attempt, pkg]) expect(JSON.parse(readFileSync(path.join(dir, "publication-receipt.json"), "utf8"))).toEqual({ url });
    rmSync(path.join(attempt, "publication-receipt.json"));
    const again = posting("u");
    await expect(publishReview(pkg, { post: again.post, confirm: async () => true, publication })).rejects.toThrow(/already been published/);
    expect(again.posts).toEqual([]);
  });
});
