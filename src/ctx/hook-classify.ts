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

// `# keryx:raw <reason>` opts out of the guard — but only where a shell would
// read it as a comment. Matched against the raw string, a command that merely
// CONTAINS the marker inside a quoted argument opted itself out:
// `grep -rn '#keryx:raw' src/` and `git log --grep='# keryx:raw'` both passed.
// The asymmetry is what gave it away — `splitPipeline` in this same file was
// taught that a `|` inside quotes is not a pipe, and this was left quote-blind.
const ESCAPE_MARKER = /#\s*keryx:raw\b[ \t]*([^\n]*)/i;

/**
 * The escape reason, or null when the command carries no unquoted marker.
 *
 * Scans for a `#` that is outside quotes, which is the only position a shell
 * treats as starting a comment.
 */
function escapeReasonOf(command: string): string | null {
  let quote: string | null = null;
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i]!;
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char !== "#") continue;
    const match = ESCAPE_MARKER.exec(command.slice(i));
    if (match && match.index === 0) {
      return (match[1] ?? "").trim();
    }
  }
  return null;
}

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
 * Every pipeline stage of every statement, in order.
 *
 * The first version of this kept only the first stage, on the premise that
 * "everything downstream of a `|` reads STDIN". That premise is FALSE, and the
 * recorded lesson `allowlist-not-a-boundary.md` predicted exactly this: a
 * pattern matches text and the shell re-interprets that text. `grep -rn P DIR`,
 * `cat FILE`, `find`, `sed -n … FILE` and `git log` all take operands and never
 * read stdin, so a one-token prefix disabled the guard for its entire target
 * set — `true | grep -rn foo src/` ran a full tree search and was recorded as
 * compliant, which is the false-clean defect the native-tool half of this same
 * change was written to close.
 *
 * Position was the wrong discriminator; whether the stage NAMES A FILE is a
 * better one — see `readsStdin`. It is not a complete one, and the difference
 * matters: the block decision still requires `tokens[0]` to be a member of a
 * fixed name list, so `sh -c 'grep -rn foo src/'`, `$(…)`, backticks, `eval`
 * and `xargs` pass unclassified, exactly as they did before this rule existed.
 * The accepted lesson `allowlist-not-a-boundary.md` says why that ceiling is
 * structural: a list of command names is incomplete by construction, and the
 * shell re-interprets text the pattern already matched.
 *
 * So this is a better nudge, not a boundary. The honest next step is not a
 * larger parser — it is for the routing audit to distinguish
 * classified-and-allowed from could-not-classify, so `ctx_used` stops asserting
 * compliance it never observed.
 */
interface Stage {
  readonly text: string;
  /** First in its pipeline: nothing upstream, so nothing to read from stdin. */
  readonly isFirst: boolean;
}

function stages(command: string): Stage[] {
  const out: Stage[] = [];
  for (const statement of statements(command)) {
    const parts = splitPipeline(statement);
    parts.forEach((text, index) => {
      const trimmed = text.trim();
      if (trimmed) out.push({ text: trimmed, isFirst: index === 0 });
    });
  }
  return out;
}

/**
 * Split on `|`, ignoring pipes inside quotes.
 *
 * `grep -E 'Test Files|Tests '` is ONE stage; splitting inside the quoted
 * pattern invented a second one and blocked a command the guard is meant to
 * allow. Still a shallow parser — it does not handle escapes or here-docs — but
 * the quoted-pipe case is the one that occurs in real commands.
 */
