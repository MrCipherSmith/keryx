import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { coverageErrors, packageHasPrContext, requiredReviewers } from "./coverage";
import { checkDispatch } from "./dispatch-check";
import { collectReviewers } from "./reviewers";

const FIXTURES = path.join(import.meta.dir, "fixtures", "pr-replay");
const SKILL = path.join(import.meta.dir, "..", "gdskills", "bundled", "skills", "review", "review-pr-contract", "SKILL.md");
const frontendFiles = ["src/admin/ExamplePage.tsx"];

let root: string;

async function install(name: string): Promise<void> {
  const dir = path.join(root, ".metaproject", "skills", "gdskills", "review", name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: Use when testing ${name}.\n---\n`, "utf8");
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "keryx-pr-contract-"));
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  await writeFile(path.join(root, ".metaproject", "metaproject.json"), `${JSON.stringify({ modules: { gdskills: {} } })}\n`, "utf8");
  for (const name of ["review-orchestrator", "review-verifier", "review-logic", "review-frontend", "review-style", "review-pr-contract"]) await install(name);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("review-pr-contract selection", () => {
  test("is required when pr-context.md is in the package, in both modes", async () => {
    for (const mode of ["all", "diff"] as const) {
      const need = await requiredReviewers(root, mode, frontendFiles, { prContext: true });
      expect(need.required).toContain("review-pr-contract");
    }
  });

  test("is left out, with the reason, when there is no pr-context.md", async () => {
    const need = await requiredReviewers(root, "all", frontendFiles);
    expect(need.required).not.toContain("review-pr-contract");
    expect(need.excluded.find((e) => e.reviewer === "review-pr-contract")?.reason).toContain("no pr-context.md");
  });

  test("a dispatch that skips it is refused when the package holds pr-context.md and passes when it does not", async () => {
    const withoutIt = (await requiredReviewers(root, "all", frontendFiles)).required;
    const dispatch = { mode: "all", selected: withoutIt };
    expect(await coverageErrors(dispatch, { root, files: frontendFiles, prContext: true })).toEqual([
      expect.stringContaining("missing: review-pr-contract"),
    ]);
    expect(await coverageErrors(dispatch, { root, files: frontendFiles, prContext: false })).toEqual([]);
  });

  test("packageHasPrContext reads the package directory", async () => {
    const pkg = path.join(root, "pkg");
    await mkdir(pkg, { recursive: true });
    expect(packageHasPrContext(pkg)).toBe(false);
    await writeFile(path.join(pkg, "pr-context.md"), await readFile(path.join(FIXTURES, "pr-context.md"), "utf8"), "utf8");
    expect(packageHasPrContext(pkg)).toBe(true);
  });

  test("the bundled inventory lists the reviewer under --pr-contract", async () => {
    const inventory = await collectReviewers(root, { bundledSkillMarkdownPath: () => undefined });
    expect(inventory.bundled.map((r) => r.name)).toContain("review-pr-contract");
  });
});

describe("review-pr-contract dispatch", () => {
  const payload = (prContext: string) => ({
    review_context: {
      request: { raw: "review the pull request" },
      scope: { mode: "path", files: frontendFiles },
      routing: { selected_reviewers: ["review-pr-contract"] },
      token_policy: { context_mode: "light", omissions: [] },
    },
    reviewer: "review-pr-contract",
    scope_mode: "path",
    model: { tier: "standard", tier_reasons: ["base"], provider: "openai", model: "gpt-5", tier_resolution: "session-fallback", model_discovery: {}, routed: true },
    pr_context: prContext,
    budget: { max_findings: 10 },
  });

  test("passes dispatch-check when the payload names the readable pr-context.md", async () => {
    const result = await checkDispatch([payload(path.join(FIXTURES, "pr-context.md"))], { prContext: { exists: () => true } });
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test("is refused when the pr-context.md it works from is not there", async () => {
    const result = await checkDispatch([payload("")], { prContext: { exists: () => false } });
    expect(result.errors.map((e) => e.code)).toContain("REVIEWER_INPUT_NO_PR_CONTEXT");
  });
});

describe("the synthetic fixture and the skill's checklist form", () => {
  test("an unticked Documentation box plus a new user-visible row yields the expectation the skill's row carries", async () => {
    const body = await readFile(path.join(FIXTURES, "pr-context.md"), "utf8");
    const diff = await readFile(path.join(FIXTURES, "change.diff"), "utf8");
    const skill = await readFile(SKILL, "utf8");

    // The fixture holds both halves of the disagreement.
    const boxes = [...body.matchAll(/^- \[( |x)\] (.+)$/gim)].map((m) => ({ ticked: m[1]!.toLowerCase() === "x", text: m[2]! }));
    expect(boxes.find((b) => b.text === "Documentation needed")).toEqual({ ticked: false, text: "Documentation needed" });
    const added = diff.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"));
    const row = added.find((l) => /<tr>.*<th>[^<]+<\/th>/.test(l));
    expect(row).toContain("Last seen");

    // The skill states the expectation for exactly this pair, in its four-cell checklist form.
    expect(skill).toContain("| Box or claim (quoted) | State | What the diff shows (`file:line`, quoted) | Expectation |");
    const documentationRow = skill.split("\n").find((l) => l.startsWith("| `Documentation needed` | unticked |"));
    expect(documentationRow).toBeDefined();
    expect(documentationRow).toContain("A user-visible string or row is added, so the box should be ticked and a document should describe it");
    expect(documentationRow!.split("|").length).toBe(6);
  });

  test("the shell-host rule names the read-only limit and NEEDS_CONTEXT with paths", async () => {
    const skill = await readFile(SKILL, "utf8");
    expect(skill).toContain("### On a shell host");
    expect(skill).toContain("STATUS: NEEDS_CONTEXT");
    expect(skill).toContain("read-only");
  });
});
