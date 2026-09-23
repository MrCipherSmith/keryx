// Flow 290 T7 (AC4, AC5): what an UNATTENDED agent run may never do, decided
// before the permission mode is consulted.
//
// A dispatching `flow-next` runs an agent with nobody present. Its permission
// mode comes only from the trigger entry (`ask` or `trust`), and under `trust`
// a non-destructive `shell_exec`/`apply_patch` runs without a prompt — which
// would include `git push`, `keryx flow complete`, or a patch to the flow's
// own `acceptance-criteria.md`. This module is the floor that mode cannot
// lift: `agent.ts` asks it about every non-read call BEFORE resolving the
// mode, and a non-undefined answer is a denial, recorded, never a prompt.
//
// DEFENCE IN DEPTH, NOT THE BOUNDARY (flow 290 T13). A security review
// bypassed this floor several ways (`sh -c "git pu""sh"`, `git $(printf …)`,
// git aliases, `bun -e`/`node -e`/`python3 -c`, globbed filenames). It is not
// meant to win that race. The boundary is the hardened unattended sandbox
// (`../harness/process/sandbox/unattended.ts`): network off, credentials and
// $HOME hidden, an allow-listed environment — so a push or an API call that
// slips past this text check still has nothing to authenticate with and no
// network to use. What this floor adds is a clear, early, RECORDED refusal for
// the obvious spellings, which is what an operator reads afterwards.
//
// HONESTY ABOUT WHAT THIS IS. Like `../lib/command-risk.ts`, this is string
// analysis of a command a shell will re-interpret, so it is incomplete by
// construction and is NOT the containment. It is deliberately OVER-broad —
// a false positive costs one denied call in an unattended run; a false
// negative costs a pushed branch or a confirmed criterion. The containment is
// what surrounds the run: a throwaway worktree on its own `trigger/*` branch
// that nothing pushes, the dispatcher owning every flow-state write, and the
// OS shell sandbox when one is available.
//
// Pure: no I/O, no clock, no env.

import { parsePatchTargets } from "../lib/patch-risk";
import { commandWord, splitSegments, stripAssignments } from "../lib/shell-syntax";
import { isPublishCommand } from "../lib/command-risk";

/**
 * Tools an unattended run is never offered in this version (AC5). The web and
 * MCP tools bring third-party content that cannot authorize anything; a
 * subagent would be a second agent outside this run's floor and spend cap;
 * `ask_user` has nobody to ask.
 */
export const UNATTENDED_EXCLUDED_TOOLS: readonly string[] = [
  "web_fetch",
  "web_search",
  "search_tool",
  "use_tool",
  "spawn_subagent",
  "ask_user",
  // Flow 295 (AC7): creating a schedule needs an operator's confirmation, and an unattended run has none.
  "schedule_create",
];

/** `keryx flow` verbs only an operator (or the dispatcher itself) may run. */
const FORBIDDEN_FLOW_VERBS: readonly RegExp[] = [
  /\bflow\s+freeze\b/,
  /\bflow\s+ac\s+(?:update|reseal|confirm)\b/,
  /\bflow\s+implemented\b/,
  /\bflow\s+complete\b/,
  /\bflow\s+renumber\b/,
  /\bflow\s+(?:block|unblock)\b/,
  /\bflow\s+task\s+(?:add|depends|done|attempt|skip)\b/,
  /\bflow\s+start\b/,
  // Flow 299 (AC4): minting a completion confirmation token, and moving a flow
  // out of `completing`, belong to the operator.
  /\bflow\s+confirm\b/,
  /\bflow\s+recover\b/,
  // A nested dispatch would run outside this run's spend reservation.
  /\btrigger\s+run\b/,
  // Flow 295 (AC5): only an operator creates, installs or changes a schedule —
  // never an unattended run, whatever its grants.
  /\bschedule\s+(?:add|remove|pause|resume|run|install|uninstall)\b/,
  /\btrigger\s+schedule\b/,
  /\bsystemctl\b[^\n]*\b(?:enable|disable|start|stop|daemon-reload|link|edit|mask)\b/,
  /\bcrontab\b/,
  /\blaunchctl\b/,
  /\bloginctl\b/,
];

/** Git subcommands that move shared history, rewrite refs directly, or publish. */
const FORBIDDEN_GIT_VERBS = new Set(["push", "merge", "tag", "update-ref"]);

/** `git branch` flags that move or delete an existing branch. */
const FORBIDDEN_GIT_BRANCH_FLAGS = new Set(["-f", "--force", "-D", "-M", "--delete", "-d", "-m", "--move"]);

/** `gh api` flags that make the request mutating (a method other than GET, or a body). */
const GH_API_BODY_FLAGS = new Set(["-f", "-F", "--field", "--raw-field", "--input"]);

/** Raw-text fallbacks for a verb hidden inside `sh -c '…'`, `eval`, a subshell, … */
const RAW_GIT = /\bgit\b[^\n]*?\b(push|merge|tag)(?![\w-])/;
const RAW_PUBLISH: readonly RegExp[] = [
  /\bgh\b[^\n]*?\brelease\b/,
  /\bgh\b[^\n]*?\bpr\b[^\n]*?\bmerge\b/,
  /\b(?:npm|bun|yarn|pnpm)\b[^\n]*?\bpublish\b/,
];

