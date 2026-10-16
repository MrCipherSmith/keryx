// Flow 451 AC4: `keryx review publish` is the only keryx path to GitHub. It runs the readiness checklist, refuses while an
// item fails, and with --partial posts a body whose first lines say what is missing. The body is shown before it is posted.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { reviewCommand } from "../commands/review";
import { mentionsFindingId, minorSection, partialPublishHeader, PUBLISHED_BODY_LIMIT, publishReview, reviewEvent, type PostResult, type ReviewEvent } from "./publish";
import { computeReadiness } from "./readiness";
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
    expect(io.posts[0]!.body).toBe("# Review\n\nRequest changes.\n");
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
