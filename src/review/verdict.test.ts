import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { VERDICT_FILE, computeVerdict, writeVerdict } from "./verdict";

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function pkg(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "verdict-"));
  dirs.push(dir);
  await mkdir(path.join(dir, "raw"), { recursive: true });
  return dir;
}

const finding = (id: string, severity: string, problem: string, extra: Record<string, unknown> = {}) => ({ id, severity, problem, ...extra });

function reply(reviewer: string, findings: unknown[]): string {
  return `done\n\`\`\`REVIEW_RESULT\n${JSON.stringify({ reviewer, status: "DONE", findings })}\n\`\`\`\n`;
}

describe("computeVerdict from raw reviewer results", () => {
  test("counts by severity and lists open blockers and majors with a one-line problem", async () => {
    const dir = await pkg();
    await writeFile(path.join(dir, "raw", "review-logic.txt"), reply("review-logic", [finding("F-1", "blocker", "null deref\nsecond line"), finding("F-2", "minor", "nit"), finding("F-3", "major", "race")]));
    const verdict = await computeVerdict(dir);
    expect(verdict.source).toBe("raw reviewer results");
    expect(verdict.counts).toEqual({ blocker: 1, major: 1, minor: 1, info: 0 });
    expect(verdict.verified).toBe(0);
    expect(verdict.unverified).toBe(3);
    expect(verdict.open.map((f) => [f.id, f.problem])).toEqual([["F-1", "null deref"], ["F-3", "race"]]);
    expect(verdict.headline).toContain("blocker");
  });

  test("names the expected reviewers that have not reported", async () => {
    const dir = await pkg();
    await writeFile(path.join(dir, "manifest.json"), JSON.stringify({ coverage: [{ reviewer: "review-logic", status: "run" }, { reviewer: "review-style", status: "run" }, { reviewer: "review-x", status: "skipped" }] }));
    await writeFile(path.join(dir, "raw", "review-logic.txt"), reply("review-logic", []));
    const verdict = await computeVerdict(dir);
    expect(verdict.reportedReviewers).toEqual(["review-logic"]);
    expect(verdict.pendingReviewers).toEqual(["review-style"]);
  });

  test("says the pending set is unknown when the package records no expectation", async () => {
    const dir = await pkg();
    await writeFile(path.join(dir, "raw", "review-logic.txt"), reply("review-logic", []));
    const verdict = await computeVerdict(dir);
    expect(verdict.pendingReviewers).toBeUndefined();
  });
});

describe("computeVerdict from an ingested round", () => {
  test("excludes refuted findings and splits verified from unverified", async () => {
    const dir = await pkg();
    await writeFile(
      path.join(dir, "findings.json"),
      JSON.stringify([
        finding("F-1", "blocker", "real", { reviewer: "review-logic", verification: { verdict: "confirmed" } }),
        finding("F-2", "major", "noise", { reviewer: "review-logic", verification: { verdict: "refuted" } }),
        finding("F-3", "major", "unchecked", { reviewer: "review-style", verification: { verdict: "unverifiable" } }),
        finding("F-4", "minor", "no check", { reviewer: "review-style" }),
        finding("F-5", "major", "dismissed", { reviewer: "review-style", disposition: { state: "dismissed-incorrect" } }),
      ]),
    );
    const verdict = await computeVerdict(dir);
    expect(verdict.source).toBe("ingested round");
    expect(verdict.counts).toEqual({ blocker: 1, major: 1, minor: 1, info: 0 });
    expect(verdict.verified).toBe(1);
    expect(verdict.unverified).toBe(2);
    expect(verdict.refuted).toBe(1);
    expect(verdict.dismissed).toBe(1);
    expect(verdict.open.map((f) => f.id)).toEqual(["F-1", "F-3"]);
  });
});

describe("empty and partial packages", () => {
  test("a package with no findings says so and does not fail", async () => {
    const dir = await pkg();
    await writeFile(path.join(dir, "raw", "review-logic.txt"), reply("review-logic", []));
    const { verdict, markdown } = await writeVerdict(dir, "r1");
    expect(verdict.total).toBe(0);
    expect(verdict.headline).toBe("no findings");
    expect(markdown).toContain("findings: none");
  });

  test("a package with no raw directory and no findings reports no results yet", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "verdict-"));
    dirs.push(dir);
    const verdict = await computeVerdict(dir);
    expect(verdict.source).toBe("none");
    expect(verdict.headline).toContain("no reviewer results");
  });

  test("writeVerdict writes verdict-interim.md into the package", async () => {
    const dir = await pkg();
    await writeFile(path.join(dir, "raw", "review-logic.txt"), reply("review-logic", [finding("F-1", "major", "race")]));
    const { markdown } = await writeVerdict(dir, "r1");
    expect(existsSync(path.join(dir, VERDICT_FILE))).toBe(true);
    expect(await readFile(path.join(dir, VERDICT_FILE), "utf8")).toBe(markdown);
    expect(markdown).toContain("F-1 [major]");
  });
});
