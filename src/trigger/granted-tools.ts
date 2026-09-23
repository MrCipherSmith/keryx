// Flow 295 (AC1, AC3): the catalogue of GRANTED tools an `agent-task`
// schedule may be given.
//
// A scheduled agent sometimes needs the operator's credentials ("check my open
// PRs"). The hardened unattended sandbox hides them on purpose: $HOME, /run and
// every exported token are gone (`../harness/process/sandbox/unattended.ts`).
// Passing a token into the sandbox would make it readable to the model and to
// anything the model runs, so this flow does not do that. A granted tool
// is a fixed command that KERYX runs itself, outside the sandbox, with the
// operator's environment. The model names the tool and a few checked
// parameters. It never sees the argv it cannot choose, the environment, or
// the credential. It sees only the redacted output.
//
// The catalogue is fixed in code and read-only by construction. There is no
// shell, no free-form argv, and no `gh api`. A parameter is matched against
// a strict pattern and can never start with `-`, so it cannot smuggle in a
// flag. Every `repo` parameter must name a repository the operator listed in
// the grant, so the model cannot widen the grant to other repositories.
//
// Pure: no I/O. Running a granted tool is the dispatcher's job
// (`../commands/trigger-agent-task.ts`).

import { unattendedShellRefusal } from "./unattended";

/** One parameter a granted tool accepts. Every value is a string on the wire. */
export interface GrantedToolParam {
  readonly description: string;
  readonly required: boolean;
  /** The value must match this in full. A value starting with `-` is refused regardless. */
  readonly pattern: RegExp;
  /** The value substituted when the model omits an optional parameter. */
  readonly fallback?: string;
  /** Restrict the value to the grant's own `repos` list. */
  readonly repoScoped?: boolean;
}

/** One entry of the catalogue. */
export interface GrantedToolSpec {
  /** Catalogue id, as written in `grants.tools` (e.g. `gh.pr.list`). */
  readonly id: string;
  /** The tool name the model sees (e.g. `gh_pr_list`). */
  readonly tool: string;
  /** The program run — resolved to an absolute path at confirmation time. */
  readonly program: string;
  readonly description: string;
  readonly params: Readonly<Record<string, GrantedToolParam>>;
  /** Build argv (without the program) from checked parameter values. */
  readonly argv: (values: Readonly<Record<string, string>>) => readonly string[];
}

const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const NUMBER = /^[1-9][0-9]{0,6}$/;
const LIMIT = /^[1-9][0-9]{0,2}$/;
const PR_STATE = /^(?:open|closed|merged|all)$/;
const ISSUE_STATE = /^(?:open|closed|all)$/;

const repoParam: GrantedToolParam = {
  description: "owner/name of a repository listed in this schedule's grant",
  required: true,
  pattern: REPO,
  repoScoped: true,
};
const numberParam = (what: string): GrantedToolParam => ({ description: `${what} number`, required: true, pattern: NUMBER });
const limitParam: GrantedToolParam = { description: "maximum rows (1-999, default 30)", required: false, pattern: LIMIT, fallback: "30" };

const PR_FIELDS = "number,title,author,isDraft,reviewDecision,updatedAt,url,headRefName";
const ISSUE_FIELDS = "number,title,author,labels,updatedAt,url";

/** The built-in catalogue. Adding an entry here is a reviewed code change, never a config edit. */
export const GRANTED_TOOL_CATALOGUE: readonly GrantedToolSpec[] = [
  {
    id: "gh.pr.list",
    tool: "gh_pr_list",
    program: "gh",
    description: "List pull requests of a granted repository (read-only, `gh pr list --json`).",
    params: {
      repo: repoParam,
      state: { description: "open|closed|merged|all (default open)", required: false, pattern: PR_STATE, fallback: "open" },
      limit: limitParam,
    },
    argv: (v) => ["pr", "list", "--repo", v["repo"]!, "--state", v["state"]!, "--limit", v["limit"]!, "--json", PR_FIELDS],
  },
  {
    id: "gh.pr.view",
    tool: "gh_pr_view",
    program: "gh",
    description: "Show one pull request of a granted repository, with its body and review state (read-only).",
    params: { repo: repoParam, number: numberParam("pull request") },
    argv: (v) => [
      "pr",
      "view",
      v["number"]!,
      "--repo",
      v["repo"]!,
      "--json",
      `${PR_FIELDS},body,reviews,statusCheckRollup,mergeable`,
    ],
  },
  {
    id: "gh.pr.checks",
    tool: "gh_pr_checks",
    program: "gh",
    description: "Show the CI checks of one pull request of a granted repository (read-only).",
    params: { repo: repoParam, number: numberParam("pull request") },
    argv: (v) => ["pr", "checks", v["number"]!, "--repo", v["repo"]!],
  },
  {
    id: "gh.issue.list",
    tool: "gh_issue_list",
    program: "gh",
    description: "List issues of a granted repository (read-only, `gh issue list --json`).",
    params: {
      repo: repoParam,
      state: { description: "open|closed|all (default open)", required: false, pattern: ISSUE_STATE, fallback: "open" },
      limit: limitParam,
    },
    argv: (v) => ["issue", "list", "--repo", v["repo"]!, "--state", v["state"]!, "--limit", v["limit"]!, "--json", ISSUE_FIELDS],
  },
  {
    id: "gh.issue.view",
    tool: "gh_issue_view",
    program: "gh",
    description: "Show one issue of a granted repository, with its body (read-only).",
    params: { repo: repoParam, number: numberParam("issue") },
    argv: (v) => ["issue", "view", v["number"]!, "--repo", v["repo"]!, "--json", `${ISSUE_FIELDS},body,comments`],
  },
  {
    id: "gh.run.list",
    tool: "gh_run_list",
    program: "gh",
    description: "List recent GitHub Actions runs of a granted repository (read-only).",
    params: { repo: repoParam, limit: limitParam },
    argv: (v) => [
      "run",
      "list",
      "--repo",
      v["repo"]!,
      "--limit",
      v["limit"]!,
      "--json",
      "databaseId,displayTitle,status,conclusion,headBranch,event,createdAt,url",
    ],
  },
];

