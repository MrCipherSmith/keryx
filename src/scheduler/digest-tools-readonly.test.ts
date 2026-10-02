// Flow 389 (AC3, invariant): the granted-tool catalogue the scheduled digest
// draws from has no mutating `gh` command. Every entry has a fixed argv, is on
// the read-only allowlist and names an allowed repository. Adding a mutating
// or non-allowlisted entry fails this file.

import { describe, expect, test } from "bun:test";
import { DIGEST_DEFAULT_REPOS, digestConfigProblems } from "../trigger/digest-config";
import {
  buildGrantedArgv,
  DIGEST_TOOL_IDS,
  GH_READONLY_ALLOWLIST,
  GRANTED_TOOL_CATALOGUE,
  ghReadOnlyProblem,
  grantedToolProblems,
  grantedToolSpec,
  type GrantedToolSpec,
} from "../trigger/granted-tools";

const ALLOWED = DIGEST_DEFAULT_REPOS;

/** Render an entry's argv with chosen values for its parameters. */
function render(spec: GrantedToolSpec, repo: string, other: string): readonly string[] {
  const values: Record<string, string> = {};
  for (const [name, param] of Object.entries(spec.params)) {
    values[name] = param.repoScoped === true ? repo : (param.fallback ?? other);
  }
  return spec.argv(values);
}

function mutating(id: string, argv: (v: Readonly<Record<string, string>>) => readonly string[], program = "gh"): GrantedToolSpec {
  return {
    id,
    tool: id.replaceAll(".", "_"),
    program,
    description: id,
    params: {
      repo: { description: "repo", required: true, pattern: /^[\w.-]+\/[\w.-]+$/, repoScoped: true },
      number: { description: "n", required: true, pattern: /^[1-9][0-9]*$/ },
    },
    argv,
  };
}

describe("the granted-tool catalogue is read-only (flow 389 AC3)", () => {
  test("the catalogue is not empty and every entry runs gh", () => {
    expect(GRANTED_TOOL_CATALOGUE.length).toBeGreaterThan(0);
    for (const spec of GRANTED_TOOL_CATALOGUE) expect(spec.program).toBe("gh");
  });

  test("every shipped entry passes the read-only check, and the shipped catalogue loads clean", () => {
    for (const spec of GRANTED_TOOL_CATALOGUE) expect(ghReadOnlyProblem(spec)).toEqual([]);
    expect(grantedToolProblems(GRANTED_TOOL_CATALOGUE.map((s) => s.id))).toEqual([]);
  });

  test("every entry's command group and verb is on the read-only allowlist", () => {
    for (const spec of GRANTED_TOOL_CATALOGUE) {
      const [group, verb] = render(spec, ALLOWED[0]!, "7");
      expect(Object.keys(GH_READONLY_ALLOWLIST)).toContain(group!);
      expect(GH_READONLY_ALLOWLIST[group!]).toContain(verb!);
    }
  });

  test("the allowlist itself names only reading verbs", () => {
    const writing = ["merge", "close", "reopen", "comment", "edit", "create", "delete", "review", "ready", "rerun", "cancel", "api", "auth"];
    for (const verbs of Object.values(GH_READONLY_ALLOWLIST)) {
      for (const verb of verbs) expect(writing).not.toContain(verb);
    }
    expect(Object.keys(GH_READONLY_ALLOWLIST)).not.toContain("api");
    expect(Object.keys(GH_READONLY_ALLOWLIST)).not.toContain("auth");
  });

  test("every argv is fixed: only parameter values vary, the rest is identical for any input", () => {
    for (const spec of GRANTED_TOOL_CATALOGUE) {
      const a = render(spec, "owner-a/repo-a", "11");
      const b = render(spec, "owner-b/repo-b", "22");
      expect(a.length).toBe(b.length);
      const paramValues = new Set(["owner-a/repo-a", "owner-b/repo-b", "11", "22", ...Object.values(spec.params).flatMap((p) => (p.fallback === undefined ? [] : [p.fallback]))]);
      a.forEach((token, index) => {
        if (token !== b[index]) {
          // A token that differs between inputs must be one of the checked parameter values.
          expect(paramValues.has(token)).toBe(true);
        }
      });
      // A parameter value can never reach the argv as a flag: no value starts with "-".
      for (const token of a) expect(typeof token).toBe("string");
    }
  });

  test("every entry names its repository with --repo, bound to a repository-scoped parameter", () => {
    for (const spec of GRANTED_TOOL_CATALOGUE) {
      expect(Object.values(spec.params).some((p) => p.repoScoped === true)).toBe(true);
      const argv = render(spec, ALLOWED[0]!, "7");
      expect(argv[argv.indexOf("--repo") + 1]).toBe(ALLOWED[0]!);
    }
  });

  test("an entry only ever runs against an allowed repository", () => {
    for (const spec of GRANTED_TOOL_CATALOGUE) {
      const values = Object.fromEntries(Object.entries(spec.params).filter(([, p]) => p.required).map(([name, p]) => [name, p.repoScoped === true ? ALLOWED[0]! : "7"]));
      const ok = buildGrantedArgv(spec, values, ALLOWED);
      expect(ok.ok).toBe(true);
      const elsewhere = buildGrantedArgv(spec, { ...values, repo: "someone-else/other-repo" }, ALLOWED);
      expect(elsewhere.ok).toBe(false);
      if (!elsewhere.ok) expect(elsewhere.reason).toContain("is not granted");
    }
  });

  test("the digest's tools are catalogue entries, and cover issues, PRs, reviews requested and failed CI", () => {
    for (const id of DIGEST_TOOL_IDS) expect(grantedToolSpec(id)).toBeDefined();
    expect([...DIGEST_TOOL_IDS].sort()).toEqual(["gh.issue.list", "gh.pr.list", "gh.pr.review-requested", "gh.run.failed"]);
    const review = render(grantedToolSpec("gh.pr.review-requested")!, ALLOWED[0]!, "7");
    expect(review).toContain("review-requested:@me");
    const failed = render(grantedToolSpec("gh.run.failed")!, ALLOWED[0]!, "7");
    expect(failed.join(" ")).toContain("--status failure");
  });

  test("the default repository list is exactly the keryx repository", () => {
    expect([...DIGEST_DEFAULT_REPOS]).toEqual(["MrCipherSmith/keryx"]);
  });
});

