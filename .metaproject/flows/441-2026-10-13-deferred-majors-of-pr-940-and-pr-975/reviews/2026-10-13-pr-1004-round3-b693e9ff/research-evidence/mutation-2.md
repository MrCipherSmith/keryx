# Mutation pass

Command: `bun test src/review/replay.test.ts` (baseline exit 0, 1455 ms). Run in a scratch copy; the worktree was not written.

Killed 26, survived 5, timeout 0, invalid 0.

| Mutant | Where | Change | Result |
|---|---|---|---|
| P34-ls-files-throw-off | src/review/replay.ts:134 | `if (listed.status !== 0) {` → `if (false) {` | killed |
| P35-plain-file-filter-off | src/review/replay.ts:154 | `    .filter((relative) => isPlainFileUnder(realRoot, relative)) ` → ` ` | killed |
| P07-containment-leaf-only | src/review/replay.ts:143 | `return realpathSync(path.join(realRoot, relative)) === path.join(realRoot, relative);` → `return realpathSync(path.join(realRoot, relative)).length > 0;` | killed |
| S01-toplevel-compare-off | src/review/replay.ts:132 | ` \|\| realpathSync(top.stdout.trim()) !== realpathSync(root)` → `` | killed |
| S02-revparse-status-ignored | src/review/replay.ts:132 | `top.status !== 0 \|\|` → `false \|\|` | killed |
| S04-below-top-throws | src/review/replay.ts:132 | `!== realpathSync(root)) return undefined;` → `!== realpathSync(root)) throw new Error("x");` | killed |
| S05-ls-files-no-z | src/review/replay.ts:133 | `"ls-files", "-z", "--", relative` → `"ls-files", "--", relative` | killed |
| S06-pathspec-widened | src/review/replay.ts:133 | `"ls-files", "-z", "--", relative` → `"ls-files", "-z", "--", "."` | killed |
| S07-maxbuffer-tiny | src/review/replay.ts:133 | `maxBuffer: 64 * 1024 * 1024` → `maxBuffer: 1000` | survived |
| S09-env-scrub-off | src/review/replay.ts:127 | `env: withoutGitDiscoveryOverrides(process.env)` → `env: process.env` | killed |
| S10-sort-off | src/review/replay.ts:155 | `    .sort() ` → ` ` | killed |
| S11-cell-identity | src/review/replay.ts:159 | `value.replaceAll("\|", "\\\|")` → `value` | killed |
| S12-same-count-wrong | src/review/replay.ts:172 | `${rows.length - differing.length}` → `${rows.length}` | killed |
| S13-decisionfor-same-ignored | src/review/replay.ts:48 | `row.same ? "none"` → `false ? "none"` | killed |
| S14-undecided-default-accepted | src/review/replay.ts:48 | `?? "undecided"` → `?? "accepted"` | killed |
| S15-realroot-unresolved | src/review/replay.ts:150 | `const realRoot = realpathSync(root);` → `const realRoot = root;` | survived |
| S17-parent-raw-check-off | src/review/replay.ts:109 | `parts[parts.length - 2] === "raw"` → `true` | killed |
| S18-nested-raw-allowed | src/review/replay.ts:109 | `\|\| part === "raw")` → `\|\| false)` | killed |
| S19-drivers-not-skipped | src/review/replay.ts:103 | `"research-evidence", "drivers"` → `"research-evidence"` | killed |
| S21-walk-exists-guard-off | src/review/replay.ts:114 | `if (!existsSync(path.join(root, relative))) return files;` → `` | killed |
| S22-classify-always-fence | src/review/replay.ts:72 | `return labelledCaptureBroken(raw) ? "fence-inner-backticks" : "unclassified";` → `return "fence-inner-backticks";` | killed |
| S23-empty-guard-off | src/review/replay.ts:195 | `if (rows.length === 0) throw` → `if (false) throw` | killed |
| S24-hash-11 | src/review/replay.ts:95 | `.slice(0, 12)` → `.slice(0, 11)` | killed |
| S25-root-from-cwd | src/review/replay.ts:200 | `path.resolve(import.meta.dir, "..", "..")` → `process.cwd()` | killed |
| S26-write-target-guard-off | src/review/replay.ts:205 | `if (!target) throw` → `if (false) throw` | survived |
| S27-catch-returns-true | src/review/replay.ts:144 | `} catch {     return false;   } }  export function replayRepository` → `} catch {     return true;   } }  export function replayRepository` | killed |
| S28-empty-entry-kept | src/review/replay.ts:137 | `.filter((entry) => entry !== "")` → `` | survived |
| S30-reviewer-result-const | src/review/replay.ts:57 | `reviewer-result=${isReviewerResult(result)}` → `reviewer-result=true` | killed |
| S31-no-git-mode | src/review/replay.ts:151 | `trackedFiles(root, ".metaproject/flows") ?? walkFiles(root, ".metaproject/flows")` → `walkFiles(root, ".metaproject/flows")` | killed |
| S32-stderr-dropped | src/review/replay.ts:135 | `: ${listed.stderr.trim()}`` → ``` | survived |
| S33-skipped-dirs-not-applied | src/review/replay.ts:109 | `ancestors.some((part) => SKIPPED_DIRS.has(part) \|\|` → `ancestors.some((part) => false \|\|` | killed |

A survivor means no assertion pins that behaviour: the severity audit reads it as evidence.
