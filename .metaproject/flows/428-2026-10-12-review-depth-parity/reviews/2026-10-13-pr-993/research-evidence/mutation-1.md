# Mutation pass

Command: `bun test src/review/mutate.test.ts src/review/dispatch.test.ts src/gdskills/reviewer-triggers.test.ts src/review/coverage.test.ts` (baseline exit 0, 3630 ms). Run in a scratch copy; the worktree was not written.

Killed 24, survived 6, timeout 0, invalid 0.

| Mutant | Where | Change | Result |
|---|---|---|---|
| G1 | src/review/coverage.ts:46 | `offset + match.length === whole.length ? "\uE001" : "\uE000"` → `"\uE000"` | killed |
| G2 | src/review/coverage.ts:48 | `.replace(/\uE001/g, ".*")` → `.replace(/\uE001/g, "[^/]*")` | killed |
| G3 | src/review/coverage.ts:49 | `.replace(/\uE000/g, "(?:.*/)?")` → `.replace(/\uE000/g, "(?:.*/)")` | killed |
| G4 | src/review/coverage.ts:50 | `return new RegExp(`^${body}$`);` → `return new RegExp(`${body}$`);` | survived |
| G5 | src/review/coverage.ts:47 | `.replace(/\*/g, "[^/]*")` → `.replace(/\*/g, ".*")` | survived |
| R1 | src/review/coverage.ts:123 | `if (options.blastRadius === true) required.push(REGRESSION);` → `if (options.blastRadius !== false) required.push(REGRESSION);` | killed |
| R2 | src/review/coverage.ts:122 | `if (inventory.bundled.some((r) => r.name === REGRESSION)) {` → `if (false) {` | killed |
| R3 | src/review/coverage.ts:124 | `no blast radius computed for the package: there is no scope B to review` → `blast radius absent` | killed |
| R4 | src/review/coverage.ts:22 | `  "review-regression",   "review-pr-feedback",` → `  "review-pr-feedback",` | killed |
| R5 | src/review/coverage.ts:117 | `if (derived.has(name) \|\| project.has(name)) return true;` → `return true;` | killed |
| R6 | src/review/coverage.ts:180 | `record.mode === "diff" && !text(record.operatorQuote)` → `false` | killed |
| R7 | src/review/coverage.ts:177 | `(v: unknown): v is string => typeof v === "string" && v.trim().length > 0` → `(v: unknown): v is string => typeof v === "string" && v.length > 0` | killed |
| R8 | src/review/coverage.ts:193 | `need.required.filter((name) => !selected.has(name))` → `[]` | killed |
| R9 | src/review/coverage.ts:191 | `{ blastRadius: options.blastRadius }` → `{}` | killed |
| R10 | src/review/coverage.ts:196 | `missing: ${missing.join(", ")}` → `lacking: ${missing.join(", ")}` | killed |
| R11 | src/review/coverage.ts:126 | `required: required.sort()` → `required: required` | survived |
| R12 | src/review/coverage.ts:99 | `reviewer.pathsSource !== "none" && reviewer.paths.length` → `false` | killed |
| R13 | src/review/coverage.ts:113 | `if (mode === "diff") {` → `if (false) {` | killed |
| T1 | src/gdskills/reviewer-triggers.ts:124 | `const isGlob = token.includes("*") && (token.includes("/") \|\| token.startsWith("*."));` → `const isGlob = false;` | killed |
| T2 | src/gdskills/reviewer-triggers.ts:129 | `return hasGlob ? [...triggers] : [];` → `return [];` | killed |
| T3 | src/gdskills/reviewer-triggers.ts:154 | `pathsSource: described.length > 0 ? "description" : "none"` → `pathsSource: "description"` | killed |
| T4 | src/gdskills/reviewer-triggers.ts:151 | `if (declared.length > 0) return { paths: declared, pathsSource: "metadata" };` → `` | killed |
| M1 | src/review/mutate.ts:130 | `note: mutant.note, command: options.command }` → `note: mutant.note, command: "" }` | killed |
| M2 | src/review/mutate.ts:149 | `exitCode: run.exitCode, ms: run.ms` → `ms: run.ms` | killed |
| M3 | src/review/mutate.ts:149 | `run.exitCode === 0 ? "survived" : "killed"` → `run.exitCode === 0 ? "killed" : "survived"` | killed |
| M4 | src/review/mutate.ts:166 | `${m.exitCode ?? "-"}` → `${m.exitCode ?? 0}` | survived |
| M5 | src/review/mutate.ts:176 | `\| Result \| Test command \| Exit \|` → `\| Result \|` | survived |
| M6 | src/review/mutate.ts:166 | `${cell(m.command)}` → `${m.command}` | survived |
| M7 | src/review/mutate.ts:143 | `"anchor not found"` → `"anchor missing"` | killed |
| M8 | src/review/mutate.ts:166 | `${m.status}${m.reason ? ` (${cell(m.reason)})` : ""}` → `${m.status}` | killed |

A survivor means no assertion pins that behaviour: the severity audit reads it as evidence.
