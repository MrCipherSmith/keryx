// Flow 331, AC1/AC7 — the dataset builder, against fixture flows on disk
// (never the real repository: hermetic, and independent of how many review
// packages this repository happens to have today).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildDataset } from "./build-dataset";

let ROOT = "";

async function writePackage(
  root: string,
  dir: string,
  manifest: Record<string, unknown>,
  findings: unknown[],
  report = "",
): Promise<void> {
  const abs = path.join(root, dir);
  await mkdir(abs, { recursive: true });
  await writeFile(path.join(abs, "manifest.json"), JSON.stringify(manifest, null, 2));
  await writeFile(path.join(abs, "findings.json"), JSON.stringify(findings, null, 2));
  await writeFile(path.join(abs, "report.md"), report);
}

async function writeFlow(root: string, dir: string, flowJson: Record<string, unknown>, acLines: string[]): Promise<void> {
  const abs = path.join(root, dir);
  await mkdir(abs, { recursive: true });
  await writeFile(path.join(abs, "flow.json"), JSON.stringify(flowJson, null, 2));
  await writeFile(path.join(abs, "acceptance-criteria.md"), ["# Acceptance Criteria", "", "## Criteria", "", ...acLines].join("\n"));
}

beforeEach(async () => {
  ROOT = await mkdtemp(path.join(tmpdir(), "keryx-jev-bench-dataset-"));
});

afterEach(async () => {
  if (ROOT) {
    await rm(ROOT, { recursive: true, force: true });
    ROOT = "";
  }
});

describe("buildDataset: label mapping (AC1)", () => {
  test("acted-on -> true-positive, dismissed-incorrect -> false-positive, everything else -> unlabeled", async () => {
    await writePackage(
      ROOT,
      ".metaproject/reviews/pkg-1",
      { reviewId: "pkg-1", target: { kind: "pr", ref: "42", head: "deadbeef" } },
      [
        { id: "F-001", reviewer: "security", severity: "major", file: "a.ts", line: 10, disposition: { state: "acted-on", evidence: "fixed" } },
        { id: "F-002", reviewer: "logic", severity: "minor", file: "b.ts", disposition: { state: "dismissed-incorrect", evidence: "checked, false" } },
        { id: "F-003", reviewer: "style", severity: "info", disposition: { state: "dismissed-wont-fix", evidence: "wontfix" } },
        { id: "F-004", reviewer: "style", severity: "info" },
      ],
    );

    const dataset = buildDataset(ROOT);
    expect(dataset.counts.packages).toBe(1);
    expect(dataset.counts.findings).toBe(4);
    expect(dataset.counts.byLabel["true-positive"]).toBe(1);
    expect(dataset.counts.byLabel["false-positive"]).toBe(1);
    expect(dataset.counts.byLabel.unlabeled).toBe(2);

    const byId = new Map(dataset.findings.map((f) => [f.findingId, f]));
    expect(byId.get("F-001")?.label).toBe("true-positive");
    expect(byId.get("F-001")?.prRef).toBe("42");
    expect(byId.get("F-001")?.diffRef).toBe("deadbeef");
    expect(byId.get("F-001")?.file).toBe("a.ts");
    expect(byId.get("F-001")?.line).toBe(10);
    expect(byId.get("F-002")?.label).toBe("false-positive");
    expect(byId.get("F-003")?.label).toBe("unlabeled");
    expect(byId.get("F-004")?.disposition.state).toBe("unknown");
    expect(byId.get("F-004")?.disposition.source).toBe("none");
    expect(byId.get("F-004")?.label).toBe("unlabeled");
  });
});

