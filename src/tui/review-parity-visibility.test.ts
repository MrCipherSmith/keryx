import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { HELD_FINDING, followUpObligation, writeMutationLeftovers } from "../review/parity.test-helpers";
import { formatReviewDepthLines, loadReviewDepth, renderReviewDepthText, renderReviewParityText } from "./review-panel";
import { isReviewParityCommand, projectReviewsParityLines } from "./reviews-inspector";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const PKG = ".metaproject/reviews/pr-7";
const manifest = { reviewId: "pr-7", createdAt: "2026-10-12T10:00:00Z", target: { kind: "pr", ref: "acme/app#7" } };

async function project(options: { leftovers: boolean }): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-parity-tui-"));
  roots.push(root);
  const dir = path.join(root, PKG);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest), "utf8");
  await writeFile(path.join(dir, "research.json"), JSON.stringify({ dispatch: { version: 1, mode: "all", selected: ["review-logic"] }, obligations: options.leftovers ? [followUpObligation()] : [] }), "utf8");
  await writeFile(path.join(dir, "findings.json"), JSON.stringify(options.leftovers ? [HELD_FINDING] : []), "utf8");
  if (options.leftovers) await writeMutationLeftovers(dir);
  return root;
}

describe("review parity in the Review depth block (the /reviews tab and its readline text)", () => {
  test("shows Not run with the cap, the held note and the open follow-up", async () => {
    const [row] = await loadReviewDepth(await project({ leftovers: true }));
    expect(row?.parity?.notRun).toBe(2);
    const text = formatReviewDepthLines(row ? [row] : []).join("\n");
    expect(text).toContain("  Not run: 2 candidates (cap 1): m2, m3");
    expect(text).toContain("  held: F-010 stays minor (mutant m1)");
    expect(text).toContain("  follow-up open: review-testing-practices:fu1 the sign-in audit log writer was not read");
    expect(renderReviewDepthText(row ? [row] : [])).toContain("Not run: 2 candidates");
  });

  test("a package with nothing left over carries no parity and prints no parity line", async () => {
    const [row] = await loadReviewDepth(await project({ leftovers: false }));
    expect(row?.parity).toBeUndefined();
    const text = formatReviewDepthLines(row ? [row] : []).join("\n");
    expect(text).not.toContain("Not run:");
    expect(text).not.toContain("held:");
    expect(text).not.toContain("follow-up");
  });
});

describe("/review parity", () => {
  test("is recognised as its own subcommand and leaves the bare /review alone", () => {
    expect(isReviewParityCommand("/review parity")).toBe(true);
    expect(isReviewParityCommand("  /review   parity ")).toBe(true);
    expect(isReviewParityCommand("/review")).toBe(false);
    expect(isReviewParityCommand("/review layers")).toBe(false);
  });

  test("prints one block per review that left something, with the same lines as the depth tab", async () => {
    const rows = await loadReviewDepth(await project({ leftovers: true }));
    const text = renderReviewParityText(rows);
    expect(text.startsWith("Review parity\n")).toBe(true);
    expect(text).toContain("acme/app#7  pr-7");
    expect(text).toContain("  Not run: 2 candidates (cap 1): m2, m3");
    expect(text).toContain("  held: F-010 stays minor (mutant m1)");
    expect(text).toContain("  follow-up open: review-testing-practices:fu1");
  });

  test("says so when no review left anything, and when there are no reviews at all", async () => {
    expect(renderReviewParityText(await loadReviewDepth(await project({ leftovers: false })))).toContain("No Not run candidates, held severity notes or open follow-ups.");
    expect(renderReviewParityText([])).toContain("No managed review has recorded a dispatch yet.");
  });
});

describe("the sidebar", () => {
  test("one short line per review that left something: Not run, held, follow-ups", async () => {
    const rows = await loadReviewDepth(await project({ leftovers: true }));
    expect(projectReviewsParityLines(rows, 40)).toEqual(["Not run 2\nheld 1\nfollow-ups 1"]);
  });

  test("paints nothing for a clean review or before the reviews are read", async () => {
    expect(projectReviewsParityLines(await loadReviewDepth(await project({ leftovers: false })), 40)).toEqual([]);
    expect(projectReviewsParityLines(undefined, 40)).toEqual([]);
  });
});
