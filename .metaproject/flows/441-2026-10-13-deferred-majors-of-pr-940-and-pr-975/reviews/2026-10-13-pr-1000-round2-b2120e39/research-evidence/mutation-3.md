# Mutation pass

Command: `bun test src/lib/trust-routine-command.test.ts src/lib/review-path-flags.test.ts src/lib/contained-path-place.test.ts src/commands/review-slice-paths.test.ts src/commands/agent-trust-orchestration.test.ts` (baseline exit 0, 846 ms). Run in a scratch copy; the worktree was not written.

Killed 106, survived 17, timeout 1, invalid 0.

| Mutant | Where | Change | Result |
|---|---|---|---|
| exp-tilde | src/lib/trust-routine-command.ts:223 | `value.startsWith("~") \|\| ` → `` | killed |
| exp-backslash | src/lib/trust-routine-command.ts:223 | `/[$\\*?[\]{}`]/` → `/[$*?[\]{}`]/` | survived |
| exp-dollar | src/lib/trust-routine-command.ts:223 | `/[$\\*?[\]{}`]/` → `/[\\*?[\]{}`]/` | killed |
| exp-star | src/lib/trust-routine-command.ts:223 | `/[$\\*?[\]{}`]/` → `/[$\\?[\]{}`]/` | killed |
| exp-qmark | src/lib/trust-routine-command.ts:223 | `/[$\\*?[\]{}`]/` → `/[$\\*[\]{}`]/` | killed |
| exp-bracket | src/lib/trust-routine-command.ts:223 | `/[$\\*?[\]{}`]/` → `/[$\\*?{}`]/` | killed |
| exp-brace | src/lib/trust-routine-command.ts:223 | `/[$\\*?[\]{}`]/` → `/[$\\*?[\]`]/` | killed |
| exp-backtick | src/lib/trust-routine-command.ts:223 | `/[$\\*?[\]{}`]/` → `/[$\\*?[\]{}]/` | survived |
| movedTo-empty | src/lib/trust-routine-command.ts:233 | `target === "" \|\| ` → `` | survived |
| movedTo-expandable | src/lib/trust-routine-command.ts:233 | ` \|\| isExpandable(target)) return undefined;` → `) return undefined;` | killed |
| movedTo-cdpath-ignored | src/lib/trust-routine-command.ts:235 | `cdpath !== undefined && cdpath !== "" && ` → `false && ` | killed |
| movedTo-cdpath-empty | src/lib/trust-routine-command.ts:235 | `cdpath !== undefined && cdpath !== ""` → `cdpath !== undefined` | killed |
| movedTo-abs-exempt | src/lib/trust-routine-command.ts:235 | `!path.isAbsolute(target) && ` → `` | killed |
| movedTo-cdpath-env-key | src/lib/trust-routine-command.ts:234 | `process.env.CDPATH` → `process.env.CDPATHX` | killed |
| preload-key | src/lib/trust-routine-command.ts:151 | `key === "preload" \|\| hasKey(inner)` → `hasKey(inner)` | killed |
| preload-nested | src/lib/trust-routine-command.ts:151 | `key === "preload" \|\| hasKey(inner)` → `key === "preload"` | killed |
| preload-key-case-insens | src/lib/trust-routine-command.ts:151 | `key === "preload"` → `key.toLowerCase() === "preload"` | survived |
| preload-key-wrong | src/lib/trust-routine-command.ts:151 | `key === "preload"` → `key === "preloadX"` | killed |
| preload-object-guard | src/lib/trust-routine-command.ts:151 | `typeof value === "object" && value !== null && ` → `` | killed |
| preload-null-guard | src/lib/trust-routine-command.ts:151 | ` && value !== null` → `` | survived |
| preload-parse-dropped | src/lib/trust-routine-command.ts:152 | `return hasKey(Bun.TOML.parse(text));` → `return false;` | killed |
| preload-text-scan-added | src/lib/trust-routine-command.ts:152 | `    return hasKey(Bun.TOML.parse(text));` → `    if (/preload/i.test(text)) return true;     return hasKey(Bun.TOML.parse(text));` | survived |
| state-file-name | src/lib/trust-routine-command.ts:165 | `path.join(root, "bunfig.toml")` → `path.join(root, "bunfigX.toml")` | killed |
| baseline-root-cwd | src/lib/trust-routine-command.ts:185 | `const root = realOrResolved(resolveProjectRoot(cwd));` → `const root = realOrResolved(cwd);` | killed |
| baseline-no-real | src/lib/trust-routine-command.ts:185 | `const root = realOrResolved(resolveProjectRoot(cwd));` → `const root = resolveProjectRoot(cwd);` | killed |
| baseline-default-cwd | src/lib/trust-routine-command.ts:184 | `cwd: string = process.cwd()): void {` → `cwd: string = "/"): void {` | killed |
| bun-untrusted | src/lib/trust-routine-command.ts:210 | `if (walk.untrusted \|\| walk.cwd === undefined) return false;` → `if (walk.cwd === undefined) return false;` | killed |
| bun-cwd-undefined | src/lib/trust-routine-command.ts:210 | `if (walk.untrusted \|\| walk.cwd === undefined) return false;` → `if (walk.untrusted) return false;` | killed |
| bun-cwd-root | src/lib/trust-routine-command.ts:212 | `if (realOrResolved(walk.cwd) !== root) return false;` → `` | killed |
| bun-root-real | src/lib/trust-routine-command.ts:211 | `const root = realOrResolved(walk.projectRoot);` → `const root = walk.projectRoot;` | killed |
| bun-cwd-real | src/lib/trust-routine-command.ts:212 | `if (realOrResolved(walk.cwd) !== root) return false;` → `if (path.resolve(walk.cwd) !== root) return false;` | killed |
| bun-args | src/lib/trust-routine-command.ts:213 | `if (!hasOnlyAllowedBunTestArgs(words.slice(2))) return false;` → `` | killed |
| bun-args-slice | src/lib/trust-routine-command.ts:213 | `hasOnlyAllowedBunTestArgs(words.slice(2))` → `hasOnlyAllowedBunTestArgs(words.slice(3))` | killed |
| args-count-set | src/lib/trust-routine-command.ts:37 | `new Set(["--rerun-each", "--timeout"])` → `new Set(["--timeout"])` | killed |
| args-eq-count | src/lib/trust-routine-command.ts:199 | `BUN_TEST_COUNT_FLAGS.has(arg.slice(0, eq)) && isNonNegativeInteger(arg.slice(eq + 1))` → `BUN_TEST_COUNT_FLAGS.has(arg.slice(0, eq))` | killed |
| args-eq-gt0 | src/lib/trust-routine-command.ts:199 | `eq > 0 &&` → `eq >= 0 &&` | survived |
| args-sep-count | src/lib/trust-routine-command.ts:200 | `if (BUN_TEST_COUNT_FLAGS.has(arg) && isNonNegativeInteger(args[i + 1])) {` → `if (BUN_TEST_COUNT_FLAGS.has(arg)) {` | killed |
| args-sep-skip | src/lib/trust-routine-command.ts:201 | `      i += 1;       continue;` → `      continue;` | killed |
| args-int-regex | src/lib/trust-routine-command.ts:190 | `/^\d+$/.test(value)` → `/\d+/.test(value)` | killed |
| args-int-star | src/lib/trust-routine-command.ts:190 | `/^\d+$/.test(value)` → `/^\d*$/.test(value)` | killed |
| args-int-undef | src/lib/trust-routine-command.ts:190 | `value !== undefined && /^\d+$/` → `/^\d+$/` | survived |
| rf-empty | src/lib/trust-routine-command.ts:246 | `if (values.length === 0) return true;` → `` | survived |
| rf-cwd-undef | src/lib/trust-routine-command.ts:247 | `if (walk.cwd === undefined \|\| values.some(isExpandable)) return false;` → `if (values.some(isExpandable)) return false;` | killed |
| rf-expandable | src/lib/trust-routine-command.ts:247 | `if (walk.cwd === undefined \|\| values.some(isExpandable)) return false;` → `if (walk.cwd === undefined) return false;` | killed |
| rf-verdict | src/lib/trust-routine-command.ts:248 | `return reviewPathFlagRefusal(sub, args, { projectRoot: walk.projectRoot, cwd: walk.cwd }) === undefined;` → `return true;` | killed |
| rf-verdict-cwd | src/lib/trust-routine-command.ts:248 | `{ projectRoot: walk.projectRoot, cwd: walk.cwd }` → `{ projectRoot: walk.projectRoot, cwd: walk.projectRoot }` | killed |
| rf-flags | src/lib/trust-routine-command.ts:245 | `confinedPathFlags(sub).flatMap((flag) => optionValues(args, flag))` → `confinedPathFlags(sub).flatMap((flag) => optionValues(args, flag).slice(0, 1))` | killed |
| rk-confined-gate | src/lib/trust-routine-command.ts:261 | `confinedPathFlags(sub).length > 0) {` → `false) {` | killed |
| rk-review-only | src/lib/trust-routine-command.ts:261 | `args[0] === "review" && sub !== undefined` → `sub !== undefined` | survived |
| rk-args-slice | src/lib/trust-routine-command.ts:262 | `areReviewPathFlagsInside(sub, args.slice(2), walk)` → `areReviewPathFlagsInside(sub, args.slice(3), walk)` | killed |
| rk-ctxrun-dashes | src/lib/trust-routine-command.ts:256 | `dashes >= 3` → `dashes >= 0` | survived |
| rk-ctxrun-dashes-b | src/lib/trust-routine-command.ts:256 | `dashes >= 3` → `dashes >= 2` | survived |
| rk-ctxrun-copy | src/lib/trust-routine-command.ts:256 | `isRoutineSegment(words.slice(dashes + 1), { ...walk })` → `isRoutineSegment(words.slice(dashes + 1), walk)` | killed |
| rk-ctxrun-slice | src/lib/trust-routine-command.ts:256 | `words.slice(dashes + 1)` → `words.slice(dashes)` | killed |
| rk-exec | src/lib/trust-routine-command.ts:258 | `  if (hasExecFlag(words)) return false;   if (!TRUST_ROUTINE_KEYRYX` → `  if (!TRUST_ROUTINE_KEYRYX` | killed |
| rk-table | src/lib/trust-routine-command.ts:259 | `if (!TRUST_ROUTINE_KEYRYX.some((entry) => matchesEntry(entry, args))) return false;` → `` | killed |
| rk-ctxrun-early | src/lib/trust-routine-command.ts:253 | `if (args[0] === "ctx" && args[1] === "run") {` → `if (false) {` | killed |
| seg-cd-arity | src/lib/trust-routine-command.ts:271 | `if (words.length !== 2) return false;` → `` | killed |
| seg-cd-move | src/lib/trust-routine-command.ts:272 | `walk.cwd = movedTo(walk.cwd, words[1] as string);` → `` | killed |
| seg-assign | src/lib/trust-routine-command.ts:268 | `stripAssignments(words).length !== words.length` → `false` | survived |
| seg-bun-test | src/lib/trust-routine-command.ts:277 | `words[1] === "test" && isRoutineBunTest(words, walk)` → `isRoutineBunTest(words, walk)` | killed |
| seg-git-exec | src/lib/trust-routine-command.ts:279 | `GIT_READ_SUBCOMMANDS.has(words[1]) && !hasExecFlag(words)` → `GIT_READ_SUBCOMMANDS.has(words[1])` | killed |
| top-walk-untrusted | src/lib/trust-routine-command.ts:294 | `untrusted: context.untrustedContent === true` → `untrusted: false` | killed |
| top-walk-root | src/lib/trust-routine-command.ts:294 | `projectRoot: resolveProjectRoot(cwd), cwd, untrusted` → `projectRoot: cwd, cwd, untrusted` | killed |
| top-cwd-default | src/lib/trust-routine-command.ts:293 | `path.resolve(context.cwd ?? process.cwd())` → `path.resolve(context.cwd ?? "/")` | killed |
| top-cap | src/lib/trust-routine-command.ts:292 | `segments.length > MAX_CHAIN_SEGMENTS` → `segments.length > 400` | killed |
| top-sep | src/lib/trust-routine-command.ts:297 | `(seg.precededBy === undefined \|\| seg.precededBy === "&&") &&` → `` | killed |
| rpf-stdin | src/lib/review-path-flags.ts:40 | `if (value === "-" && STDIN_FLAGS.has(flag)) return { ok: true, path: "-" };` → `` | killed |
| rpf-stdin-any-flag | src/lib/review-path-flags.ts:40 | `value === "-" && STDIN_FLAGS.has(flag)` → `value === "-"` | killed |
| rpf-stdin-set-diff | src/lib/review-path-flags.ts:26 | `new Set(["--diff", "--payload", "--result"])` → `new Set(["--payload", "--result"])` | killed |
| rpf-stdin-set-payload | src/lib/review-path-flags.ts:26 | `new Set(["--diff", "--payload", "--result"])` → `new Set(["--diff", "--result"])` | killed |
| rpf-stdin-set-result | src/lib/review-path-flags.ts:26 | `new Set(["--diff", "--payload", "--result"])` → `new Set(["--diff", "--payload"])` | killed |
| rpf-wrap-message | src/lib/review-path-flags.ts:42 | ``keryx review ${command} ${flag}: ${placed.message}`` → `placed.message` | killed |
| rpf-refusal-return | src/lib/review-path-flags.ts:54 | `if (!placed.ok) return placed.message;` → `` | killed |
| rpf-refusal-first | src/lib/review-path-flags.ts:52 | `for (const value of optionValues(args, flag)) {` → `for (const value of optionValues(args, flag).slice(0, 1)) {` | killed |
| rpf-hasown | src/lib/review-path-flags.ts:30 | `Object.hasOwn(REVIEW_CONFINED_PATH_FLAGS, command) ? (REVIEW_CONFINED_PATH_FLAGS[command] as readonly string[]) : []` → `(REVIEW_CONFINED_PATH_FLAGS[command] ?? []) as readonly string[]` | killed |
| rpf-table-slice-out | src/lib/review-path-flags.ts:13 | `slice: ["--diff", "--out"],` → `slice: ["--diff"],` | killed |
| rpf-table-slice-diff | src/lib/review-path-flags.ts:13 | `slice: ["--diff", "--out"],` → `slice: ["--out"],` | killed |
| rpf-table-retry-manifest | src/lib/review-path-flags.ts:14 | `"retry-plan": ["--manifest", "--result", "--state"],` → `"retry-plan": ["--result", "--state"],` | killed |
| rpf-table-retry-result | src/lib/review-path-flags.ts:14 | `"retry-plan": ["--manifest", "--result", "--state"],` → `"retry-plan": ["--manifest", "--state"],` | killed |
| rpf-table-retry-state | src/lib/review-path-flags.ts:14 | `"retry-plan": ["--manifest", "--result", "--state"],` → `"retry-plan": ["--manifest", "--result"],` | killed |
| rpf-table-dc-manifest | src/lib/review-path-flags.ts:15 | `"dispatch-check": ["--manifest", "--payload"],` → `"dispatch-check": ["--payload"],` | killed |
| rpf-table-dc-payload | src/lib/review-path-flags.ts:15 | `"dispatch-check": ["--manifest", "--payload"],` → `"dispatch-check": ["--manifest"],` | killed |
| cp-cwd | src/lib/contained-path.ts:146 | `const absolute = path.resolve(cwd, candidate);    let ancestor` → `const absolute = path.resolve(rootReal, candidate);    let ancestor` | killed |
| cp-lstat | src/lib/contained-path.ts:153 | `      lstatSync(ancestor);     } catch {       present = false;` → `      void ancestor;     } catch {       present = false;` | killed |
| cp-break-present | src/lib/contained-path.ts:157 | `    if (present) break;     const parent` → `    const parent` | killed |
| cp-parent-root | src/lib/contained-path.ts:159 | `if (parent === ancestor) break;` → `` | survived |
| cp-tail | src/lib/contained-path.ts:160 | `tail.unshift(path.basename(ancestor));` → `` | killed |
| cp-tail-order | src/lib/contained-path.ts:160 | `tail.unshift(path.basename(ancestor));` → `tail.push(path.basename(ancestor));` | killed |
| cp-null | src/lib/contained-path.ts:164 | `if (ancestorReal === null) {` → `if (false) {` | killed |
| cp-null-msg | src/lib/contained-path.ts:165 | `cannot be resolved (dangling or looping symlink).` → `resolves outside the project root.` | killed |
| cp-effective-tail | src/lib/contained-path.ts:167 | `path.join(ancestorReal, ...tail)` → `ancestorReal` | killed |
| cp-return-path | src/lib/contained-path.ts:171 | `return { ok: true, path: effective };` → `return { ok: true, path: absolute };` | killed |
| cp-isinside-dotdot | src/lib/contained-path.ts:67 | `return relative !== ".." && !relative.startsWith(`..${path.sep}`);` → `return !relative.startsWith("..");` | killed |
| rs-guard-throw | src/commands/review-slice.ts:45 | `    throw new Error(refusal);` → `    console.error(refusal);` | killed |
| rs-guard-refusal | src/commands/review-slice.ts:43 | `  const refusal = reviewPathFlagRefusal(command, args, where);   if (refusal !== undefined) {     throw new Error(refusal);   } ` → `` | killed |
| rs-guard-root | src/commands/review-slice.ts:42 | `projectRoot: resolveProjectRoot(cwd), cwd }` → `projectRoot: cwd, cwd }` | killed |
| rs-guard-late-throw | src/commands/review-slice.ts:51 | `if (!placed.ok) throw new Error(placed.message);     return placed.path;` → `return placed.ok ? placed.path : value;` | killed |
| rs-guard-late-path | src/commands/review-slice.ts:52 | `    return placed.path;` → `    return value;` | killed |
| rs-guard-fallback | src/commands/review-slice.ts:48 | `optionValue(args, flag) ?? fallback;` → `optionValue(args, flag);` | killed |
| rs-slice-guard | src/commands/review-slice.ts:142 | `const placed = guardPaths("slice", args);` → `const placed = (flag: string, fb?: string) => optionValue(args, flag) ?? fb;` | killed |
| rs-slice-diff | src/commands/review-slice.ts:146 | `const diffFile = placed("--diff");` → `const diffFile = optionValue(args, "--diff");` | killed |
| rs-slice-out-late | src/commands/review-slice.ts:155 | `const outDir = placed("--out", DEFAULT_SLICE_DIR) as string;` → `const outDir = path.resolve(optionValue(args, "--out") ?? DEFAULT_SLICE_DIR);` | killed |
| rs-slice-out-default | src/commands/review-slice.ts:155 | `placed("--out", DEFAULT_SLICE_DIR)` → `placed("--out", ".")` | killed |
| rs-dc-guard | src/commands/review-slice.ts:228 | `const placed = guardPaths("dispatch-check", args);` → `const placed = (flag: string, fb?: string) => optionValue(args, flag) ?? fb;` | killed |
| rs-dc-payload | src/commands/review-slice.ts:229 | `const payloadSource = placed("--payload");` → `const payloadSource = optionValue(args, "--payload");` | killed |
| rs-dc-manifest | src/commands/review-slice.ts:233 | `const manifestSource = placed("--manifest");   const rawMax` → `const manifestSource = optionValue(args, "--manifest");   const rawMax` | killed |
| rs-rp-guard | src/commands/review-slice.ts:264 | `const placed = guardPaths("retry-plan", args);` → `const placed = (flag: string, fb?: string) => optionValue(args, flag) ?? fb;` | killed |
| rs-rp-manifest | src/commands/review-slice.ts:265 | `const manifestSource = placed("--manifest");   const resultSource` → `const manifestSource = optionValue(args, "--manifest");   const resultSource` | killed |
| rs-rp-result | src/commands/review-slice.ts:266 | `const resultSource = placed("--result");` → `const resultSource = optionValue(args, "--result");` | killed |
| rs-rp-state | src/commands/review-slice.ts:276 | `placed("--state", path.join(manifestDir, RETRY_STATE_NAME)) as string` → `path.resolve(optionValue(args, "--state") ?? path.join(manifestDir, RETRY_STATE_NAME))` | killed |
| rs-rp-state-default | src/commands/review-slice.ts:276 | `path.join(manifestDir, RETRY_STATE_NAME)` → `RETRY_STATE_NAME` | killed |
| movedTo-real-compare | src/lib/trust-routine-command.ts:241 | `return realOrResolved(lexical) === path.resolve(realOrResolved(cwd), target) ? lexical : undefined;` → `return lexical;` | killed |
| movedTo-real-negated | src/lib/trust-routine-command.ts:241 | `return realOrResolved(lexical) === path.resolve(realOrResolved(cwd), target) ? lexical : undefined;` → `return realOrResolved(lexical) !== path.resolve(realOrResolved(cwd), target) ? lexical : undefined;` | killed |
| movedTo-real-cwd | src/lib/trust-routine-command.ts:241 | `path.resolve(realOrResolved(cwd), target) ? lexical` → `path.resolve(cwd, target) ? lexical` | survived |
| bunfig-isfile | src/lib/trust-routine-command.ts:168 | `if (!stat.isFile() \|\| stat.size > MAX_BUNFIG_BYTES) return { kind: "unreadable" };` → `if (stat.size > MAX_BUNFIG_BYTES) return { kind: "unreadable" };` | timeout |
| bunfig-size | src/lib/trust-routine-command.ts:168 | `if (!stat.isFile() \|\| stat.size > MAX_BUNFIG_BYTES) return { kind: "unreadable" };` → `if (!stat.isFile()) return { kind: "unreadable" };` | killed |
| bunfig-size-edge | src/lib/trust-routine-command.ts:168 | `stat.size > MAX_BUNFIG_BYTES` → `stat.size >= MAX_BUNFIG_BYTES` | survived |
| bunfig-enoent | src/lib/trust-routine-command.ts:171 | `=== "ENOENT" ? { kind: "absent" } : { kind: "unreadable" }` → `=== "ENOENT" ? { kind: "unreadable" } : { kind: "absent" }` | killed |
| bunfig-fp-kind | src/lib/trust-routine-command.ts:176 | `file.kind === "text" ? createHash("sha256").update(file.text).digest("hex") : file.kind` → `file.kind === "text" ? "text" : file.kind` | killed |
| bunfig-unreadable-routine | src/lib/trust-routine-command.ts:217 | `\|\| now.kind === "unreadable") return false;` → `) return false;` | survived |
| bunfig-preload-skip | src/lib/trust-routine-command.ts:218 | `return now.kind === "absent" \|\| !carriesPreload(now.text);` → `return true;` | killed |
| bunfig-baseline-cmp | src/lib/trust-routine-command.ts:217 | `baseline !== bunfigFingerprint(now)` → `false` | killed |
| rpf-no-extra-root | src/lib/review-path-flags.ts:41 | `placePathWithinSync(where.projectRoot, value, where.cwd)` → `placePathWithinSync(where.projectRoot, value, where.projectRoot)` | killed |

A survivor means no assertion pins that behaviour: the severity audit reads it as evidence.
