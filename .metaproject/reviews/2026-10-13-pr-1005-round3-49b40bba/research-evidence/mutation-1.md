# Mutation pass

Command: `bun test src/lib/trust-routine-command.test.ts src/sync/provenance.test.ts src/sync/diff.test.ts` (baseline exit 0, 1672 ms). Run in a scratch copy; the worktree was not written.

Killed 29, survived 3, timeout 0, invalid 0.

| Mutant | Where | Change | Result |
|---|---|---|---|
| B2-c-flag-prefix | src/lib/trust-routine-command.ts:120 | `rest === 2 &&` → `rest >= 2 &&` | killed |
| B16-dot-all-dropped | src/lib/trust-routine-command.ts:134 | `/^--[^=]+=-./s.test(w)` → `/^--[^=]+=-./.test(w)` | killed |
| B17-short-flag-prefix | src/lib/trust-routine-command.ts:134 | `/^--[^=]+=-./s.test(w)` → `/^-[^=]+=-./s.test(w)` | killed |
| G5-dashvalue-lone-dash-blocked | src/lib/trust-routine-command.ts:134 | `/^--[^=]+=-./s.test(w)` → `/^--[^=]+=-/s.test(w)` | killed |
| G6-dashvalue-off | src/lib/trust-routine-command.ts:134 | `words.some((w) => /^--[^=]+=-./s.test(w))` → `false` | killed |
| G7-dashvalue-call-dropped | src/lib/trust-routine-command.ts:314 | `args[0] === "review" && hasDashValue(args)` → `false` | killed |
| G9-eq-chain-dash-gate-dropped | src/lib/trust-routine-command.ts:124 | `if (!word.startsWith("-", at) \|\| eq === -1) return false;` → `if (eq === -1) return false;` | killed |
| G10-eq-chain-one-level | src/lib/trust-routine-command.ts:125 | `    at = eq + 1;   } }` → `    if (at > 0) return false;     at = eq + 1;   } }` | killed |
| G11-c-flag-off | src/lib/trust-routine-command.ts:120 | `if (rest === 2 && word.startsWith("-c", at)) return true;` → `` | killed |
| N1-c-flag-off | src/lib/trust-routine-command.ts:120 | `if (rest === 2 && word.startsWith("-c", at)) return true;` → `` | killed |
| N2-c-flag-prefix | src/lib/trust-routine-command.ts:120 | `rest === 2 &&` → `rest >= 2 &&` | killed |
| N3-flag-prefix-match | src/lib/trust-routine-command.ts:121 | `rest === f.length && word.startsWith(f, at)` → `word.startsWith(f, at)` | killed |
| N4-eq-prefix-off | src/lib/trust-routine-command.ts:122 | `if (EXEC_FLAG_PREFIXES.some((prefix) => word.startsWith(prefix, at))) return true;` → `` | killed |
| N5-dash-gate-dropped | src/lib/trust-routine-command.ts:124 | `if (!word.startsWith("-", at) \|\| eq === -1) return false;` → `if (eq === -1) return false;` | killed |
| N6-eq-chain-one-level | src/lib/trust-routine-command.ts:125 | `    at = eq + 1;   } }` → `    if (at > 0) return false;     at = eq + 1;   } }` | killed |
| N7-dotall-dropped | src/lib/trust-routine-command.ts:134 | `/^--[^=]+=-./s.test(w)` → `/^--[^=]+=-./.test(w)` | killed |
| N8-lone-dash-blocked | src/lib/trust-routine-command.ts:134 | `/^--[^=]+=-./s.test(w)` → `/^--[^=]+=-/s.test(w)` | killed |
| N9-dashvalue-call-dropped | src/lib/trust-routine-command.ts:314 | `args[0] === "review" && hasDashValue(args)` → `false` | killed |
| N10-expansion-gate-off | src/lib/trust-routine-command.ts:354 | `!(isJudgedByWords(seg.words) && hasUnquotedExpansion(seg.raw)) &&` → `` | killed |
| N11-judged-no-keryx | src/lib/trust-routine-command.ts:362 | `return words[0] === "git" \|\| words[0] === "keryx";` → `return words[0] === "git";` | killed |
| N12-judged-no-git | src/lib/trust-routine-command.ts:362 | `return words[0] === "git" \|\| words[0] === "keryx";` → `return words[0] === "keryx";` | killed |
| N13-keryx-execword-off | src/lib/trust-routine-command.ts:312 | `if (hasExecWord(words)) return false;` → `` | killed |
| N14-git-execword-off | src/lib/trust-routine-command.ts:334 | `GIT_READ_SUBCOMMANDS.has(words[1]) && !hasExecWord(words)` → `GIT_READ_SUBCOMMANDS.has(words[1])` | killed |
| N15-expansion-no-dollar | src/lib/shell-syntax.ts:125 | `ch === "\\" \|\| ch === "$" \|\| ch === "{" \|\| ch === "}") return true;` → `ch === "\\" \|\| ch === "{" \|\| ch === "}") return true;` | killed |
| N16-expansion-no-backslash | src/lib/shell-syntax.ts:125 | `ch === "\\" \|\| ch === "$" \|\| ch === "{" \|\| ch === "}") return true;` → `ch === "$" \|\| ch === "{" \|\| ch === "}") return true;` | killed |
| N17-expansion-no-open-brace | src/lib/shell-syntax.ts:125 | `ch === "\\" \|\| ch === "$" \|\| ch === "{" \|\| ch === "}") return true;` → `ch === "\\" \|\| ch === "$" \|\| ch === "}") return true;` | killed |
| N18-expansion-no-close-brace | src/lib/shell-syntax.ts:125 | `ch === "\\" \|\| ch === "$" \|\| ch === "{" \|\| ch === "}") return true;` → `ch === "\\" \|\| ch === "$" \|\| ch === "{") return true;` | killed |
| N19-expansion-unbalanced-open | src/lib/shell-syntax.ts:127 | `  return quote !== undefined; }` → `  return false; }` | killed |
| N21-provenance-hex-off | src/sync/provenance.ts:243 | `typeof commit === "string" && /^[0-9a-f]{4,64}$/i.test(commit)` → `typeof commit === "string"` | survived |
| N22-provenance-end-anchor | src/sync/provenance.ts:243 | `{4,64}$/i` → `{4,64}/i` | survived |
| N23-provenance-start-anchor | src/sync/provenance.ts:243 | `/^[0-9a-f]{4,64}$/i` → `/[0-9a-f]{4,64}$/i` | survived |
| N20-splitwords-dq-backslash-off | src/lib/shell-syntax.ts:219 | `      if (quote === '"' && ch === "\\" && next !== undefined) {         buf += ch + next;` → `      if (false) {         buf += ch + next;` | killed |

A survivor means no assertion pins that behaviour: the severity audit reads it as evidence.