describe("buildDataset: disposition source precedence", () => {
  test("record beats report-closed-by beats ledger beats none", async () => {
    const gitResult = spawnSync("git", ["init", "-q"], { cwd: ROOT });
    expect(gitResult.status).toBe(0);
    spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: ROOT });
    spawnSync("git", ["config", "user.name", "test"], { cwd: ROOT });
    await writeFile(path.join(ROOT, "seed.txt"), "seed");
    spawnSync("git", ["add", "seed.txt"], { cwd: ROOT });
    const commit = spawnSync("git", ["commit", "-q", "-m", "seed"], { cwd: ROOT });
    expect(commit.status).toBe(0);
    const sha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT }).stdout.toString().trim();

    await writePackage(
      ROOT,
      ".metaproject/reviews/pkg-2",
      { reviewId: "pkg-2", target: { kind: "pr", ref: "7" } },
      [
        { id: "F-001", reviewer: "r", severity: "major", disposition: { state: "acted-on", evidence: "recorded" } },
        { id: "F-002", reviewer: "r", severity: "major" },
        { id: "F-003", reviewer: "r", severity: "major" },
      ],
      `## F-002\nclosed by \`${sha}\`\n`,
    );

    await writeFile(
      path.join(ROOT, ".metaproject", "reviews", "dispositions.json"),
      JSON.stringify({ rows: [{ reviewId: "pkg-2", findingId: "F-003", category: "dismissed-wont-fix", evidence: "ledger says so" }] }),
    );

    const dataset = buildDataset(ROOT);
    const byId = new Map(dataset.findings.map((f) => [f.findingId, f]));
    expect(byId.get("F-001")?.disposition.source).toBe("record");
    expect(byId.get("F-002")?.disposition.source).toBe("report-closed-by");
    expect(byId.get("F-002")?.disposition.state).toBe("acted-on");
    expect(byId.get("F-003")?.disposition.source).toBe("ledger");
    expect(byId.get("F-003")?.disposition.state).toBe("dismissed-wont-fix");
    expect(dataset.problems).toEqual([]);
  });

  test("a report naming a commit this repo does not have is a problem, not a silent acceptance", async () => {
    await writePackage(
      ROOT,
      ".metaproject/reviews/pkg-3",
      { reviewId: "pkg-3", target: { kind: "pr", ref: "1" } },
      [{ id: "F-001", reviewer: "r", severity: "minor" }],
      "## F-001\nclosed by `0000000000000000000000000000000000dead`\n",
    );
    const dataset = buildDataset(ROOT);
    const finding = dataset.findings.find((f) => f.findingId === "F-001");
    expect(finding?.disposition.state).toBe("unknown");
    expect(dataset.problems.some((p) => p.includes("does not have"))).toBe(true);
  });

  test("a ledger row for a finding that is not on disk is a problem", async () => {
    await writePackage(ROOT, ".metaproject/reviews/pkg-4", { reviewId: "pkg-4", target: { kind: "pr", ref: "1" } }, []);
    await writeFile(
      path.join(ROOT, ".metaproject", "reviews", "dispositions.json"),
      JSON.stringify({ rows: [{ reviewId: "pkg-4", findingId: "F-999", category: "acted-on", evidence: "x" }] }),
    );
    const dataset = buildDataset(ROOT);
    expect(dataset.problems.some((p) => p.includes("pkg-4#F-999"))).toBe(true);
  });
});

describe("buildDataset: flow-owned packages join to frozen AC + confirmations", () => {
  test("a package under .metaproject/flows/<id>/reviews/<name> pulls its flow's AC and confirmed count", async () => {
    await writeFlow(
      ROOT,
      ".metaproject/flows/900-fixture-flow",
      { id: "900", title: "Fixture flow", status: "done", acChecksum: "sha256:abc", acConfirmed: { AC1: true, AC2: true } },
      ["- AC1: first criterion", "- AC2: second criterion", "- AC3: third criterion"],
    );
    await writePackage(
      ROOT,
      ".metaproject/flows/900-fixture-flow/reviews/pkg-5",
      {
        reviewId: "pkg-5",
        target: { kind: "pr", ref: "55" },
        flow: { id: "900", path: ".metaproject/flows/900-fixture-flow" },
      },
      [{ id: "F-001", reviewer: "r", severity: "major", disposition: { state: "acted-on", evidence: "x" } }],
    );

    const dataset = buildDataset(ROOT);
    expect(dataset.findings[0]?.flowId).toBe("900");
    expect(dataset.flows).toHaveLength(1);
    expect(dataset.flows[0]?.flowId).toBe("900");
    expect(dataset.flows[0]?.title).toBe("Fixture flow");
    expect(dataset.flows[0]?.totalCount).toBe(3);
    expect(dataset.flows[0]?.confirmedCount).toBe(2);
    expect(dataset.flows[0]?.criteria).toEqual(["AC1: first criterion", "AC2: second criterion", "AC3: third criterion"]);
  });
});

describe("buildDataset: determinism (AC1)", () => {
  test("two runs over the same tree agree on everything except generatedAt", async () => {
    await writePackage(
      ROOT,
      ".metaproject/reviews/pkg-a",
      { reviewId: "pkg-a", target: { kind: "pr", ref: "1" } },
      [{ id: "F-001", reviewer: "r", severity: "major", disposition: { state: "acted-on", evidence: "x" } }],
    );
    await writePackage(
      ROOT,
      ".metaproject/reviews/pkg-b",
      { reviewId: "pkg-b", target: { kind: "pr", ref: "2" } },
      [{ id: "F-001", reviewer: "r", severity: "major", disposition: { state: "dismissed-incorrect", evidence: "x" } }],
    );

    const first = buildDataset(ROOT);
    const second = buildDataset(ROOT);
    const strip = ({ generatedAt: _generatedAt, ...rest }: typeof first) => rest;
    expect(strip(first)).toEqual(strip(second));
    // Sorted by globalId, not insertion order.
    expect(first.findings.map((f) => f.globalId)).toEqual(["pkg-a#F-001", "pkg-b#F-001"]);
  });
});

describe("buildDataset: no packages on disk", () => {
  test("an empty tree is a valid, empty dataset, not an error", () => {
    const dataset = buildDataset(ROOT);
    expect(dataset.counts.packages).toBe(0);
    expect(dataset.counts.findings).toBe(0);
    expect(dataset.findings).toEqual([]);
    expect(dataset.flows).toEqual([]);
    expect(dataset.problems).toEqual([]);
  });
});
