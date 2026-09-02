// Harness-agnostic command classifier for the gdctx routing guard. This is the
// reusable core shared by every runtime (Claude, Codex, Cursor, …): given a
// shell command string, decide whether it should be routed through `keryx ctx`.
// It knows nothing about how any particular harness delivers the command or
// signals a block — that lives in the per-runtime adapters (runtimes.ts).
//
// The guard is deliberately NARROW (routing-only): it flags only the commands
// whose output floods context and where `keryx ctx` adds structural value
// (rg/grep, cat/head/tail, sed/awk file reads, find, recursive ls, git
// diff/log/show) and passes everything else through, so a generic output-
// compressing proxy can coexist. An explicit escape marker
// (`# keryx:raw <reason>`) always allows a raw command and self-documents why.

export interface HookClassification {
  block: boolean;
  // The raw command family that matched (e.g. "rg", "cat", "git log").
  matched?: string;
  // The `keryx ctx` form the agent should use instead.
  suggestion?: string;
  // Present (possibly empty string) when an escape marker allowed a raw command.
  escapeReason?: string;
}

// `# keryx:raw <reason>` anywhere in the command opts out of the guard.
const ESCAPE_MARKER = /#\s*keryx:raw\b[ \t]*([^\n]*)/i;

// Leading wrappers we skip past to find the real command in a segment.
const LEADING_SKIP = new Set(["sudo", "command", "time", "nice", "env", "builtin"]);

// Prefixes that mean the command is already routed / another tool's concern.
const ALREADY_ROUTED = new Set(["keryx", "rtk"]);

interface Route {
  readonly names: RegExp;
  readonly suggestion: string;
}

const ROUTES: readonly Route[] = [
  { names: /^(rg|grep|egrep|fgrep|ripgrep)$/, suggestion: 'keryx ctx rg "<pattern>" [path]' },
  { names: /^(cat|head|tail)$/, suggestion: "keryx ctx read <file> --mode compact" },
];

// `git <sub>` sub-commands whose output is long enough to route through ctx.
const GIT_ROUTABLE = /^(diff|log|show)$/;

// Split a command line into independently-executed STATEMENTS. A shallow split
// on sequencing connectors is enough to catch `cd x && rg y` without a full
// shell parser. `|` is deliberately NOT a separator here — see `firstStages`.
function statements(command: string): string[] {
  return command
    .split(/\|\||&&|;|\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * The first pipeline stage of each statement — the only stage that can be
 * operating on files.
 *
 * Everything downstream of a `|` reads STDIN. It is filtering a stream, not
 * searching a tree, and classifying it as though it named a file is what made
 * the guard unusable: `npm test | grep -E 'Tests'`, `bun test 2>&1 | tail -5`
 * and even `keryx ctx rg 'foo' | grep -c 'bar'` were all refused. The last one
 * is the tell — routing the search exactly as the rule demands and then counting
 * the results was refused.
 *
 * Only the first stage is dropped from consideration downstream, never the
 * first: `grep -rn foo src/ | head -20` is still a code search, and a rule that
 * allowed any piped command would disable the guard for its most common shape.
 *
 * `cat f | rg y` stays blocked, now at `cat f` rather than at `rg y`, which is
 * the more accurate place to catch it anyway.
 */
function firstStages(command: string): string[] {
  return statements(command)
    .map((statement) => statement.split("|")[0]?.trim() ?? "")
    .filter(Boolean);
}

// The meaningful leading tokens of a segment: skip env assignments (`FOO=bar`)
// and benign wrappers (`sudo`, `env`, …).
function leadingTokens(segment: string): string[] {
  const tokens = segment.split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i] ?? "";
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token) || LEADING_SKIP.has(token)) {
      i += 1;
      continue;
    }
    break;
  }
  return tokens.slice(i);
}

// Pure classifier — returns the first blocking match, or a non-blocking result.
export function classifyCommand(command: string): HookClassification {
  if (!command.trim()) {
    return { block: false };
  }

  const escape = ESCAPE_MARKER.exec(command);
  if (escape) {
    return { block: false, escapeReason: (escape[1] ?? "").trim() };
  }

  for (const segment of firstStages(command)) {
    const tokens = leadingTokens(segment);
    const first = tokens[0];
    if (!first || ALREADY_ROUTED.has(first)) {
      continue;
    }

    for (const route of ROUTES) {
      if (route.names.test(first)) {
        return { block: true, matched: first, suggestion: route.suggestion };
      }
    }

    // sed/awk that PRINT file content flood context; route them through the
    // generic compaction wrapper. Skip `sed -i` (in-place edit, no stdout).
    if (first === "sed" || first === "awk") {
      const inPlace =
        first === "sed" &&
        tokens.slice(1).some((t) => t === "-i" || t.startsWith("-i") || t === "--in-place");
      if (!inPlace) {
        return { block: true, matched: first, suggestion: "keryx ctx run -- <command>" };
      }
    }

    // Large listings: `find` (any) and recursive `ls` (`-R`/`--recursive`).
    if (first === "find") {
      return { block: true, matched: "find", suggestion: "keryx ctx run -- <command>" };
    }
    if (
      first === "ls" &&
      tokens.slice(1).some((t) => t === "--recursive" || /^-[A-Za-z]*R/.test(t))
    ) {
      return { block: true, matched: "ls -R", suggestion: "keryx ctx run -- <command>" };
    }

    if (first === "git" && tokens[1] && GIT_ROUTABLE.test(tokens[1])) {
      const suggestion =
        tokens[1] === "diff"
          ? "keryx ctx diff [--staged|--stat|<revision>]"
          : `keryx ctx run -- git ${tokens[1]} …`;
      return { block: true, matched: `git ${tokens[1]}`, suggestion };
    }
  }

  return { block: false };
}

// The guidance shown to the agent when a command is blocked.
export function buildBlockMessage(command: string, result: HookClassification): string {
  return [
    `[keryx ctx] Raw \`${result.matched}\` bypasses the gdctx routing layer (raw output floods context).`,
    `Use instead:  ${result.suggestion}`,
    `The routed form is compressed and recorded in the routing audit (ctx_used).`,
    `If raw output is genuinely required, append an escape marker with a reason:`,
    `  ${command.trim()}   # keryx:raw <why raw is needed>`,
  ].join("\n");
}
