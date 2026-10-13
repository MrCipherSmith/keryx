# Mutation pass

Command: `bun test src/lib/trust-routine-command.test.ts src/lib/contained-path-place.test.ts src/commands/review-slice-paths.test.ts src/commands/agent-trust-orchestration.test.ts` (baseline exit 0, 682 ms). Run in a scratch copy; the worktree was not written.

Killed 96, survived 53, timeout 0, invalid 0.

| Mutant | Where | Change | Result |
|---|---|---|---|
| exp-tilde | src/lib/trust-routine-command.ts:208 | `value.startsWith("~") \|\| ` → `` | killed |
| exp-backslash | src/lib/trust-routine-command.ts:208 | `/[$\\*?[\]{}`]/` → `/[$*?[\]{}`]/` | killed |
| exp-dollar | src/lib/trust-routine-command.ts:208 | `/[$\\*?[\]{}`]/` → `/[\\*?[\]{}`]/` | killed |
| exp-star | src/lib/trust-routine-command.ts:208 | `/[$\\*?[\]{}`]/` → `/[$\\?[\]{}`]/` | killed |
| exp-qmark | src/lib/trust-routine-command.ts:208 | `/[$\\*?[\]{}`]/` → `/[$\\*[\]{}`]/` | killed |
| exp-bracket | src/lib/trust-routine-command.ts:208 | `/[$\\*?[\]{}`]/` → `/[$\\*?{}`]/` | killed |
| exp-brace | src/lib/trust-routine-command.ts:208 | `/[$\\*?[\]{}`]/` → `/[$\\*?[\]`]/` | killed |
| exp-backtick | src/lib/trust-routine-command.ts:208 | `/[$\\*?[\]{}`]/` → `/[$\\*?[\]{}]/` | survived |
| movedTo-empty | src/lib/trust-routine-command.ts:217 | `target === "" \|\| ` → `` | survived |
| movedTo-dash-prefix | src/lib/trust-routine-command.ts:217 | `target.startsWith("-")` → `target === "-"` | killed |
| movedTo-expandable | src/lib/trust-routine-command.ts:217 | ` \|\| isExpandable(target)) return undefined;` → `) return undefined;` | killed |
| movedTo-cdpath-ignored | src/lib/trust-routine-command.ts:219 | `cdpath !== undefined && cdpath !== "" && ` → `false && ` | killed |
| movedTo-cdpath-empty | src/lib/trust-routine-command.ts:219 | `cdpath !== undefined && cdpath !== ""` → `cdpath !== undefined` | survived |
| movedTo-abs-exempt | src/lib/trust-routine-command.ts:219 | `!path.isAbsolute(target) && ` → `` | survived |
| movedTo-dotslash-exempt | src/lib/trust-routine-command.ts:219 | `!target.startsWith("./") && ` → `` | killed |
| movedTo-dotdotslash-exempt | src/lib/trust-routine-command.ts:219 | ` && !target.startsWith("../")` → `` | survived |
| movedTo-resolve-base | src/lib/trust-routine-command.ts:222 | `return path.resolve(cwd, target);` → `return path.resolve(target);` | killed |
| movedTo-cdpath-env-key | src/lib/trust-routine-command.ts:218 | `process.env.CDPATH` → `process.env.CDPATHX` | killed |
| preload-key | src/lib/trust-routine-command.ts:150 | `key === "preload" \|\| hasKey(inner)` → `hasKey(inner)` | killed |
| preload-nested | src/lib/trust-routine-command.ts:150 | `key === "preload" \|\| hasKey(inner)` → `key === "preload"` | killed |
| preload-key-case-insens | src/lib/trust-routine-command.ts:150 | `key === "preload"` → `key.toLowerCase() === "preload"` | survived |
| preload-key-wrong | src/lib/trust-routine-command.ts:150 | `key === "preload"` → `key === "preloadX"` | killed |
| preload-object-guard | src/lib/trust-routine-command.ts:150 | `typeof value === "object" && value !== null && ` → `` | survived |
| preload-null-guard | src/lib/trust-routine-command.ts:150 | ` && value !== null` → `` | survived |
| preload-parse-dropped | src/lib/trust-routine-command.ts:151 | `return hasKey(Bun.TOML.parse(text));` → `return false;` | killed |
| preload-parse-failure-open | src/lib/trust-routine-command.ts:152 | `  } catch {     return true;   } }  function bunfigState` → `  } catch {     return false;   } }  function bunfigState` | killed |
| preload-text-scan-added | src/lib/trust-routine-command.ts:151 | `    return hasKey(Bun.TOML.parse(text));` → `    if (/preload/i.test(text)) return true;     return hasKey(Bun.TOML.parse(text));` | survived |
| state-hash-dropped | src/lib/trust-routine-command.ts:160 | `fingerprint: createHash("sha256").update(text).digest("hex")` → `fingerprint: "same"` | killed |
| state-preload-dropped | src/lib/trust-routine-command.ts:160 | `preload: carriesPreload(text) }` → `preload: false }` | killed |
| state-enoent-code | src/lib/trust-routine-command.ts:162 | `=== "ENOENT") return { fingerprint: "absent", preload: false };` → `=== "ENOENTX") return { fingerprint: "absent", preload: false };` | killed |
| state-unreadable-open | src/lib/trust-routine-command.ts:163 | `return { fingerprint: "unreadable", preload: true };` → `return { fingerprint: "unreadable", preload: false };` | killed |
| state-unreadable-fp | src/lib/trust-routine-command.ts:163 | `return { fingerprint: "unreadable", preload: true };` → `return { fingerprint: "absent", preload: true };` | survived |
| state-absent-preload | src/lib/trust-routine-command.ts:162 | `return { fingerprint: "absent", preload: false };` → `return { fingerprint: "absent", preload: true };` | killed |
| state-file-name | src/lib/trust-routine-command.ts:159 | `path.join(root, "bunfig.toml")` → `path.join(root, "bunfigX.toml")` | killed |
| baseline-first-wins | src/lib/trust-routine-command.ts:173 | `if (!bunfigBaselines.has(root)) bunfigBaselines.set(root, bunfigState(root).fingerprint);` → `bunfigBaselines.set(root, bunfigState(root).fingerprint);` | killed |
| baseline-root-cwd | src/lib/trust-routine-command.ts:172 | `const root = realOrResolved(resolveProjectRoot(cwd));` → `const root = realOrResolved(cwd);` | survived |
| baseline-no-real | src/lib/trust-routine-command.ts:172 | `const root = realOrResolved(resolveProjectRoot(cwd));` → `const root = resolveProjectRoot(cwd);` | survived |
| baseline-noop | src/lib/trust-routine-command.ts:173 | `if (!bunfigBaselines.has(root)) bunfigBaselines.set(root, bunfigState(root).fingerprint);` → `` | killed |
| baseline-default-cwd | src/lib/trust-routine-command.ts:171 | `cwd: string = process.cwd()): void {` → `cwd: string = "/"): void {` | survived |
| bun-untrusted | src/lib/trust-routine-command.ts:197 | `if (walk.untrusted \|\| walk.cwd === undefined) return false;` → `if (walk.cwd === undefined) return false;` | killed |
| bun-cwd-undefined | src/lib/trust-routine-command.ts:197 | `if (walk.untrusted \|\| walk.cwd === undefined) return false;` → `if (walk.untrusted) return false;` | killed |
| bun-cwd-root | src/lib/trust-routine-command.ts:199 | `if (realOrResolved(walk.cwd) !== root) return false;` → `` | killed |
| bun-root-real | src/lib/trust-routine-command.ts:198 | `const root = realOrResolved(walk.projectRoot);` → `const root = walk.projectRoot;` | survived |
| bun-cwd-real | src/lib/trust-routine-command.ts:199 | `if (realOrResolved(walk.cwd) !== root) return false;` → `if (path.resolve(walk.cwd) !== root) return false;` | survived |
| bun-args | src/lib/trust-routine-command.ts:200 | `if (!hasOnlyAllowedBunTestArgs(words.slice(2))) return false;` → `` | killed |
| bun-args-slice | src/lib/trust-routine-command.ts:200 | `hasOnlyAllowedBunTestArgs(words.slice(2))` → `hasOnlyAllowedBunTestArgs(words.slice(3))` | killed |
| bun-baseline-undefined | src/lib/trust-routine-command.ts:203 | `return baseline !== undefined && baseline === now.fingerprint && !now.preload;` → `return baseline === now.fingerprint && !now.preload;` | survived |
| bun-fingerprint | src/lib/trust-routine-command.ts:203 | `baseline === now.fingerprint && ` → `` | killed |
| bun-preload | src/lib/trust-routine-command.ts:203 | ` && !now.preload;` → `;` | killed |
| args-flag-set-todo | src/lib/trust-routine-command.ts:35 | `new Set(["--bail", "--only", "--todo"])` → `new Set(["--bail", "--only"])` | killed |
| args-count-set | src/lib/trust-routine-command.ts:36 | `new Set(["--rerun-each", "--timeout"])` → `new Set(["--timeout"])` | killed |
| args-eq-count | src/lib/trust-routine-command.ts:186 | `BUN_TEST_COUNT_FLAGS.has(arg.slice(0, eq)) && isNonNegativeInteger(arg.slice(eq + 1))` → `BUN_TEST_COUNT_FLAGS.has(arg.slice(0, eq))` | killed |
| args-eq-gt0 | src/lib/trust-routine-command.ts:186 | `eq > 0 &&` → `eq >= 0 &&` | survived |
| args-sep-count | src/lib/trust-routine-command.ts:187 | `if (BUN_TEST_COUNT_FLAGS.has(arg) && isNonNegativeInteger(args[i + 1])) {` → `if (BUN_TEST_COUNT_FLAGS.has(arg)) {` | killed |
| args-sep-skip | src/lib/trust-routine-command.ts:188 | `      i += 1;       continue;` → `      continue;` | killed |
| args-int-regex | src/lib/trust-routine-command.ts:177 | `/^\d+$/.test(value)` → `/\d+/.test(value)` | killed |
| args-int-star | src/lib/trust-routine-command.ts:177 | `/^\d+$/.test(value)` → `/^\d*$/.test(value)` | killed |
| args-int-undef | src/lib/trust-routine-command.ts:177 | `value !== undefined && /^\d+$/` → `/^\d+$/` | survived |
| rf-empty | src/lib/trust-routine-command.ts:227 | `if (values.length === 0) return true;` → `` | survived |
| rf-cwd-undef | src/lib/trust-routine-command.ts:228 | `if (walk.cwd === undefined \|\| values.some(isExpandable)) return false;` → `if (values.some(isExpandable)) return false;` | killed |
| rf-expandable | src/lib/trust-routine-command.ts:228 | `if (walk.cwd === undefined \|\| values.some(isExpandable)) return false;` → `if (walk.cwd === undefined) return false;` | killed |
| rf-verdict | src/lib/trust-routine-command.ts:229 | `return reviewPathFlagRefusal(sub, args, { projectRoot: walk.projectRoot, cwd: walk.cwd }) === undefined;` → `return true;` | killed |
| rf-verdict-cwd | src/lib/trust-routine-command.ts:229 | `{ projectRoot: walk.projectRoot, cwd: walk.cwd }` → `{ projectRoot: walk.projectRoot, cwd: walk.projectRoot }` | killed |
| rf-flags | src/lib/trust-routine-command.ts:226 | `confinedPathFlags(sub).flatMap((flag) => optionValues(args, flag))` → `confinedPathFlags(sub).flatMap((flag) => optionValues(args, flag).slice(0, 1))` | survived |
| rk-confined-gate | src/lib/trust-routine-command.ts:242 | `confinedPathFlags(sub).length > 0) {` → `false) {` | killed |
| rk-review-only | src/lib/trust-routine-command.ts:242 | `args[0] === "review" && sub !== undefined` → `sub !== undefined` | survived |
| rk-args-slice | src/lib/trust-routine-command.ts:243 | `areReviewPathFlagsInside(sub, args.slice(2), walk)` → `areReviewPathFlagsInside(sub, args.slice(3), walk)` | killed |
| rk-ctxrun-dashes | src/lib/trust-routine-command.ts:237 | `dashes >= 3` → `dashes >= 0` | survived |
| rk-ctxrun-dashes-b | src/lib/trust-routine-command.ts:237 | `dashes >= 3` → `dashes >= 2` | survived |
| rk-ctxrun-copy | src/lib/trust-routine-command.ts:237 | `isRoutineSegment(words.slice(dashes + 1), { ...walk })` → `isRoutineSegment(words.slice(dashes + 1), walk)` | killed |
| rk-ctxrun-slice | src/lib/trust-routine-command.ts:237 | `words.slice(dashes + 1)` → `words.slice(dashes)` | killed |
| rk-exec | src/lib/trust-routine-command.ts:239 | `  if (hasExecFlag(words)) return false;   if (!TRUST_ROUTINE_KEYRYX` → `  if (!TRUST_ROUTINE_KEYRYX` | killed |
| rk-table | src/lib/trust-routine-command.ts:240 | `if (!TRUST_ROUTINE_KEYRYX.some((entry) => matchesEntry(entry, args))) return false;` → `` | killed |
| rk-ctxrun-early | src/lib/trust-routine-command.ts:234 | `if (args[0] === "ctx" && args[1] === "run") {` → `if (false) {` | killed |
| seg-cd-arity | src/lib/trust-routine-command.ts:252 | `if (words.length !== 2) return false;` → `` | survived |
| seg-cd-move | src/lib/trust-routine-command.ts:253 | `walk.cwd = movedTo(walk.cwd, words[1] as string);` → `` | killed |
| seg-assign | src/lib/trust-routine-command.ts:249 | `stripAssignments(words).length !== words.length` → `false` | survived |
| seg-bun-test | src/lib/trust-routine-command.ts:258 | `words[1] === "test" && isRoutineBunTest(words, walk)` → `isRoutineBunTest(words, walk)` | survived |
| seg-git-exec | src/lib/trust-routine-command.ts:260 | `GIT_READ_SUBCOMMANDS.has(words[1]) && !hasExecFlag(words)` → `GIT_READ_SUBCOMMANDS.has(words[1])` | killed |
| top-walk-untrusted | src/lib/trust-routine-command.ts:275 | `untrusted: context.untrustedContent === true` → `untrusted: false` | killed |
| top-walk-root | src/lib/trust-routine-command.ts:275 | `projectRoot: resolveProjectRoot(cwd), cwd, untrusted` → `projectRoot: cwd, cwd, untrusted` | survived |
| top-cwd-default | src/lib/trust-routine-command.ts:274 | `path.resolve(context.cwd ?? process.cwd())` → `path.resolve(context.cwd ?? "/")` | survived |
| top-cap | src/lib/trust-routine-command.ts:273 | `segments.length > MAX_CHAIN_SEGMENTS` → `segments.length > 400` | killed |
| top-sep | src/lib/trust-routine-command.ts:278 | `(seg.precededBy === undefined \|\| seg.precededBy === "&&") &&` → `` | killed |
| rpf-stdin | src/lib/review-path-flags.ts:40 | `if (value === "-" && STDIN_FLAGS.has(flag)) return { ok: true, path: "-" };` → `` | killed |
| rpf-stdin-any-flag | src/lib/review-path-flags.ts:40 | `value === "-" && STDIN_FLAGS.has(flag)` → `value === "-"` | survived |
| rpf-stdin-set-diff | src/lib/review-path-flags.ts:26 | `new Set(["--diff", "--payload", "--result"])` → `new Set(["--payload", "--result"])` | killed |
| rpf-stdin-set-payload | src/lib/review-path-flags.ts:26 | `new Set(["--diff", "--payload", "--result"])` → `new Set(["--diff", "--result"])` | survived |
| rpf-stdin-set-result | src/lib/review-path-flags.ts:26 | `new Set(["--diff", "--payload", "--result"])` → `new Set(["--diff", "--payload"])` | survived |
| rpf-extra-root | src/lib/review-path-flags.ts:41 | `[".metaproject"]` → `[]` | survived |
| rpf-wrap-message | src/lib/review-path-flags.ts:42 | ``keryx review ${command} ${flag}: ${placed.message}`` → `placed.message` | killed |
| rpf-refusal-return | src/lib/review-path-flags.ts:54 | `if (!placed.ok) return placed.message;` → `` | killed |
| rpf-refusal-first | src/lib/review-path-flags.ts:52 | `for (const value of optionValues(args, flag)) {` → `for (const value of optionValues(args, flag).slice(0, 1)) {` | killed |
| rpf-refusal-cwd | src/lib/review-path-flags.ts:41 | `placePathWithinSync(where.projectRoot, value, where.cwd, [".metaproject"])` → `placePathWithinSync(where.projectRoot, value, where.projectRoot, [".metaproject"])` | killed |
| rpf-hasown | src/lib/review-path-flags.ts:30 | `Object.hasOwn(REVIEW_CONFINED_PATH_FLAGS, command) ? (REVIEW_CONFINED_PATH_FLAGS[command] as readonly string[]) : []` → `(REVIEW_CONFINED_PATH_FLAGS[command] ?? []) as readonly string[]` | killed |
| rpf-table-slice-out | src/lib/review-path-flags.ts:13 | `slice: ["--diff", "--out"],` → `slice: ["--diff"],` | killed |
| rpf-table-slice-diff | src/lib/review-path-flags.ts:13 | `slice: ["--diff", "--out"],` → `slice: ["--out"],` | killed |
| rpf-table-retry-manifest | src/lib/review-path-flags.ts:14 | `"retry-plan": ["--manifest", "--result", "--state"],` → `"retry-plan": ["--result", "--state"],` | killed |
| rpf-table-retry-result | src/lib/review-path-flags.ts:14 | `"retry-plan": ["--manifest", "--result", "--state"],` → `"retry-plan": ["--manifest", "--state"],` | killed |
| rpf-table-retry-state | src/lib/review-path-flags.ts:14 | `"retry-plan": ["--manifest", "--result", "--state"],` → `"retry-plan": ["--manifest", "--result"],` | killed |
| rpf-table-dc-manifest | src/lib/review-path-flags.ts:15 | `"dispatch-check": ["--manifest", "--payload"],` → `"dispatch-check": ["--payload"],` | killed |
| rpf-table-dc-payload | src/lib/review-path-flags.ts:15 | `"dispatch-check": ["--manifest", "--payload"],` → `"dispatch-check": ["--manifest"],` | killed |
| cp-extra-roots | src/lib/contained-path.ts:155 | `    ...extraRoots       .map((extra) => realOf(path.resolve(rootReal, extra)))       .filter((real): real is string => real !== null && isInside(rootReal, real)),` → `` | survived |
| cp-extra-inside | src/lib/contained-path.ts:157 | `real !== null && isInside(rootReal, real)` → `real !== null` | killed |
| cp-extra-resolve | src/lib/contained-path.ts:156 | `realOf(path.resolve(rootReal, extra))` → `realOf(path.resolve(extra))` | survived |
| cp-root-real | src/lib/contained-path.ts:150 | `const rootReal = realOrResolved(projectRoot);   // An extra` → `const rootReal = path.resolve(projectRoot);   // An extra` | survived |
| cp-cwd | src/lib/contained-path.ts:159 | `const absolute = path.resolve(cwd, candidate);    let ancestor` → `const absolute = path.resolve(rootReal, candidate);    let ancestor` | killed |
| cp-lstat | src/lib/contained-path.ts:166 | `      lstatSync(ancestor);     } catch {       present = false;` → `      void ancestor;     } catch {       present = false;` | killed |
| cp-break-present | src/lib/contained-path.ts:170 | `    if (present) break;     const parent` → `    const parent` | killed |
| cp-parent-root | src/lib/contained-path.ts:172 | `if (parent === ancestor) break;` → `` | survived |
| cp-tail | src/lib/contained-path.ts:173 | `tail.unshift(path.basename(ancestor));` → `` | killed |
| cp-tail-order | src/lib/contained-path.ts:173 | `tail.unshift(path.basename(ancestor));` → `tail.push(path.basename(ancestor));` | killed |
| cp-null | src/lib/contained-path.ts:177 | `if (ancestorReal === null) {` → `if (false) {` | killed |
| cp-null-msg | src/lib/contained-path.ts:178 | `cannot be resolved (dangling or looping symlink).` → `resolves outside the project root.` | killed |
| cp-effective-tail | src/lib/contained-path.ts:180 | `path.join(ancestorReal, ...tail)` → `ancestorReal` | killed |
| cp-contain | src/lib/contained-path.ts:181 | `if (!allowed.some((root) => isInside(root, effective))) {` → `if (false) {` | killed |
| cp-contain-every | src/lib/contained-path.ts:181 | `allowed.some((root) => isInside(root, effective))` → `allowed.every((root) => isInside(root, effective))` | killed |
| cp-return-path | src/lib/contained-path.ts:184 | `return { ok: true, path: effective };` → `return { ok: true, path: absolute };` | killed |
| cp-isinside-dotdot | src/lib/contained-path.ts:67 | `return relative !== ".." && !relative.startsWith(`..${path.sep}`);` → `return !relative.startsWith("..");` | survived |
| rs-guard-throw | src/commands/review-slice.ts:45 | `    throw new Error(refusal);` → `    console.error(refusal);` | survived |
| rs-guard-refusal | src/commands/review-slice.ts:43 | `  const refusal = reviewPathFlagRefusal(command, args, where);   if (refusal !== undefined) {     throw new Error(refusal);   } ` → `` | survived |
| rs-guard-root | src/commands/review-slice.ts:42 | `projectRoot: resolveProjectRoot(cwd), cwd }` → `projectRoot: cwd, cwd }` | killed |
| rs-guard-late-throw | src/commands/review-slice.ts:51 | `if (!placed.ok) throw new Error(placed.message);     return placed.path;` → `return placed.ok ? placed.path : value;` | killed |
| rs-guard-late-path | src/commands/review-slice.ts:52 | `    return placed.path;` → `    return value;` | killed |
| rs-guard-fallback | src/commands/review-slice.ts:48 | `optionValue(args, flag) ?? fallback;` → `optionValue(args, flag);` | killed |
| rs-slice-guard | src/commands/review-slice.ts:142 | `const placed = guardPaths("slice", args);` → `const placed = (flag: string, fb?: string) => optionValue(args, flag) ?? fb;` | killed |
| rs-slice-diff | src/commands/review-slice.ts:146 | `const diffFile = placed("--diff");` → `const diffFile = optionValue(args, "--diff");` | killed |
| rs-slice-out-late | src/commands/review-slice.ts:155 | `const outDir = placed("--out", DEFAULT_SLICE_DIR) as string;` → `const outDir = path.resolve(optionValue(args, "--out") ?? DEFAULT_SLICE_DIR);` | killed |
| rs-slice-out-default | src/commands/review-slice.ts:155 | `placed("--out", DEFAULT_SLICE_DIR)` → `placed("--out", ".")` | killed |
| rs-dc-guard | src/commands/review-slice.ts:228 | `const placed = guardPaths("dispatch-check", args);` → `const placed = (flag: string, fb?: string) => optionValue(args, flag) ?? fb;` | killed |
| rs-dc-payload | src/commands/review-slice.ts:229 | `const payloadSource = placed("--payload");` → `const payloadSource = optionValue(args, "--payload");` | survived |
| rs-dc-manifest | src/commands/review-slice.ts:233 | `const manifestSource = placed("--manifest");   const rawMax` → `const manifestSource = optionValue(args, "--manifest");   const rawMax` | killed |
| rs-rp-guard | src/commands/review-slice.ts:264 | `const placed = guardPaths("retry-plan", args);` → `const placed = (flag: string, fb?: string) => optionValue(args, flag) ?? fb;` | killed |
| rs-rp-manifest | src/commands/review-slice.ts:265 | `const manifestSource = placed("--manifest");   const resultSource` → `const manifestSource = optionValue(args, "--manifest");   const resultSource` | survived |
| rs-rp-result | src/commands/review-slice.ts:266 | `const resultSource = placed("--result");` → `const resultSource = optionValue(args, "--result");` | survived |
| rs-rp-state | src/commands/review-slice.ts:277 | `placed("--state", path.join(manifestDir, RETRY_STATE_NAME)) as string` → `path.resolve(optionValue(args, "--state") ?? path.join(manifestDir, RETRY_STATE_NAME))` | survived |
| rs-rp-state-default | src/commands/review-slice.ts:277 | `path.join(manifestDir, RETRY_STATE_NAME)` → `RETRY_STATE_NAME` | killed |
| ag-baseline-process | src/commands/agent.ts:2250 | `  recordBunfigBaseline(); ` → `` | survived |
| ag-baseline-tool | src/commands/agent.ts:2252 | `if (tool.workingDirectory !== undefined) recordBunfigBaseline(tool.workingDirectory);` → `` | killed |
| ag-baseline-tool-guard | src/commands/agent.ts:2252 | `if (tool.workingDirectory !== undefined) recordBunfigBaseline(` → `if (true) recordBunfigBaseline(` | survived |
| ag-latch-cwd | src/commands/agent.ts:5647 | `      ...(tool.workingDirectory === undefined ? {} : { cwd: tool.workingDirectory }), ` → `` | survived |
| ag-latch-untrusted | src/commands/agent.ts:5646 | `untrustedContent: untrustedOrigin,` → `untrustedContent: false,` | killed |
| ag-refusal-ctx | src/commands/agent.ts:5650 | `!isTrustRoutineCommand(command, routineContext)) {       const key` → `!isTrustRoutineCommand(command)) {       const key` | survived |
| ag-refusal-off | src/commands/agent.ts:5650 | `if (reviewAutoActive() && command.length > 0 && !isTrustRoutineCommand(command, routineContext)) {` → `if (false) {` | survived |
| ag-gate-ctx | src/commands/agent.ts:5682 | `isTrustRoutineCommand(command, routineContext) &&         ((mode` → `isTrustRoutineCommand(command) &&         ((mode` | survived |
| ag-gate-mode | src/commands/agent.ts:5683 | `((mode === "trust" && gated.decision === "auto") \|\| reviewAutoActive())` → `(mode === "trust" \|\| reviewAutoActive())` | survived |
| ag-gate-reviewauto | src/commands/agent.ts:5683 | `((mode === "trust" && gated.decision === "auto") \|\| reviewAutoActive())` → `(mode === "trust" && gated.decision === "auto")` | survived |
| ag-gate-hook | src/commands/agent.ts:5681 | `!gated.hookAsked &&         isTrustRoutineCommand` → `isTrustRoutineCommand` | survived |
| sh-workdir | src/harness/tool/builtin/shell-exec-tool.ts:422 | `    workingDirectory: root, ` → `` | survived |

A survivor means no assertion pins that behaviour: the severity audit reads it as evidence.