/** Look a catalogue id up. */
export function grantedToolSpec(id: string, catalogue: readonly GrantedToolSpec[] = GRANTED_TOOL_CATALOGUE): GrantedToolSpec | undefined {
  return catalogue.find((spec) => spec.id === id);
}

/** A representative value for each parameter, used only to render argv for the load-time floor check. */
function sampleValues(spec: GrantedToolSpec): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, param] of Object.entries(spec.params)) {
    out[name] = param.fallback ?? (param.repoScoped ? "owner/repo" : "1");
  }
  return out;
}

/**
 * Every problem with a list of granted tool ids; empty means valid. An id that is not
 * in the catalogue is refused. So is a catalogue entry whose rendered command
 * the unattended floor refuses. That keeps "gh pr merge" out even if someone
 * adds it to the catalogue, and a grant can never lift the floor.
 */
export function grantedToolProblems(
  ids: readonly unknown[],
  catalogue: readonly GrantedToolSpec[] = GRANTED_TOOL_CATALOGUE,
): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (typeof id !== "string" || id.length === 0) {
      problems.push("action.grants.tools: every entry must be a non-empty catalogue id string");
      continue;
    }
    if (seen.has(id)) {
      problems.push(`action.grants.tools: "${id}" is listed twice`);
      continue;
    }
    seen.add(id);
    const spec = grantedToolSpec(id, catalogue);
    if (spec === undefined) {
      problems.push(
        `action.grants.tools: "${id}" is not in the built-in granted-tool catalogue ` +
          `(${catalogue.map((s) => s.id).join(", ")}) — a granted tool is a reviewed, fixed command, never free-form`,
      );
      continue;
    }
    const command = [spec.program, ...spec.argv(sampleValues(spec))].join(" ");
    const refusal = unattendedShellRefusal(command);
    if (refusal !== undefined) {
      problems.push(`action.grants.tools: "${id}" runs \`${command}\`, which the unattended floor refuses: ${refusal}`);
    }
  }
  return problems;
}

export type GrantedArgs =
  | { readonly ok: true; readonly argv: readonly string[]; readonly values: Readonly<Record<string, string>> }
  | { readonly ok: false; readonly reason: string };

/**
 * Check the model's input for one granted tool and build the argv. It refuses an
 * unknown parameter, a missing required one, a value that fails its pattern,
 * any value starting with `-`, and a repository outside the grant's `repos`.
 */
export function buildGrantedArgv(
  spec: GrantedToolSpec,
  input: Readonly<Record<string, unknown>>,
  repos: readonly string[],
): GrantedArgs {
  const values: Record<string, string> = {};
  for (const key of Object.keys(input)) {
    if (!(key in spec.params)) return { ok: false, reason: `unknown parameter "${key}" for ${spec.tool}` };
  }
  for (const [name, param] of Object.entries(spec.params)) {
    const raw = input[name];
    if (raw === undefined || raw === null || raw === "") {
      if (param.required) return { ok: false, reason: `${spec.tool}: "${name}" is required (${param.description})` };
      if (param.fallback !== undefined) values[name] = param.fallback;
      continue;
    }
    const value = typeof raw === "number" && Number.isSafeInteger(raw) ? String(raw) : raw;
    if (typeof value !== "string") return { ok: false, reason: `${spec.tool}: "${name}" must be a string` };
    if (value.startsWith("-")) return { ok: false, reason: `${spec.tool}: "${name}" may not start with "-" (no flags through parameters)` };
    if (!param.pattern.test(value)) return { ok: false, reason: `${spec.tool}: "${name}" = "${value}" is not ${param.description}` };
    if (param.repoScoped === true && !repos.includes(value)) {
      return {
        ok: false,
        reason: `${spec.tool}: repository "${value}" is not granted to this schedule (granted: ${repos.join(", ") || "none"})`,
      };
    }
    values[name] = value;
  }
  return { ok: true, argv: spec.argv(values), values };
}

/** JSON Schema for a granted tool's input, as offered to the model. */
export function grantedToolInputSchema(spec: GrantedToolSpec, repos: readonly string[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [name, param] of Object.entries(spec.params)) {
    properties[name] =
      param.repoScoped === true && repos.length > 0
        ? { type: "string", enum: [...repos], description: param.description }
        : { type: "string", description: param.description };
    if (param.required) required.push(name);
  }
  return { type: "object", properties, required, additionalProperties: false };
}
