// Narrow allowlist of local, non-publishing commands a `trust`-mode turn may run
// without a prompt even after untrusted content (an MCP or web result) entered the
// turn. Escalation floors (destructive, credentials, SAC/flow confirmation,
// publish) are checked first and are never lifted. Pure string analysis.

import { isDestructiveCommand, isPublishCommand, touchesAgentCredentials, touchesHumanConfirmation } from "./command-risk";
import { hasUnquotedMetacharacter, splitSegments, stripAssignments } from "./shell-syntax";

const MAX_CHAIN_SEGMENTS = 4;
const CTX_SUBCOMMANDS: ReadonlySet<string> = new Set(["rg", "read", "diff"]);
const FLOW_READ_SUBCOMMANDS: ReadonlySet<string> = new Set(["status", "list", "check"]);
const GRAPH_READ_SUBCOMMANDS: ReadonlySet<string> = new Set(["find", "context", "affected", "cycles", "orphans"]);
const GIT_READ_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "status",
  "diff",
  "log",
  "show",
  "rev-parse",
  "rev-list",
  "ls-files",
  "merge-base",
  "blame",
]);
const REVIEW_OUTBOUND_SUBCOMMANDS: ReadonlySet<string> = new Set(["reply"]);
const EXEC_FLAGS: readonly string[] = ["--pre", "--hostname-bin", "--output", "--ext-diff", "--exec", "--upload-pack", "--post", "--publish", "--push"];

function hasExecFlag(words: readonly string[]): boolean {
  return words.some((w) => w === "-c" || EXEC_FLAGS.some((f) => w === f || w.startsWith(`${f}=`)));
}

function isRoutineKeryx(words: readonly string[]): boolean {
  const sub = words[1];
  const verb = words[2];
  if (sub === undefined) return false;
  if (sub === "review") {
    return verb === undefined || (!REVIEW_OUTBOUND_SUBCOMMANDS.has(verb) && !hasExecFlag(words));
  }
  if (sub === "flow") return verb !== undefined && FLOW_READ_SUBCOMMANDS.has(verb);
  if (sub === "gdgraph") return verb !== undefined && GRAPH_READ_SUBCOMMANDS.has(verb);
  if (sub !== "ctx" || verb === undefined) return false;
  if (verb === "run") {
    const dashes = words.indexOf("--");
    return dashes >= 3 && isRoutineSegment(words.slice(dashes + 1));
  }
  return CTX_SUBCOMMANDS.has(verb) && !hasExecFlag(words);
}

function isRoutineSegment(words: readonly string[]): boolean {
  if (words.length === 0 || stripAssignments(words).length !== words.length) return false;
  switch (words[0]) {
    case "cd":
      return words.length === 2;
    case "keryx":
      return isRoutineKeryx(words);
    case "bun":
      return words[1] === "test";
    case "git":
      return words[1] !== undefined && GIT_READ_SUBCOMMANDS.has(words[1]) && !hasExecFlag(words);
    default:
      return false;
  }
}

/** True for a short `&&` chain of local review/context/test/read-only commands (`cd` included). */
export function isTrustRoutineCommand(command: string): boolean {
  if (command.trim().length === 0) return false;
  if (isDestructiveCommand(command) || touchesAgentCredentials(command)) return false;
  if (touchesHumanConfirmation(command) || isPublishCommand(command)) return false;
  const segments = splitSegments(command);
  if (segments.length === 0 || segments.length > MAX_CHAIN_SEGMENTS) return false;
  return segments.every(
    (seg) =>
      (seg.precededBy === undefined || seg.precededBy === "&&") &&
      !hasUnquotedMetacharacter(seg.raw) &&
      isRoutineSegment(seg.words),
  );
}
