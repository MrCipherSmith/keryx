// Flow 451 AC8: the readiness checklist shows in the TUI and in `keryx review status`, from the one projection the CLI prints.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { reviewCommand } from "../commands/review";
import { computeReadiness, renderReadiness } from "../review/readiness";
import { formatReviewDepthLines, loadReviewDepth, renderReviewReadinessText } from "./review-panel";
import { isReviewReadinessCommand, projectReviewsReadinessLines } from "./reviews-inspector";

const roots: string[] = [];
const cwd = process.cwd();
afterEach(async () => {
  process.chdir(cwd);
  process.exitCode = 0;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const PR = "https://github.com/acme/app/pull/7";

async function project(): Promise<{ root: string; dir: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-readiness-tui-"));
  roots.push(root);
  const dir = path.join(root, ".metaproject", "reviews", "pr7-r1");
  await mkdir(dir, { recursive: true });
  const write = (name: string, value: unknown): Promise<void> => writeFile(path.join(dir, name), typeof value === "string" ? value : JSON.stringify(value, null, 2), "utf8");
  await write("manifest.json", {
    schemaVersion: 1,
    reviewId: "pr7-r1",
    mode: "review-flow",
    status: "draft",
    createdAt: "2026-10-15T06:00:00Z",
    target: { kind: "pr", ref: PR },
    artifacts: { scope: "scope.md", coverage: "coverage.md", report: "report.md", findings: "findings.json", learning: "learning.md", decisions: "decisions.md" },
    coverage: [],
  });
  await write("findings.json", [{ id: "f-1", severity: "major", title: "unverified claim" }]);
  await write("report.md", "# Review\n");
  await write("coverage.md", "# Reviewer Coverage\n\nreviewer: review-logic\nstatus: run\nreason: read the diff\n");
  return { root, dir };
}

describe("the Review depth block carries the checklist", () => {
  test("each row has the same report the CLI computes, and the block starts with the verdict and the failing items", async () => {
    const { root, dir } = await project();
    const [row] = await loadReviewDepth(root);
    const report = await computeReadiness(dir);
    expect(row?.readiness).toEqual(report);
    const text = formatReviewDepthLines(row ? [row] : []).join("\n");
    expect(text).toContain("readiness: NOT READY");
    expect(text).toContain("verifier:");
  });
});

describe("/review readiness", () => {
  test("is its own subcommand and leaves the bare /review alone", () => {
    expect(isReviewReadinessCommand("/review readiness")).toBe(true);
    expect(isReviewReadinessCommand("  /review   readiness ")).toBe(true);
    expect(isReviewReadinessCommand("/review")).toBe(false);
    expect(isReviewReadinessCommand("/review parity")).toBe(false);
  });

  test("prints the whole checklist exactly as keryx review readiness renders it", async () => {
    const { root, dir } = await project();
    const text = renderReviewReadinessText(await loadReviewDepth(root));
    expect(text.startsWith("Review readiness\n")).toBe(true);
    for (const line of renderReadiness(await computeReadiness(dir))) expect(text).toContain(`  ${line}`);
    expect(renderReviewReadinessText([])).toContain("No managed review has recorded a dispatch yet.");
  });
});

describe("the sidebar Readiness block", () => {
  test("one line per review: the verdict and the failing item ids", async () => {
    const { root } = await project();
    const lines = projectReviewsReadinessLines(await loadReviewDepth(root), 80);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("pr7-r1: NOT READY");
    expect(lines[0]).toContain("verifier");
  });

  test("paints nothing before the reviews are read", () => {
    expect(projectReviewsReadinessLines(undefined, 40)).toEqual([]);
  });
});

describe("keryx review status", () => {
  test("prints the readiness verdict and the failing items", async () => {
    const { root } = await project();
    process.chdir(root);
    const lines: string[] = [];
    const original = console.log;
    console.log = (...parts: unknown[]) => void lines.push(parts.join(" "));
    try {
      await reviewCommand(["status", "pr7-r1"], { isTerminal: () => false });
    } finally {
      console.log = original;
    }
    const output = lines.join("\n");
    expect(output).toContain("readiness: NOT READY");
    expect(output).toContain("verifier");
  });
});
