# Mutation pass

Command: `bun test src/lib/trust-routine-command.test.ts src/lib/contained-path-place.test.ts src/commands/review-slice-paths.test.ts src/commands/agent-trust-orchestration.test.ts src/commands/agent-fewer-prompts.test.ts` (baseline exit 0, 826 ms). Run in a scratch copy; the worktree was not written.

Killed 20, survived 6, timeout 0, invalid 0.

| Mutant | Where | Change | Result |
|---|---|---|---|
| cd-dash-option | src/lib/trust-routine-command.ts:219 | `target.startsWith("-") \|\| ` → `target === "-" \|\| ` | killed |
| expandable-dollar-only | src/lib/trust-routine-command.ts:210 | `value.startsWith("~") \|\| /[$\\*?[\]{}`]/.test(value)` → `value.startsWith("~") \|\| value.includes("$")` | killed |
| cdpath-ignored | src/lib/trust-routine-command.ts:221 | `cdpath !== undefined && cdpath !== "" && ` → `false && ` | killed |
| cdpath-dot-slash-not-exempt | src/lib/trust-routine-command.ts:221 | `!target.startsWith("./") && ` → `` | killed |
| preload-text-scan-dropped | src/lib/trust-routine-command.ts:149 | `if (/preload/i.test(text)) return true;` → `` | survived |
| preload-parse-dropped | src/lib/trust-routine-command.ts:153 | `return hasKey(Bun.TOML.parse(text));` → `return false;` | killed |
| preload-parse-failure-open | src/lib/trust-routine-command.ts:154 | `  } catch {     return true;   } }  function bunfigState` → `  } catch {     return false;   } }  function bunfigState` | killed |
| preload-key-case-sensitive | src/lib/trust-routine-command.ts:152 | `key.toLowerCase() === "preload"` → `key === "preload"` | survived |
| count-empty-allowed | src/lib/trust-routine-command.ts:179 | `/^\d+$/.test(value)` → `/^\d*$/.test(value)` | killed |
| ctx-run-shares-walk | src/lib/trust-routine-command.ts:239 | `isRoutineSegment(words.slice(dashes + 1), { ...walk })` → `isRoutineSegment(words.slice(dashes + 1), walk)` | killed |
| review-flags-not-checked | src/lib/trust-routine-command.ts:244 | `confinedPathFlags(sub).length > 0` → `false` | killed |
| bun-args-unchecked | src/lib/trust-routine-command.ts:202 | `if (!hasOnlyAllowedBunTestArgs(words.slice(2))) return false;` → `` | killed |
| bun-untrusted-ignored | src/lib/trust-routine-command.ts:199 | `if (walk.untrusted \|\| walk.cwd === undefined) return false;` → `if (walk.cwd === undefined) return false;` | killed |
| bun-cwd-not-root | src/lib/trust-routine-command.ts:201 | `if (realOrResolved(walk.cwd) !== root) return false;` → `` | killed |
| extra-root-not-inside | src/lib/contained-path.ts:157 | `real !== null && isInside(rootReal, real)` → `real !== null` | killed |
| unresolvable-says-outside | src/lib/contained-path.ts:178 | `cannot be resolved (dangling or looping symlink).` → `resolves outside the project root.` | killed |
| containment-dropped | src/lib/contained-path.ts:181 | `if (!allowed.some((root) => isInside(root, effective))) {` → `if (false) {` | killed |
| slice-out-judged-early | src/commands/review-slice.ts:155 | `const outDir = placed("--out", DEFAULT_SLICE_DIR) as string;` → `const outDir = path.resolve(optionValue(args, "--out") ?? DEFAULT_SLICE_DIR);` | killed |
| slice-diff-unplaced | src/commands/review-slice.ts:146 | `const diffFile = placed("--diff");` → `const diffFile = optionValue(args, "--diff");` | survived |
| dispatch-manifest-unplaced | src/commands/review-slice.ts:233 | `const manifestSource = placed("--manifest");   const rawMax` → `const manifestSource = optionValue(args, "--manifest");   const rawMax` | killed |
| retry-state-unplaced | src/commands/review-slice.ts:277 | `placed("--state", path.join(manifestDir, RETRY_STATE_NAME)) as string` → `path.resolve(optionValue(args, "--state") ?? path.join(manifestDir, RETRY_STATE_NAME))` | survived |
| stdin-dash-not-exempt | src/lib/review-path-flags.ts:40 | `if (value === "-" && STDIN_FLAGS.has(flag))` → `if (false)` | survived |
| own-key-lookup-dropped | src/lib/review-path-flags.ts:30 | `Object.hasOwn(REVIEW_CONFINED_PATH_FLAGS, command) ?` → `true ?` | killed |
| agent-latch-cwd-dropped | src/commands/agent.ts:5647 | `...(tool.workingDirectory === undefined ? {} : { cwd: tool.workingDirectory }),` → `` | survived |
| agent-latch-untrusted-dropped | src/commands/agent.ts:5646 | `untrustedContent: untrustedOrigin,       ...(tool` → `untrustedContent: false,       ...(tool` | killed |
| agent-tool-baseline-dropped | src/commands/agent.ts:2252 | `if (tool.workingDirectory !== undefined) recordBunfigBaseline(tool.workingDirectory);` → `` | killed |

A survivor means no assertion pins that behaviour: the severity audit reads it as evidence.
