# Mutation pass

Command: `bun test src/review/replay.test.ts` (baseline exit 0, 424 ms). Run in a scratch copy; the worktree was not written.

Killed 34, survived 7, timeout 0, invalid 0.

| Mutant | Where | Change | Result |
|---|---|---|---|
| M01-decision-fence-undecided | src/review/replay.ts:19 | `"fence-inner-backticks": "accepted (operator, poll 161, 2026-10-13)"` → `"fence-inner-backticks": "undecided"` | killed |
| M02-decision-status-only-undecided | src/review/replay.ts:20 | `"status-only-fragment": "accepted (operator, poll 162, 2026-10-13)"` → `"status-only-fragment": "undecided"` | killed |
| M03-decision-unclassified-accepted | src/review/replay.ts:21 | `  unclassified: "undecided",` → `  unclassified: "accepted",` | killed |
| M04-decision-none-accepted | src/review/replay.ts:22 | `  none: "undecided",` → `  none: "accepted",` | survived |
| M05-labelled-greedy | src/review/replay.ts:25 | `([\s\S]*?)```/gi;` → `([\s\S]*)```/gi;` | killed |
| M06-outcome-no-empty | src/review/replay.ts:28 | `  if (empty) return "empty"; ` → ` ` | killed |
| M07-outcome-none-as-empty | src/review/replay.ts:29 | `if (result === undefined) return "none";` → `if (result === undefined) return "empty";` | killed |
| M08-outcome-findings-dash | src/review/replay.ts:30 | `? String(result.findings.length) : "-";` → `? "-" : "-";` | killed |
| M09-outcome-reviewer-empty | src/review/replay.ts:31 | `${result.reviewer ?? "-"}` → `${result.reviewer ?? ""}` | killed |
| M10-outcome-reviewer-result-true | src/review/replay.ts:31 | `reviewer-result=${isReviewerResult(result)}`` → `reviewer-result=${true}`` | killed |
| M11-broken-no-labelled-true | src/review/replay.ts:36 | `if (labelled.length === 0) return false;` → `if (labelled.length === 0) return true;` | killed |
| M12-broken-first-fence | src/review/replay.ts:38 | `JSON.parse(labelled[labelled.length - 1]![1]!);     return false;` → `JSON.parse(labelled[0]![1]!);     return false;` | killed |
| M13-broken-parse-ok-true | src/review/replay.ts:38 | `JSON.parse(labelled[labelled.length - 1]![1]!);     return false;` → `JSON.parse(labelled[labelled.length - 1]![1]!);     return true;` | killed |
| M14-broken-catch-false | src/review/replay.ts:40 | `  } catch {     return true;   }` → `  } catch {     return false;   }` | killed |
| M15-classify-old-undefined-only | src/review/replay.ts:46 | `if (old === undefined && next !== undefined) return` → `if (old === undefined) return` | killed |
| M16-classify-fence-swap | src/review/replay.ts:46 | `labelledCaptureBroken(raw) ? "fence-inner-backticks" : "unclassified"` → `labelledCaptureBroken(raw) ? "unclassified" : "fence-inner-backticks"` | killed |
| M17-classify-fragment-any-old | src/review/replay.ts:47 | `if (old !== undefined && !isReviewerResult(old) && next === undefined)` → `if (old !== undefined && next === undefined)` | killed |
| M18-classify-fragment-any-next | src/review/replay.ts:47 | `if (old !== undefined && !isReviewerResult(old) && next === undefined)` → `if (old !== undefined && !isReviewerResult(old))` | killed |
| M19-classify-default-none | src/review/replay.ts:47 | `return "status-only-fragment";   return "unclassified";` → `return "status-only-fragment";   return "none";` | killed |
| M20-replayRaw-same-true | src/review/replay.ts:57 | `const same = before === after;` → `const same = true;` | killed |
| M21-hash-8 | src/review/replay.ts:60 | `.digest("hex").slice(0, 12),` → `.digest("hex").slice(0, 8),` | killed |
| M22-cause-always-classify | src/review/replay.ts:64 | `cause: same ? "none" : classify(raw, old, next),` → `cause: classify(raw, old, next),` | killed |
| M23-rawdir-name | src/review/replay.ts:80 | `if (entry === "raw") dirs.push(full);` → `if (entry === "rawx") dirs.push(full);` | killed |
| M24-walk-keeps-node-modules | src/review/replay.ts:81 | `entry !== "node_modules" && ` → `` | survived |
| M25-walk-keeps-research-evidence | src/review/replay.ts:81 | ` && entry !== "research-evidence"` → `` | killed |
| M26-walk-keeps-drivers | src/review/replay.ts:81 | ` && entry !== "drivers"` → `` | killed |
| M27-parents-drop-data-review | src/review/replay.ts:70 | `[".metaproject/flows", ".metaproject/data/review"]` → `[".metaproject/flows"]` | killed |
| M28-parents-drop-flows | src/review/replay.ts:70 | `[".metaproject/flows", ".metaproject/data/review"]` → `[".metaproject/data/review"]` | killed |
| M29-no-existsSync-guard | src/review/replay.ts:73 | `    if (!existsSync(base)) continue; ` → ` ` | killed |
| M30-dirs-unsorted | src/review/replay.ts:85 | `return dirs.sort();` → `return dirs;` | killed |
| M31-txt-filter-off | src/review/replay.ts:91 | `.filter((entry) => entry.endsWith(".txt"))` → `.filter((entry) => true)` | killed |
| M32-names-unsorted | src/review/replay.ts:91 | `.filter((entry) => entry.endsWith(".txt")).sort()` → `.filter((entry) => entry.endsWith(".txt"))` | killed |
| M33-relative-sep | src/review/replay.ts:92 | `.split(path.sep).join("/")` → `` | survived |
| M34-render-all-rows-differ | src/review/replay.ts:100 | `const differing = rows.filter((row) => !row.same);` → `const differing = rows;` | killed |
| M35-render-same-count | src/review/replay.ts:110 | `Same: ${rows.length - differing.length}.` → `Same: ${rows.length}.` | killed |
| M36-render-same-list-inverted | src/review/replay.ts:124 | `...rows.filter((row) => row.same).map((row) => `- ` → `...rows.filter((row) => !row.same).map((row) => `- ` | killed |
| M37-cli-root-parent | src/review/replay.ts:131 | `const root = process.cwd();` → `const root = path.resolve(process.cwd(), "..");` | survived |
| M38-cli-write-no-target-guard | src/review/replay.ts:137 | `if (!target) throw new Error("--write needs a target path");` → `` | survived |
| M39-cli-write-ignores-root | src/review/replay.ts:138 | `await Bun.write(path.resolve(root, target), report);` → `await Bun.write(target, report);` | survived |
| M40-legacy-nested-last-status | src/review/legacy-result-parser.ts:35 | `start = end; ` → ` ` | survived |
| M41-legacy-fence-greedy | src/review/legacy-result-parser.ts:9 | `([\s\S]*?)```/gi` → `([\s\S]*)```/gi` | killed |

A survivor means no assertion pins that behaviour: the severity audit reads it as evidence.
