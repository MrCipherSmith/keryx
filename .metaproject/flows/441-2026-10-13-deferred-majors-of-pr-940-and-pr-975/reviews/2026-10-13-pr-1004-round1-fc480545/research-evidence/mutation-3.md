# Mutation pass

Command: `bun test src/review/replay.test.ts` (baseline exit 0, 850 ms). Run in a scratch copy; the worktree was not written.

Killed 44, survived 1, timeout 0, invalid 0.

| Mutant | Where | Change | Result |
|---|---|---|---|
| N01-decision-161-undecided | src/review/replay.ts:23 | `const POLL_161 = "accepted (operator, poll 161, 2026-10-13)";` → `const POLL_161 = "undecided";` | killed |
| N02-decision-162-163-undecided | src/review/replay.ts:24 | `const POLL_162_163 = "accepted (operator, polls 162 and 163, 2026-10-13)";` → `const POLL_162_163 = "undecided";` | killed |
| N03-decision-fallback-accepted | src/review/replay.ts:47 | `(decisions[decisionKey(row)] ?? "undecided")` → `(decisions[decisionKey(row)] ?? "accepted")` | killed |
| N04-decision-key-separator | src/review/replay.ts:27 | `return `${row.file}@${row.hash}`;` → `return `${row.file}#${row.hash}`;` | killed |
| N05-decision-key-file-only | src/review/replay.ts:27 | `return `${row.file}@${row.hash}`;` → `return row.file;` | killed |
| N06-labelled-greedy | src/review/replay.ts:50 | `([\s\S]*?)```/gi;` → `([\s\S]*)```/gi;` | killed |
| N07-outcome-no-empty | src/review/replay.ts:53 | `  if (empty) return "empty"; ` → ` ` | killed |
| N08-outcome-none-as-empty | src/review/replay.ts:54 | `if (result === undefined) return "none";` → `if (result === undefined) return "empty";` | killed |
| N09-outcome-findings-dash | src/review/replay.ts:55 | `? String(result.findings.length) : "-";` → `? "-" : "-";` | killed |
| N10-outcome-reviewer-result-true | src/review/replay.ts:56 | `reviewer-result=${isReviewerResult(result)}`` → `reviewer-result=${true}`` | killed |
| N11-broken-no-labelled-true | src/review/replay.ts:61 | `if (labelled.length === 0) return false;` → `if (labelled.length === 0) return true;` | killed |
| N12-broken-first-fence | src/review/replay.ts:63 | `JSON.parse(labelled[labelled.length - 1]![1]!);     return false;` → `JSON.parse(labelled[0]![1]!);     return false;` | killed |
| N13-broken-catch-false | src/review/replay.ts:65 | `  } catch {     return true;   }` → `  } catch {     return false;   }` | killed |
| N14-classify-old-undefined-only | src/review/replay.ts:71 | `if (old === undefined && next !== undefined) return` → `if (old === undefined) return` | killed |
| N15-classify-fence-swap | src/review/replay.ts:71 | `labelledCaptureBroken(raw) ? "fence-inner-backticks" : "unclassified"` → `labelledCaptureBroken(raw) ? "unclassified" : "fence-inner-backticks"` | killed |
| N16-classify-fragment-any-old | src/review/replay.ts:72 | `if (old !== undefined && !isReviewerResult(old) && next === undefined)` → `if (old !== undefined && next === undefined)` | killed |
| N17-classify-fragment-any-next | src/review/replay.ts:72 | `if (old !== undefined && !isReviewerResult(old) && next === undefined)` → `if (old !== undefined && !isReviewerResult(old))` | killed |
| N18-same-always-true | src/review/replay.ts:89 | `const same = before === after && isDeepStrictEqual(old, next);` → `const same = true;` | killed |
| N19-same-outcome-only | src/review/replay.ts:89 | `const same = before === after && isDeepStrictEqual(old, next);` → `const same = before === after;` | killed |
| N20-hash-8 | src/review/replay.ts:92 | `.digest("hex").slice(0, 12),` → `.digest("hex").slice(0, 8),` | killed |
| N21-cause-always-classify | src/review/replay.ts:96 | `cause: same ? "none" : classify(raw, old, next),` → `cause: classify(raw, old, next),` | killed |
| N22-replayable-txt-off | src/review/replay.ts:106 | `return name.endsWith(".txt") && ` → `return true && ` | killed |
| N23-replayable-raw-name | src/review/replay.ts:106 | `parts[parts.length - 2] === "raw"` → `parts[parts.length - 2] === "rawx"` | killed |
| N24-replayable-keeps-nested-raw | src/review/replay.ts:106 | `SKIPPED_DIRS.has(part) \|\| part === "raw"` → `SKIPPED_DIRS.has(part)` | killed |
| N25-ancestors-include-parent | src/review/replay.ts:105 | `parts.slice(0, -2)` → `parts.slice(0, -1)` | killed |
| N26-skip-keeps-node-modules | src/review/replay.ts:100 | `new Set(["node_modules", "research-evidence", "drivers"])` → `new Set(["research-evidence", "drivers"])` | killed |
| N27-skip-keeps-research-evidence | src/review/replay.ts:100 | `new Set(["node_modules", "research-evidence", "drivers"])` → `new Set(["node_modules", "drivers"])` | killed |
| N28-skip-keeps-drivers | src/review/replay.ts:100 | `new Set(["node_modules", "research-evidence", "drivers"])` → `new Set(["node_modules", "research-evidence"])` | killed |
| N29-walk-no-existsSync-guard | src/review/replay.ts:111 | `  if (!existsSync(path.join(root, relative))) return files; ` → ` ` | killed |
| N30-walk-skips-directories | src/review/replay.ts:117 | `if (entry.isDirectory()) stack.push(child);` → `if (false) stack.push(child);` | killed |
| N31-walk-skips-files | src/review/replay.ts:118 | `else if (entry.isFile()) files.push(child);` → `else if (false) files.push(child);` | killed |
| N32-toplevel-guard-off | src/review/replay.ts:126 | `if (top.status !== 0 \|\| realpathSync(top.stdout.trim()) !== realpathSync(root)) return undefined;` → `if (top.status !== 0) return undefined;` | killed |
| N33-ls-files-not-nul | src/review/replay.ts:129 | `return listed.stdout.split("\0").filter((entry) => entry !== "");` → `return listed.stdout.split("\n").filter((entry) => entry !== "");` | killed |
| N34-ls-files-status-ignored | src/review/replay.ts:128 | `if (listed.status !== 0) return undefined; ` → ` ` | survived |
| N35-symlink-filter-off | src/review/replay.ts:136 | `    .filter((relative) => !lstatSync(path.join(root, relative)).isSymbolicLink()) ` → ` ` | killed |
| N36-candidates-unsorted | src/review/replay.ts:137 | `    .sort()     .map((relative) => replayRaw(` → `    .map((relative) => replayRaw(` | killed |
| N37-fallback-to-data-review | src/review/replay.ts:133 | `trackedFiles(root, ".metaproject/flows") ?? walkFiles(root, ".metaproject/flows")` → `trackedFiles(root, ".metaproject") ?? walkFiles(root, ".metaproject")` | killed |
| N38-zero-rows-allowed | src/review/replay.ts:175 | `if (rows.length === 0) throw` → `if (false) throw` | killed |
| N39-cli-root-cwd | src/review/replay.ts:180 | `replayReport(path.resolve(import.meta.dir, "..", ".."))` → `replayReport(process.cwd())` | killed |
| N40-cli-target-guard-off | src/review/replay.ts:185 | `    if (!target) throw new Error("--write needs a target path"); ` → ` ` | killed |
| N41-cli-write-ignored | src/review/replay.ts:186 | `await Bun.write(path.resolve(target), report);` → `process.stdout.write(report);` | killed |
| N42-legacy-greedy-fence | src/review/legacy-result-parser.ts:9 | `([\s\S]*?)```/gi` → `([\s\S]*)```/gi` | killed |
| N43-legacy-nested-skip-off | src/review/legacy-result-parser.ts:35 | `          start = end; ` → ` ` | killed |
| N44-legacy-first-labelled | src/review/legacy-result-parser.ts:12 | `JSON.parse(labelled[labelled.length - 1]![1]!)` → `JSON.parse(labelled[0]![1]!)` | killed |
| N45-legacy-last-status-first | src/review/legacy-result-parser.ts:34 | `if (typeof parsed.status === "string") result = parsed as ParsedResult;` → `if (typeof parsed.status === "string" && result === undefined) result = parsed as ParsedResult;` | killed |

A survivor means no assertion pins that behaviour: the severity audit reads it as evidence.
