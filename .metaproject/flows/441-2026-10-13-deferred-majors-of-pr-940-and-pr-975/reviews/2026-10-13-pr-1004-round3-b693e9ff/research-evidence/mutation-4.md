# Mutation pass

Command: `bun test src/review/replay.test.ts` (baseline exit 0, 1190 ms). Run in a scratch copy; the worktree was not written.

Killed 19, survived 6, timeout 0, invalid 0.

| Mutant | Where | Change | Result |
|---|---|---|---|
| M01-no-git-guard-removed | src/review/replay.ts:133 | `if (!existsSync(path.join(root, ".git"))) return undefined;` → `` | killed |
| M02-never-git-mode | src/review/replay.ts:133 | `if (!existsSync(path.join(root, ".git"))) return undefined;` → `return undefined;` | killed |
| M03-ls-files-throw-off | src/review/replay.ts:135 | `if (listed.status !== 0) {` → `if (false) {` | killed |
| M04-backslash-escape-off | src/review/replay.ts:161 | `value.replaceAll("\\", "\\\\").` → `value.` | killed |
| M05-pipe-escape-off | src/review/replay.ts:161 | `.replaceAll("\|", "\\\|")` → `` | killed |
| M06-linebreak-collapse-off | src/review/replay.ts:161 | `.replace(/\r\n\|[\r\n]/g, " ")` → `` | killed |
| M07-cr-not-collapsed | src/review/replay.ts:161 | `/\r\n\|[\r\n]/g` → `/\n/g` | killed |
| M08-table-file-unescaped | src/review/replay.ts:178 | `\| ${cell(row.file)} \| ${row.hash}` → `\| ${row.file} \| ${row.hash}` | killed |
| M09-table-old-unescaped | src/review/replay.ts:178 | `\| ${cell(row.old)} \| ${cell(row.next)}` → `\| ${row.old} \| ${cell(row.next)}` | killed |
| M10-table-next-unescaped | src/review/replay.ts:178 | `\| ${cell(row.next)} \| ${row.cause}` → `\| ${row.next} \| ${row.cause}` | killed |
| M11-table-decision-unescaped | src/review/replay.ts:178 | `${cell(decisionFor(row, decisions))}` → `${decisionFor(row, decisions)}` | survived |
| M12-bullet-file-unescaped | src/review/replay.ts:189 | `- ${cell(row.file)} (` → `- ${row.file} (` | killed |
| M13-bullet-old-unescaped | src/review/replay.ts:189 | `: ${cell(row.old)}`` → `: ${row.old}`` | killed |
| M14-isfile-removed | src/review/replay.ts:145 | ` && lstatSync(absolute).isFile()` → `` | killed |
| M15-isfile-weakened | src/review/replay.ts:145 | `lstatSync(absolute).isFile()` → `!lstatSync(absolute).isSymbolicLink()` | killed |
| M16-realpath-equality-off | src/review/replay.ts:145 | `realpathSync(absolute) === absolute &&` → `realpathSync(absolute).length > 0 &&` | killed |
| M17-walk-prune-off | src/review/replay.ts:122 | `if (!SKIPPED_DIRS.has(entry.name)) stack.push(child);` → `stack.push(child);` | killed |
| M18-walk-prune-node-modules-only | src/review/replay.ts:122 | `if (!SKIPPED_DIRS.has(entry.name)) stack.push(child);` → `if (entry.name !== "node_modules") stack.push(child);` | killed |
| S15-realroot-unresolved | src/review/replay.ts:152 | `const realRoot = realpathSync(root);` → `const realRoot = root;` | killed |
| S07-maxbuffer-tiny | src/review/replay.ts:134 | `maxBuffer: 64 * 1024 * 1024` → `maxBuffer: 1000` | survived |
| M19-error-text-changed | src/review/replay.ts:197 | `no raw reviewer replies to replay found under` → `no replies` | killed |
| M20-env-scrub-off | src/review/replay.ts:129 | `env: withoutGitDiscoveryOverrides(process.env)` → `env: process.env` | survived |
| M21-scrub-drops-git-dir | src/lib/git-env.ts:16 | `  "GIT_DIR", ` → `` | survived |
| M22-scrub-drops-index-file | src/lib/git-env.ts:18 | `  "GIT_INDEX_FILE", ` → `` | survived |
| M23-scrub-drops-work-tree | src/lib/git-env.ts:17 | `  "GIT_WORK_TREE", ` → `` | survived |

A survivor means no assertion pins that behaviour: the severity audit reads it as evidence.
