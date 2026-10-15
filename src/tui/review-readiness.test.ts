// Flow 451 AC8: the readiness checklist shows in the TUI and in `keryx review status`, from the one projection the CLI prints.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { reviewCommand } from "../commands/review";
import { recordLogStart, recordOrchestratorCall } from "../review/orchestrator-log";
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

// Flow 452 AC6: the tenth item reaches every surface the other nine reach.
describe("the memory-outside-stage item on every surface", () => {
  const stray = `${JSON.stringify({ command: 'keryx memory search "pr 7 earlier review" --status accepted' })}\n${JSON.stringify({ command: 'keryx memory search "what did we decide last week"' })}\n`;

  async function withStrayRead(): Promise<string> {
    const { root, dir } = await project();
    await mkdir(path.join(dir, "tool-calls"), { recursive: true });
    await writeFile(path.join(dir, "tool-calls", "orchestrator.jsonl"), stray, "utf8");
    return root;
  }

  test("the checklist has ten items and the depth block, /review readiness and the sidebar name the failing one", async () => {
    const root = await withStrayRead();
    const rows = await loadReviewDepth(root);
    expect(rows[0]?.readiness?.items).toHaveLength(10);
    expect(rows[0]?.readiness?.items.find((item) => item.id === "memory-outside-stage")?.status).toBe("fail");
    expect(formatReviewDepthLines(rows).join("\n")).toContain("memory-outside-stage:");
    expect(renderReviewReadinessText(rows)).toContain("10. [FAIL  ] memory-outside-stage");
    expect(projectReviewsReadinessLines(rows, 120)[0]).toContain("memory-outside-stage");
  });

  test("keryx review status and keryx review readiness print it", async () => {
    const root = await withStrayRead();
    process.chdir(root);
    const lines: string[] = [];
    const original = console.log;
    console.log = (...parts: unknown[]) => void lines.push(parts.join(" "));
    try {
      await reviewCommand(["status", "pr7-r1"], { isTerminal: () => false });
      await reviewCommand(["readiness", "pr7-r1"], { isTerminal: () => false });
    } finally {
      console.log = original;
    }
    const output = lines.join("\n");
    expect(output).toContain("memory-outside-stage");
    expect(output).toContain("10. [FAIL  ] memory-outside-stage");
    expect(output).toContain('--waive memory-outside-stage "<operator quote>"');
  });
});

// Flow 454 AC7: recorded versus no log, and the unattributed count, in the same words on every surface.
describe("the orchestrator log note on every surface", () => {
  async function surfaces(root: string): Promise<{ depth: string; readinessText: string; sidebar: string; status: string; readiness: string }> {
    const rows = await loadReviewDepth(root);
    process.chdir(root);
    const lines: string[] = [];
    const original = console.log;
    console.log = (...parts: unknown[]) => void lines.push(parts.join(" "));
    let status = "";
    let readiness = "";
    try {
      await reviewCommand(["status", "pr7-r1"], { isTerminal: () => false });
      status = lines.splice(0).join("\n");
      await reviewCommand(["readiness", "pr7-r1"], { isTerminal: () => false });
      readiness = lines.splice(0).join("\n");
    } finally {
      console.log = original;
    }
    return { depth: formatReviewDepthLines(rows).join("\n"), readinessText: renderReviewReadinessText(rows), sidebar: projectReviewsReadinessLines(rows, 200).join("\n"), status, readiness };
  }

  test("no log file: none, on the checklist, the status, the depth tab, the TUI text and the sidebar", async () => {
    const { root } = await project();
    const all = await surfaces(root);
    for (const text of Object.values(all)) expect(text).toContain("orchestrator log: none");
    for (const text of Object.values(all)) expect(text).not.toContain("orchestrator log: recorded");
  });

  test("a log keryx wrote: recorded, with the unattributed count when there is one", async () => {
    const { root, dir } = await project();
    await recordLogStart(dir);
    const quiet = await surfaces(root);
    for (const text of Object.values(quiet)) expect(text).toContain("orchestrator log: recorded");
    for (const text of Object.values(quiet)) expect(text).not.toContain("unattributed memory");

    await recordOrchestratorCall(dir, { source: "cli", caller: "unattributed", command: "keryx memory search \"who\"" });
    const noisy = await surfaces(root);
    for (const text of Object.values(noisy)) expect(text).toContain("orchestrator log: recorded, 1 unattributed");
  });
});