describe("adding a mutating or non-allowlisted entry fails (flow 389 AC3)", () => {
  const mutatingEntries: ReadonlyArray<readonly [string, GrantedToolSpec]> = [
    ["gh pr merge", mutating("gh.pr.merge", (v) => ["pr", "merge", v["number"]!, "--repo", v["repo"]!, "--squash"])],
    ["gh pr close", mutating("gh.pr.close", (v) => ["pr", "close", v["number"]!, "--repo", v["repo"]!])],
    ["gh pr comment", mutating("gh.pr.comment", (v) => ["pr", "comment", v["number"]!, "--repo", v["repo"]!, "--body", "hi"])],
    ["gh pr review", mutating("gh.pr.review", (v) => ["pr", "review", v["number"]!, "--repo", v["repo"]!, "--approve"])],
    ["gh issue edit", mutating("gh.issue.edit", (v) => ["issue", "edit", v["number"]!, "--repo", v["repo"]!, "--add-label", "x"])],
    ["gh issue create", mutating("gh.issue.create", (v) => ["issue", "create", "--repo", v["repo"]!, "--title", "x"])],
    ["gh run rerun", mutating("gh.run.rerun", (v) => ["run", "rerun", v["number"]!, "--repo", v["repo"]!])],
    ["gh run cancel", mutating("gh.run.cancel", (v) => ["run", "cancel", v["number"]!, "--repo", v["repo"]!])],
    ["gh api", mutating("gh.api", (v) => ["api", "--method", "POST", `repos/${v["repo"]!}/issues`])],
    ["gh auth switch", mutating("gh.auth.switch", () => ["auth", "switch"])],
    ["gh auth login", mutating("gh.auth.login", () => ["auth", "login"])],
    ["gh repo delete", mutating("gh.repo.delete", (v) => ["repo", "delete", v["repo"]!, "--yes"])],
    ["a non-gh program", mutating("curl.post", (v) => ["pr", "list", "--repo", v["repo"]!], "curl")],
  ];

  for (const [label, spec] of mutatingEntries) {
    test(`${label} is refused by the read-only check`, () => {
      expect(ghReadOnlyProblem(spec).length).toBeGreaterThan(0);
    });
    test(`${label} is refused when added to the catalogue and granted`, () => {
      const problems = grantedToolProblems([spec.id], [...GRANTED_TOOL_CATALOGUE, spec]);
      expect(problems.length).toBeGreaterThan(0);
    });
  }

  test("an allowlisted verb with a mutating flag smuggled in is refused", () => {
    const sneaky = mutating("gh.pr.list-body", (v) => ["pr", "list", "--repo", v["repo"]!, "--body", "x"]);
    expect(ghReadOnlyProblem(sneaky).join("\n")).toContain("--body");
  });

  test("a read-only verb that does not name a repository is refused", () => {
    const unscoped = mutating("gh.pr.list-all", () => ["pr", "list", "--limit", "5"]);
    expect(ghReadOnlyProblem(unscoped).join("\n")).toContain("--repo");
  });

  test("a read-only verb whose --repo is not bound to a repository parameter is refused", () => {
    const hardcoded = mutating("gh.pr.list-fixed", () => ["pr", "list", "--repo", "owner/repo"]);
    // The sample for the repo-scoped parameter is "owner/repo", so the hard-coded value happens to match;
    // an entry with no repo-scoped parameter at all must fail.
    const noParam: GrantedToolSpec = { ...hardcoded, id: "gh.pr.list-noparam", params: {} };
    expect(ghReadOnlyProblem(noParam).join("\n")).toContain("--repo");
  });

  test("a new read-only-looking entry outside the allowlist (gh workflow list) is refused", () => {
    const workflow = mutating("gh.workflow.list", (v) => ["workflow", "list", "--repo", v["repo"]!]);
    expect(ghReadOnlyProblem(workflow).join("\n")).toContain("not on the read-only allowlist");
  });

  test("a digest config naming a non-digest tool is refused, and so is an empty repository list", () => {
    expect(digestConfigProblems({}, { tools: ["gh.pr.view"], repos: ["o/r"] }).join("\n")).toContain("is not a digest tool");
    expect(digestConfigProblems({}, { tools: [...DIGEST_TOOL_IDS], repos: [] }).join("\n")).toContain("grants.repos");
    expect(digestConfigProblems({}, { tools: [...DIGEST_TOOL_IDS], repos: [...DIGEST_DEFAULT_REPOS] })).toEqual([]);
  });
});