/** Files the dispatcher owns; the agent may read them but never write them. */
const PROTECTED_TEXT_MARKERS: readonly string[] = [
  "flow.json",
  "acceptance-criteria.md",
  "triggers.json",
  "data/trigger",
  // Flow 299 (AC4): the confirmation token stores, flow and SAC alike
  // (`<flow>/confirm-token.json`, `<proposal>.confirm-token.json`). The file
  // name, not the bare stem, so `bun test src/flow/confirm-token.test.ts` runs.
  "confirm-token.json",
];

/** True when `p` (repo-relative or absolute) is a file an unattended run must never write. */
export function isUnattendedProtectedPath(p: string): boolean {
  const normalized = p.replace(/\\/g, "/").trim();
  return (
    /(^|\/)flow\.json$/.test(normalized) ||
    /(^|\/)acceptance-criteria\.md$/.test(normalized) ||
    /(^|\/)\.metaproject\/triggers\.json$/.test(normalized) ||
    /(^|\/)\.metaproject\/data\/trigger(\/|$)/.test(normalized) ||
    /confirm-token\.json$/.test(normalized)
  );
}

/** Why an unattended run may not run `command`, or undefined when the floor has no objection. */
export function unattendedShellRefusal(command: string): string | undefined {
  const text = command.trim();
  if (text.length === 0) return undefined;

  for (const pattern of FORBIDDEN_FLOW_VERBS) {
    const match = pattern.exec(text);
    if (match !== null) {
      return `\`${match[0]}\` changes flow state, a schedule or a timer — only an operator (or the dispatcher itself) may change those`;
    }
  }

  for (const segment of splitSegments(text)) {
    const words = stripAssignments(segment.words);
    const cmd = commandWord(words);
    const rest = words.slice(1);
    if (cmd === "git") {
      const verb = rest.find((word) => FORBIDDEN_GIT_VERBS.has(word));
      if (verb !== undefined) {
        return `\`git ${verb}\` is never run unattended — the run's work stays on its own trigger branch for the operator`;
      }
      if (rest.includes("branch") && rest.some((word) => FORBIDDEN_GIT_BRANCH_FLAGS.has(word))) {
        return "`git branch` that moves, renames or deletes a branch is never run unattended";
      }
    }
    if (cmd === "gh" && rest.includes("api")) {
      const methodAt = rest.findIndex((word) => word === "-X" || word === "--method");
      const method = methodAt >= 0 ? rest[methodAt + 1]?.toUpperCase() : rest.find((w) => w.startsWith("--method="))?.slice(9).toUpperCase();
      if ((method !== undefined && method !== "GET") || rest.some((word) => GH_API_BODY_FLAGS.has(word))) {
        return "`gh api` with a mutating method or a request body is never run unattended";
      }
    }
  }
  const rawGit = RAW_GIT.exec(text);
  if (rawGit !== null) {
    return `\`git ${rawGit[1]}\` is never run unattended — the run's work stays on its own trigger branch for the operator`;
  }

  if (isPublishCommand(text) || RAW_PUBLISH.some((pattern) => pattern.test(text))) {
    return "publishing (push, release, PR merge, package publish) is never done unattended";
  }

  const lower = text.toLowerCase();
  const marker = PROTECTED_TEXT_MARKERS.find((m) => lower.includes(m));
  if (marker !== undefined) {
    return `the command names \`${marker}\`, a file only the dispatcher or an operator writes (read it with read_file instead)`;
  }
  return undefined;
}

/** Why an unattended run may not apply `patch`, or undefined when the floor has no objection. */
export function unattendedPatchRefusal(patch: string): string | undefined {
  const targets = parsePatchTargets(patch);
  const hit = targets.find((target) => isUnattendedProtectedPath(target.path));
  if (hit !== undefined) {
    return `the patch writes \`${hit.path}\`, a file only the dispatcher or an operator writes`;
  }
  // A patch whose headers the parser could not read still names its paths in
  // `---`/`+++`/`diff --git` lines; refuse on those too rather than trust a
  // parse that found nothing.
  for (const line of patch.split(/\r?\n/)) {
    if (!/^(?:---|\+\+\+|diff --git) /.test(line)) continue;
    for (const word of line.split(/\s+/).slice(1)) {
      const candidate = word.replace(/^[ab]\//, "");
      if (isUnattendedProtectedPath(candidate)) {
        return `the patch writes \`${candidate}\`, a file only the dispatcher or an operator writes`;
      }
    }
  }
  return undefined;
}

/**
 * The floor, per tool call. `input` is the parsed tool input. Returns the
 * refusal reason, or undefined. Only `shell_exec` and `apply_patch` can reach
 * a forbidden effect in the unattended roster; any other non-read tool in it
 * has no objection here (the permission mode still governs it).
 */
export function unattendedRefusal(toolName: string, input: Record<string, unknown>): string | undefined {
  if (UNATTENDED_EXCLUDED_TOOLS.includes(toolName)) {
    return `\`${toolName}\` is not offered to an unattended run`;
  }
  if (toolName === "shell_exec") {
    return unattendedShellRefusal(typeof input["command"] === "string" ? input["command"] : "");
  }
  if (toolName === "apply_patch") {
    return unattendedPatchRefusal(typeof input["patch"] === "string" ? input["patch"] : "");
  }
  return undefined;
}