function splitPipeline(statement: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (const char of statement) {
    if (quote) {
      if (char === quote) quote = null;
      current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    if (char === "|") {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

/** Tokens of a stage, treating a quoted run as a single token. */
function stageTokens(stage: string): string[] {
  return (stage.match(/'[^']*'|"[^"]*"|\S+/g) ?? []).filter(Boolean);
}

/**
 * Flags that take a value, so the token after them is NOT a path operand.
 *
 * Per command, not one shared set: `-f` means "read patterns from a file" to
 * grep and "follow" to tail, so a shared list swallowed `app.log` in
 * `tail -f app.log` and let a file read through. Getting this wrong is silent in
 * exactly one direction — it under-blocks — which is why it is spelled out.
 */
const VALUE_FLAGS: Record<string, ReadonlySet<string>> = {
  search: new Set(["-e", "--regexp", "-f", "--file", "-m", "--max-count", "-A", "-B", "-C", "--context"]),
  head: new Set(["-n", "--lines", "-c", "--bytes"]),
  tail: new Set(["-n", "--lines", "-c", "--bytes"]),
  sed: new Set(["-e", "--expression", "-f", "--file"]),
  awk: new Set(["-f", "-v"]),
};

function valueFlagsFor(command: string, searchLike: boolean): ReadonlySet<string> {
  return searchLike ? VALUE_FLAGS.search! : (VALUE_FLAGS[command] ?? new Set<string>());
}

/**
 * True when this stage is filtering a stream rather than reading the tree.
 *
 * The distinction the change was actually reaching for: `grep -E 'Tests'` has a
 * pattern and no path, so it can only be reading stdin; `grep -rn foo src/`
 * names a directory. A recursive flag settles it on its own — `-r` with no path
 * still walks the working directory.
 *
 * `find`, `ls` and `git log|diff|show` never read stdin in any useful sense and
 * are therefore never filters, whatever their position.
 */
function readsStdin(tokens: readonly string[], isFirst: boolean): boolean {
  const [command, ...rest] = tokens;
  if (!command) {
    return true;
  }
  if (/^(find|ls|git)$/.test(command)) {
    return false;
  }
  // `rg` defaults to a RECURSIVE search of the working directory, so `rg y` with
  // no path is a tree search — unlike `grep y`, which reads stdin. It is a
  // filter only when something upstream is feeding it. This is the one place
  // position legitimately matters, and getting it wrong let `cd x && rg y`
  // through, which is the case the statement split exists to catch.
  if (/^(rg|ripgrep)$/.test(command) && isFirst) {
    return false;
  }
  const searchLike = /^(rg|grep|egrep|fgrep|ripgrep)$/.test(command);
  const valueFlags = valueFlagsFor(command, searchLike);
  // The first operand of a search is its PATTERN, and of sed/awk its SCRIPT —
  // neither is a path. Giving the allowance only to search-like commands refused
  // `bun test | sed -n '1,5p'` and `bun test | awk '{print $1}'`: exactly the
  // false-block class this whole rule exists to prevent, moved one command over.
  let operandsAllowed = searchLike || /^(sed|awk)$/.test(command) ? 1 : 0;
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i] ?? "";
    const [flag, attached] = splitFlagValue(token);
    // Scoped to commands that HAVE a pattern or script. Applying it to every
    // command reintroduced the `tail -f app.log` bug one layer up: `-f` is
    // "follow" to tail and the check ate the filename as its value. The same
    // mistake the per-command VALUE_FLAGS table exists to prevent.
    if (operandsAllowed > 0 && PATTERN_FLAGS.has(flag)) {
      // The pattern came from the flag, so the operand allowance was never
      // spent on it — and every remaining operand is a path. Without this,
      // `grep -e foo file.ts` passed: the allowance absorbed the FILE.
      operandsAllowed = 0;
      if (attached === null) i += 1;
      continue;
    }
    if (valueFlags.has(flag)) {
      if (attached === null) i += 1; // the value is the next token, not an operand
      continue;
    }
    if (token.startsWith("-")) {
      if (searchLike && isRecursiveFlag(token)) {
        return false; // recursive: walks the tree with or without a path
      }
      continue;
    }
    if (operandsAllowed > 0) {
      operandsAllowed -= 1;
      continue;
    }
    return false; // a path operand: this stage reads files
  }
  return true;
}

/**
 * Flags that SUPPLY the pattern or script, so no operand is spent on it.
 *
 * Only consulted while an operand allowance is still outstanding, which is the
 * same thing as "this command takes a pattern or a script".
 */
const PATTERN_FLAGS = new Set(["-e", "--regexp", "-f", "--file", "--expression"]);

/** `--flag=value` and `-fvalue` split into the flag and its attached value. */
function splitFlagValue(token: string): [string, string | null] {
  if (token.startsWith("--")) {
    const eq = token.indexOf("=");
    return eq === -1 ? [token, null] : [token.slice(0, eq), token.slice(eq + 1)];
  }
  if (token.startsWith("-") && token.length > 2) {
    return [token.slice(0, 2), token.slice(2)];
  }
  return [token, null];
}

/**
 * Recursive in any spelling.
 *
 * The short-only `/^-[a-zA-Z]*[rR]/` could never match a long option — after
 * `^-` the next character is `-`, which `[a-zA-Z]*` cannot consume — so
 * `grep --recursive foo` walked the tree unguarded while `grep -r foo` blocked.
 */
function isRecursiveFlag(token: string): boolean {
  return (
    token === "--recursive" ||
    token === "--dereference-recursive" ||
    /^-[a-zA-Z]*[rR]/.test(token)
  );
}

// The meaningful leading tokens of a segment: skip env assignments (`FOO=bar`)
// and benign wrappers (`sudo`, `env`, …).
function leadingTokens(segment: string): string[] {
  const tokens = stageTokens(segment);
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

  const escapeReason = escapeReasonOf(command);
  if (escapeReason !== null) {
    return { block: false, escapeReason };
  }

  for (const stage of stages(command)) {
    const tokens = leadingTokens(stage.text);
    if (readsStdin(tokens, stage.isFirst)) {
      continue;
    }
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
