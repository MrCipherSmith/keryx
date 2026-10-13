# Mutation pass

Command: `sh /tmp/claude-1000/-home-altsay-keryx/9ee4644d-bb9e-4e03-805d-a42446e23fea/scratchpad/run-tests.sh` (baseline exit 0, 765 ms). Run in a scratch copy; the worktree was not written.

Killed 32, survived 16, timeout 0, invalid 0.

| Mutant | Where | Change | Result |
|---|---|---|---|
| isTrustRoutineCommand-chain-cap | src/lib/trust-routine-command.ts:245 | `segments.length > MAX_CHAIN_SEGMENTS` → `segments.length > 400` | killed |
| isTrustRoutineCommand-separator | src/lib/trust-routine-command.ts:250 | `(seg.precededBy === undefined \|\| seg.precededBy === "&&") &&` → `` | killed |
| isTrustRoutineCommand-metachar | src/lib/trust-routine-command.ts:251 | `!hasUnquotedMetacharacter(seg.raw) &&` → `` | killed |
| isTrustRoutineCommand-substitution | src/lib/trust-routine-command.ts:241 | `if (/\$\(\|\$\{\|`/.test(command)) return false;` → `` | killed |
| isRoutineSegment-assignments | src/lib/trust-routine-command.ts:221 | `stripAssignments(words).length !== words.length` → `false` | survived |
| isRoutineSegment-cd-arity | src/lib/trust-routine-command.ts:224 | `if (words.length !== 2) return false;` → `` | survived |
| isRoutineSegment-cd-ignored | src/lib/trust-routine-command.ts:225 | `walk.cwd = movedTo(walk.cwd, words[1] as string);` → `` | killed |
| movedTo-expandable | src/lib/trust-routine-command.ts:194 | `if (cwd === undefined \|\| target === "-" \|\| isExpandable(target)) return undefined;` → `if (cwd === undefined) return undefined;` | survived |
| isRoutineKeryx-ctxrun-dashes | src/lib/trust-routine-command.ts:209 | `dashes >= 3` → `dashes >= 0` | survived |
| isRoutineKeryx-execflag | src/lib/trust-routine-command.ts:211 | `if (hasExecFlag(words)) return false;` → `` | killed |
| isRoutineKeryx-ctxrun-walk-copy | src/lib/trust-routine-command.ts:209 | `isRoutineSegment(words.slice(dashes + 1), { ...walk })` → `isRoutineSegment(words.slice(dashes + 1), walk)` | survived |
| isRoutineKeryx-confined-table | src/lib/trust-routine-command.ts:214 | `Object.hasOwn(REVIEW_CONFINED_PATH_FLAGS, sub)` → `false` | killed |
| isRoutineKeryx-requireFlag | src/lib/trust-routine-command.ts:119 | `entry.requireFlag === undefined \|\| args.includes(entry.requireFlag)` → `true` | killed |
| reviewPathFlagsStayInside-empty | src/lib/trust-routine-command.ts:200 | `if (values.length === 0) return true;` → `` | survived |
| reviewPathFlagsStayInside-expandable | src/lib/trust-routine-command.ts:201 | `if (walk.cwd === undefined \|\| values.some(isExpandable)) return false;` → `if (walk.cwd === undefined) return false;` | killed |
| reviewPathFlagsStayInside-verdict | src/lib/trust-routine-command.ts:202 | `return reviewPathFlagRefusal(sub, args, { projectRoot: walk.projectRoot, cwd: walk.cwd }) === undefined;` → `return true;` | killed |
| isRoutineBunTest-untrusted | src/lib/trust-routine-command.ts:179 | `if (walk.untrusted \|\| walk.cwd === undefined) return false;` → `if (walk.cwd === undefined) return false;` | killed |
| isRoutineBunTest-cwd | src/lib/trust-routine-command.ts:181 | `if (realOrResolved(walk.cwd) !== root) return false;` → `` | killed |
| isRoutineBunTest-args | src/lib/trust-routine-command.ts:182 | `if (!bunTestArgsAllowed(words.slice(2))) return false;` → `` | killed |
| isRoutineBunTest-preload-verdict | src/lib/trust-routine-command.ts:185 | ` && !now.preload;` → `;` | killed |
| isRoutineBunTest-fingerprint | src/lib/trust-routine-command.ts:185 | `baseline === now.fingerprint &&` → `` | killed |
| bunTestArgsAllowed-eq-count | src/lib/trust-routine-command.ts:168 | `BUN_TEST_COUNT_FLAGS.has(arg.slice(0, eq)) && isCount(arg.slice(eq + 1))` → `BUN_TEST_COUNT_FLAGS.has(arg.slice(0, eq))` | killed |
| bunTestArgsAllowed-sep-count | src/lib/trust-routine-command.ts:169 | `if (BUN_TEST_COUNT_FLAGS.has(arg) && isCount(args[i + 1])) {` → `if (BUN_TEST_COUNT_FLAGS.has(arg)) {` | killed |
| bunTestArgsAllowed-isCount-regex | src/lib/trust-routine-command.ts:159 | `/^\d+$/.test(value)` → `/\d+/.test(value)` | killed |
| bunfigState-preload-regex | src/lib/trust-routine-command.ts:145 | `preload: /(?:^\|[\s.[,{])"?preload"?\s*=/m.test(text)` → `preload: false` | killed |
| bunfigState-unreadable | src/lib/trust-routine-command.ts:148 | `return { fingerprint: "unreadable", preload: true };` → `return { fingerprint: "unreadable", preload: false };` | survived |
| bunfigState-enoent | src/lib/trust-routine-command.ts:147 | `code === "ENOENT") return { fingerprint: "absent", preload: false };` → `code === "ENOENTX") return { fingerprint: "absent", preload: false };` | killed |
| recordBunfigBaseline-first-wins | src/lib/trust-routine-command.ts:155 | `if (!bunfigBaselines.has(root)) bunfigBaselines.set(root, bunfigState(root).fingerprint);` → `bunfigBaselines.set(root, bunfigState(root).fingerprint);` | survived |
| recordBunfigBaseline-root | src/lib/trust-routine-command.ts:154 | `const root = realOrResolved(resolveProjectRoot(cwd));` → `const root = realOrResolved(cwd);` | survived |
| agent-baseline-call | src/commands/agent.ts:2249 | `recordBunfigBaseline();` → `` | survived |
| reviewPathFlagRefusal-verdict | src/lib/review-path-flags.ts:23 | `if (!placed.ok) return `keryx review ${command} ${flag}: ${placed.message}`;` → `` | killed |
| reviewPathFlagRefusal-metaproject-root | src/lib/review-path-flags.ts:22 | `[".metaproject"]` → `[]` | survived |
| reviewPathFlagRefusal-first-value-only | src/lib/review-path-flags.ts:21 | `for (const value of optionValues(args, flag)) {` → `for (const value of optionValues(args, flag).slice(0, 1)) {` | killed |
| flags-table-slice | src/lib/review-path-flags.ts:9 | `slice: ["--out"],` → `slice: [],` | killed |
| flags-table-retry-state | src/lib/review-path-flags.ts:10 | `"retry-plan": ["--manifest", "--state"],` → `"retry-plan": ["--manifest"],` | killed |
| flags-table-dispatch | src/lib/review-path-flags.ts:11 | `"dispatch-check": ["--manifest"],` → `"dispatch-check": [],` | killed |
| placePathWithinSync-extra-roots | src/lib/contained-path.ts:137 | `const allowed = [rootReal, ...extraRoots.map((extra) => realOf(path.resolve(rootReal, extra))).filter((real): real is string => real !== null)];` → `const allowed = [rootReal];` | survived |
| placePathWithinSync-cwd | src/lib/contained-path.ts:138 | `const absolute = path.resolve(cwd, candidate);` → `const absolute = path.resolve(rootReal, candidate);` | killed |
| placePathWithinSync-null-effective | src/lib/contained-path.ts:157 | `effective === null \|\| !allowed.some` → `!allowed.some` | survived |
| placePathWithinSync-tail | src/lib/contained-path.ts:156 | `path.join(ancestorReal, ...tail)` → `ancestorReal` | survived |
| placePathWithinSync-lstat | src/lib/contained-path.ts:145 | `lstatSync(ancestor);` → `void ancestor;` | killed |
| refuseOutsidePaths-throw | src/commands/review-slice.ts:38 | `throw new Error(refusal);` → `console.error(refusal);` | killed |
| refuseOutsidePaths-root | src/commands/review-slice.ts:36 | `projectRoot: resolveProjectRoot(cwd), cwd` → `projectRoot: cwd, cwd` | survived |
| runSlice-refuse | src/commands/review-slice.ts:128 | `refuseOutsidePaths("slice", args);` → `` | killed |
| runDispatchCheck-refuse | src/commands/review-slice.ts:213 | `refuseOutsidePaths("dispatch-check", args);` → `` | killed |
| runRetryPlan-refuse | src/commands/review-slice.ts:249 | `refuseOutsidePaths("retry-plan", args);` → `` | killed |
| runSlice-out-default | src/commands/review-slice.ts:134 | `path.resolve(optionValue(args, "--out") ?? DEFAULT_SLICE_DIR)` → `path.resolve(optionValue(args, "--out") ?? ".")` | killed |
| runRetryPlan-state-default | src/commands/review-slice.ts:262 | `path.resolve(optionValue(args, "--state") ?? path.join(manifestDir, RETRY_STATE_NAME))` → `path.resolve(optionValue(args, "--state") ?? RETRY_STATE_NAME)` | survived |

A survivor means no assertion pins that behaviour: the severity audit reads it as evidence.
