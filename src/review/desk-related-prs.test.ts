import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { DESK_RELATED_PRS, linkedReviewPulls, relatedPullGitDir } from "./desk-related-prs";
import { retainUnreconciledFindings } from "./desk-auto-finalize";
import { reviewSourceTool } from "../harness/tool/builtin/read-review-source";
import { withoutGitDiscoveryOverrides } from "../lib/git-env";

let fixture: string | undefined;
afterEach(() => { if (fixture) rmSync(fixture, { recursive: true, force: true }); fixture = undefined; });

test("related review inputs use explicit same-owner links once and reject path traversal and other owners", () => {
  expect(linkedReviewPulls([
    "Org/backend#25 and https://github.com/ORG/serve/pull/12.",
    "https://github.com/org/backend/pull/25 and org/frontend#10",
    "org/..#40 and org/.#41 and unrelated/secret#12",
  ].join("\n"), { repo: "Org/frontend", number: 10 })).toEqual([{ repo: "org/backend", number: 25 }, { repo: "org/serve", number: 12 }]);
  expect(linkedReviewPulls("https://github.com/ORG/serve/pull/12?x=3", { repo: "Org/frontend", number: 10 })).toEqual([
    { repo: "org/serve", number: 12 },
  ]);
});

test("Auto keys unresolved observations by their raw file and leaves unsatisfied follow-ups open", async () => {
  fixture = mkdtempSync(path.join(tmpdir(), "keryx-auto-ledger-"));
  mkdirSync(path.join(fixture, "raw"));
  const finding = { id: "F-001", severity: "major", problem: "Recorded review observation", file: "src/index.ts",
    class_scope: { sites: ["src/index.ts"], enumeration_method: "Checked the call sites" },
    verification: { verdict: "confirmed" }, disposition: { state: "acted-on" } };
  writeFileSync(path.join(fixture, "raw/review-logic-w1.txt"), "STATUS: DONE\nREVIEW_RESULT\n" +
    JSON.stringify({ status: "DONE", reviewer: "review-logic", findings: [finding] }));
  const obligation = { id: "review-logic-w1:F-001", source: "raw/review-logic-w1.txt", status: "unresolved" };
  const assessed = { id: "already-reconciled", severity: "minor", verification: { verdict: "confirmed" } };
  const records = await retainUnreconciledFindings(fixture, { scopeReviewed: true, obligations: [obligation] }, [assessed]);
  expect(records).toEqual([assessed, { id: obligation.id, severity: finding.severity, problem: finding.problem,
    file: finding.file, class_scope: finding.class_scope, reviewer: "review-logic" }]);
  expect(await retainUnreconciledFindings(fixture, { scopeReviewed: true, obligations: [{ ...obligation, id: "review-logic-w1:fu1" }] }, [])).toBeUndefined();
  expect(await retainUnreconciledFindings(fixture, { scopeReviewed: false, obligations: [obligation] }, [])).toBeUndefined();
});

test("the pinned source tool accepts empty optional parameters from a strict provider", async () => {
  fixture = mkdtempSync(path.join(tmpdir(), "keryx-linked-source-"));
  const pull = { repo: "org/backend", number: 25 };
  const relatedDir = relatedPullGitDir(fixture, pull);
  for (const dir of [fixture, relatedDir]) {
    mkdirSync(dir, { recursive: true });
    fixtureGit(dir, ["init", "-q"]);
    writeFileSync(path.join(dir, "Service.ts"), "export const configuredDatasource = true;\n");
    fixtureGit(dir, ["add", "Service.ts"]);
    fixtureGit(dir, ["commit", "--no-gpg-sign", "-qm", "fixture"]);
  }
  const head = fixtureGit(fixture, ["rev-parse", "HEAD"]);
  const linkedHead = fixtureGit(relatedDir, ["rev-parse", "HEAD"]);
  const old = process.env[DESK_RELATED_PRS];
  process.env[DESK_RELATED_PRS] = JSON.stringify([{ ...pull, head: linkedHead }]);
  try {
    const tool = reviewSourceTool(fixture, head);
    const fillers = { path: "", related_pr: "", find: "", start_line: 1 };
    const list = await tool.invoke({ ...fillers, operation: "list" });
    expect(JSON.parse(list.output)).toEqual([{ pull: "org/backend#25", head: linkedHead }]);
    const search = await tool.invoke({ ...fillers, related_pr: "Org/backend#25", operation: "search", find: "configuredDatasource" });
    expect(JSON.parse(search.output)).toEqual({ head: linkedHead, paths: ["Service.ts"] });
    for (const related_pr of ["", "org/backend#25"]) {
      const result = await tool.invoke({ ...fillers, related_pr, operation: "read", path: "Service.ts" });
      expect(result).toMatchObject({ isError: false });
      expect(result.output).toContain("configuredDatasource");
    }
    expect((await tool.invoke({ ...fillers, related_pr: "org/unrelated#25", operation: "read", path: "Service.ts" })).isError).toBe(true);
  } finally {
    if (old === undefined) delete process.env[DESK_RELATED_PRS];
    else process.env[DESK_RELATED_PRS] = old;
  }
});

function fixtureGit(cwd: string, args: string[]) {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", ...args],
    { cwd, env: withoutGitDiscoveryOverrides(process.env), encoding: "utf8" }).trim();
}
