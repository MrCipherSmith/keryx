import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * What a mutant changes. `behavior` alters what the code does; `presentation` alters only how it
 * looks or reads (copy, class names, ordering of display rows). A survivor of the second kind is not
 * evidence that behaviour is unpinned, so the severity audit does not raise a finding on it.
 */
export type MutantKind = "behavior" | "presentation";
export const MUTANT_KINDS: readonly MutantKind[] = ["behavior", "presentation"];

export type MutantSpec = {
  id: string;
  file: string;
  /** Exact text that occurs once in the file. */
  anchor: string;
  replacement: string;
  note?: string | undefined;
  /** Absent means `behavior`. */
  kind?: MutantKind | undefined;
};

export type MutantStatus = "killed" | "survived" | "invalid" | "timeout";

export type MutantResult = {
  id: string;
  file: string;
  line?: number | undefined;
  anchor: string;
  replacement: string;
  status: MutantStatus;
  /** The test command this row was judged by; absent in records written before the field existed. */
  command?: string | undefined;
  exitCode?: number | undefined;
  ms: number;
  reason?: string | undefined;
  note?: string | undefined;
  /** Absent in records written before the field existed, and means `behavior`. */
  kind?: MutantKind | undefined;
};

export type MutationRecord = {
  schemaVersion: 1;
  worktree: string;
  command: string;
  baseline: { exitCode: number; ms: number; timedOut?: boolean | undefined; cwd?: string | undefined; tail?: string | undefined };
  mutants: MutantResult[];
  totals: Record<MutantStatus, number>;
  /** The most candidates this pass was allowed to run; absent when the pass ran with no cap. */
  cap?: number | undefined;
  /** Candidates the pass was given but did not run (they stay pending). Present only when a cap was set. */
  not_reached?: number | undefined;
};

export const MUTANTS_SPEC = "mutants.json";
export const EVIDENCE_DIR = "research-evidence";

const SKIP_COPY = new Set([".git", "node_modules"]);

/** Where the scratch copy goes by default, relative to the repository root. It is git-ignored and never copied into itself. */
export const SCRATCH_DIR = path.join(".metaproject", "data", "review", "mutate-scratch");
export type ScratchMode = "repo" | "tmp";
export const SCRATCH_MODES: readonly ScratchMode[] = ["repo", "tmp"];
const BASELINE_TAIL_LINES = 60;
const OUTPUT_KEEP_CHARS = 256 * 1024;

/** The last `lines` lines of `text`, without trailing blank lines. */
export function tailLines(text: string, lines = BASELINE_TAIL_LINES): string {
  return text.replace(/\s+$/, "").split(/\r?\n/).slice(-lines).join("\n");
}

/** A red or timed-out baseline. Carries the evidence record so the caller can persist the tail before failing. */
export class BaselineError extends Error {
  constructor(
    message: string,
    readonly record: MutationRecord,
  ) {
    super(message);
    this.name = "BaselineError";
  }
}

export function parseMutantSpec(raw: unknown): MutantSpec[] {
  const list = Array.isArray(raw) ? raw : (raw as { mutants?: unknown } | undefined)?.mutants;
  if (!Array.isArray(list) || list.length === 0) throw new Error("mutant spec needs a non-empty mutants array");
  const ids = new Set<string>();
  return list.map((entry, index) => {
    const m = entry as Record<string, unknown>;
    for (const key of ["id", "file", "anchor", "replacement"] as const)
      if (typeof m?.[key] !== "string" || (key !== "replacement" && (m[key] as string).length === 0)) throw new Error(`mutant #${index + 1}: "${key}" must be a string${key === "replacement" ? "" : " and not empty"}`);
    const id = m.id as string;
    if (ids.has(id)) throw new Error(`mutant id "${id}" appears twice`);
    ids.add(id);
    if (m.anchor === m.replacement) throw new Error(`mutant ${id}: replacement equals the anchor, so nothing changes`);
    if (m.kind !== undefined && !MUTANT_KINDS.includes(m.kind as MutantKind)) throw new Error(`mutant ${id}: "kind" must be one of ${MUTANT_KINDS.join(", ")}`);
    return {
      id,
      file: m.file as string,
      anchor: m.anchor as string,
      replacement: m.replacement as string,
      note: typeof m.note === "string" ? m.note : undefined,
      ...(m.kind === undefined ? {} : { kind: m.kind as MutantKind }),
    };
  });
}

/** Process groups of the test commands running now; a signal kills them before the scratch copy goes. */
const liveGroups = new Set<number>();

function killLiveGroups(): void {
  for (const pgid of liveGroups) {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  liveGroups.clear();
}

/** The environment a test run gets: git cannot be pointed at another repository, so the ceiling holds. */
function runEnv(scratchBase: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CEILING_DIRECTORIES: [scratchBase, process.env.GIT_CEILING_DIRECTORIES].filter((value) => value !== undefined && value !== "").join(path.delimiter) };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY"]) delete env[name];
  return env;
}

function runCommand(command: string, cwd: string, timeoutMs: number, env: NodeJS.ProcessEnv): Promise<{ exitCode: number; timedOut: boolean; ms: number; output: string }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command, { cwd, env, shell: true, stdio: ["ignore", "pipe", "pipe"], detached: true });
    const group = child.pid;
    if (group !== undefined) liveGroups.add(group);
    // stdout and stderr are interleaved in arrival order; only the end is kept, so a chatty suite cannot grow memory without bound.
    let output = "";
    const collect = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > OUTPUT_KEEP_CHARS) output = output.slice(-OUTPUT_KEEP_CHARS);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (group !== undefined) liveGroups.delete(group);
      resolve({ exitCode: code ?? 1, timedOut, ms: Date.now() - started, output });
    });
    child.on("error", () => {
      clearTimeout(timer);
      if (group !== undefined) liveGroups.delete(group);
      resolve({ exitCode: 127, timedOut, ms: Date.now() - started, output });
    });
  });
}

function insideRoot(root: string, file: string): string | undefined {
  const resolved = path.resolve(root, file);
  return resolved === root || resolved.startsWith(`${root}${path.sep}`) ? resolved : undefined;
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

/**
 * Copies the tree entry by entry instead of with one `cp`: the scratch directory can sit inside the
 * tree being copied, and `cp` refuses a destination under its own source. `skip` holds absolute paths
 * (the scratch directory) that are left out.
 */
async function copyTree(source: string, target: string, skip: ReadonlySet<string>): Promise<void> {
  const walk = async (from: string, to: string): Promise<void> => {
    await mkdir(to, { recursive: true });
    for (const entry of await readdir(from, { withFileTypes: true })) {
      const entryPath = path.join(from, entry.name);
      if (SKIP_COPY.has(entry.name) || skip.has(entryPath)) continue;
      if (entry.isDirectory()) await walk(entryPath, path.join(to, entry.name));
      else await cp(entryPath, path.join(to, entry.name));
    }
  };
  await walk(source, target);
  const modules = path.join(source, "node_modules");
  if (existsSync(modules)) await symlink(modules, path.join(target, "node_modules"), "dir");
}

const SIGNALS: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM"];

/** Runs `body`; on SIGINT or SIGTERM `cleanup` runs first and the signal is re-raised so the process still dies by it. */
export async function withScratchSignalCleanup<T>(cleanup: () => Promise<void>, body: () => Promise<T>): Promise<T> {
  const onSignal = (signal: NodeJS.Signals): void => {
    for (const name of SIGNALS) process.off(name, onSignal);
    void cleanup().catch(() => {}).finally(() => process.kill(process.pid, signal));
  };
  for (const name of SIGNALS) process.on(name, onSignal);
  try {
    return await body();
  } finally {
    for (const name of SIGNALS) process.off(name, onSignal);
  }
}

/**
 * Runs each mutant in a scratch copy of the worktree; the worktree itself is never written.
 * The baseline must pass first: against a red baseline every mutant would read as killed.
 */
export async function runMutation(options: {
  worktree: string;
  command: string;
  mutants: readonly MutantSpec[];
  timeoutMs?: number | undefined;
  /** Explicit directory to make the scratch copy in; wins over `scratch`. */
  scratchRoot?: string | undefined;
  /** `repo` (default) puts the copy under `<worktree>/.metaproject/data/review/mutate-scratch` so ancestor node_modules still resolve; `tmp` uses the OS temp dir. */
  scratch?: ScratchMode | undefined;
  /** Run at most this many candidates; the rest, and any that came out invalid, are counted in `not_reached` and stay pending. */
  cap?: number | undefined;
}): Promise<MutationRecord> {
  const worktree = path.resolve(options.worktree);
  const timeoutMs = options.timeoutMs ?? 300_000;
  const scratchBase = options.scratchRoot !== undefined ? path.resolve(options.scratchRoot) : options.scratch === "tmp" ? tmpdir() : path.join(worktree, SCRATCH_DIR);
  await mkdir(scratchBase, { recursive: true });
  const scratch = await mkdtemp(path.join(scratchBase, "keryx-mutate-"));
  // The copy has no .git; without a ceiling a git command run by the tests would walk up into the real repository.
  const env = runEnv(scratchBase);
  return withScratchSignalCleanup(async () => { killLiveGroups(); await rm(scratch, { recursive: true, force: true }); }, async () => {
  try {
    const copy = path.join(scratch, "tree");
    await copyTree(worktree, copy, new Set([scratchBase, scratch]));
    const baseline = await runCommand(options.command, copy, timeoutMs, env);
    if (baseline.exitCode !== 0 || baseline.timedOut) {
      const tail = tailLines(baseline.output);
      const what = baseline.timedOut ? `timed out after ${timeoutMs} ms` : `exited ${baseline.exitCode}`;
      const message = [
        `the baseline run of \`${options.command}\` ${what} on an unmodified copy; mutants would all read as killed, so none were run`,
        `baseline command: ${options.command}`,
        `baseline cwd: ${copy}`,
        `last ${BASELINE_TAIL_LINES} lines of output:`,
        tail === "" ? "(no output)" : tail,
      ].join("\n");
      throw new BaselineError(message, {
        schemaVersion: 1,
        worktree,
        command: options.command,
        baseline: { exitCode: baseline.exitCode, ms: baseline.ms, timedOut: baseline.timedOut, cwd: copy, tail },
        mutants: [],
        totals: { killed: 0, survived: 0, invalid: 0, timeout: 0 },
      });
    }

    const results: MutantResult[] = [];
    const cap = options.cap === undefined ? undefined : Math.max(0, Math.floor(options.cap));
    // The cap bounds the mutants that actually run. An invalid candidate costs nothing and stays pending
    // (see `pendingMutants`), so it neither uses up the cap nor counts as reached.
    let ran = 0;
    for (const mutant of options.mutants) {
      if (cap !== undefined && ran >= cap) break;
      const base = { id: mutant.id, file: mutant.file, anchor: mutant.anchor, replacement: mutant.replacement, note: mutant.note, command: options.command, ...(mutant.kind === undefined ? {} : { kind: mutant.kind }) };
      const target = insideRoot(copy, mutant.file);
      if (target === undefined || !existsSync(target)) {
        results.push({ ...base, status: "invalid", ms: 0, reason: target === undefined ? "file is outside the worktree" : "file does not exist in the worktree" });
        continue;
      }
      if (insideRoot(await realpath(copy), await realpath(target)) === undefined) {
        results.push({ ...base, status: "invalid", ms: 0, reason: "file resolves through a link to outside the scratch copy" });
        continue;
      }
      const original = await readFile(target, "utf8");
      const first = original.indexOf(mutant.anchor);
      if (first === -1 || original.indexOf(mutant.anchor, first + 1) !== -1) {
        results.push({ ...base, status: "invalid", ms: 0, reason: first === -1 ? "anchor not found" : "anchor occurs more than once; make it exact" });
        continue;
      }
      await writeFile(target, original.slice(0, first) + mutant.replacement + original.slice(first + mutant.anchor.length), "utf8");
      ran += 1;
      try {
        const run = await runCommand(options.command, copy, timeoutMs, env);
        results.push({ ...base, line: lineOf(original, first), status: run.timedOut ? "timeout" : run.exitCode === 0 ? "survived" : "killed", exitCode: run.exitCode, ms: run.ms });
      } finally {
        await writeFile(target, original, "utf8");
      }
    }
    const totals: Record<MutantStatus, number> = { killed: 0, survived: 0, invalid: 0, timeout: 0 };
    for (const r of results) totals[r.status] += 1;
    return { schemaVersion: 1, worktree, command: options.command, baseline: { exitCode: baseline.exitCode, ms: baseline.ms }, mutants: results, totals, ...(cap === undefined ? {} : { cap, not_reached: options.mutants.length - ran }) };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  });
}

export function renderMutationTable(record: MutationRecord): string {
  // A backtick would end a code span early and cannot be escaped inside one, so it becomes a quote.
  const cell = (value: string) => value.replace(/\|/g, "\\|").replace(/[\r\n]/g, " ").replace(/`/g, "'");
  const code = (value: string) => `\`${cell(value)}\``;
  const columns: { header: string; render: (m: MutantResult) => string }[] = [
    { header: "Mutant", render: (m) => cell(m.id) },
    { header: "Where", render: (m) => `${cell(m.file)}${m.line === undefined ? "" : `:${m.line}`}` },
    { header: "Change", render: (m) => `${code(m.anchor)} → ${code(m.replacement)}` },
    { header: "Result", render: (m) => `${m.status}${m.reason ? ` (${cell(m.reason)})` : ""}${m.kind === "presentation" ? " [presentation]" : ""}` },
    { header: "Test command", render: (m) => code(m.command ?? record.command) },
    { header: "Exit", render: (m) => String(m.exitCode ?? "-") },
  ];
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
  const rows = record.mutants.map((m) => line(columns.map((c) => c.render(m))));
  const t = record.totals;
  return [
    `# Mutation pass`,
    "",
    `Command: \`${record.command}\` (baseline exit ${record.baseline.exitCode}, ${record.baseline.ms} ms). Run in a scratch copy; the worktree was not written.`,
    "",
    ...(record.baseline.tail === undefined
      ? []
      : [`Baseline ${record.baseline.timedOut ? "timed out" : `failed (exit ${record.baseline.exitCode})`}; no mutant ran. cwd: \`${record.baseline.cwd ?? "-"}\`. Last output:`, "", "```", record.baseline.tail.replace(/```/g, "'"), "```", ""]),
    `Killed ${t.killed}, survived ${t.survived}, timeout ${t.timeout}, invalid ${t.invalid}.`,
    "",
    line(columns.map((c) => c.header)),
    `|${columns.map(() => "---|").join("")}`,
    ...rows,
    "",
    ...(record.not_reached !== undefined && record.not_reached > 0 ? [`Not run: ${record.not_reached} candidates${record.cap === undefined ? "" : ` (cap ${record.cap})`}. They stay pending and block the coverage gate until a pass runs them.`, ""] : []),
    t.survived > 0 ? "A survivor means no assertion pins that behaviour: the severity audit raises a finding to major only when no mutant in the same file was killed." : "No survivor.",
    "",
  ].join("\n");
}

/**
 * Writes `mutation-<n>.json` and `.md` into `<package>/research-evidence/`. A record whose baseline failed
 * (it carries the output tail) goes under `mutation-baseline-<n>` instead, so nothing that counts mutation
 * passes by the `mutation` prefix reads a run that judged no mutant as a pass.
 */
export async function writeMutationEvidence(packageDir: string, record: MutationRecord): Promise<{ json: string; md: string }> {
  const dir = path.join(packageDir, EVIDENCE_DIR);
  await mkdir(dir, { recursive: true });
  const stem = record.baseline.tail !== undefined ? "mutation-baseline" : "mutation";
  const pattern = new RegExp(`^${stem}-(\\d+)\\.json$`);
  const taken = (await readdir(dir)).map((n) => pattern.exec(n)?.[1]).filter((n): n is string => n !== undefined).map(Number);
  const n = (taken.length ? Math.max(...taken) : 0) + 1;
  const json = path.join(dir, `${stem}-${n}.json`);
  const md = path.join(dir, `${stem}-${n}.md`);
  await writeFile(json, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  await writeFile(md, renderMutationTable(record), "utf8");
  return { json, md };
}

/** Whether the package holds a recorded mutation pass (`research-evidence/mutation-<n>.json`); a baseline-failed record does not count. */
export async function packageHasMutationRecord(packageDir: string): Promise<boolean> {
  const dir = path.join(packageDir, EVIDENCE_DIR);
  if (!existsSync(dir)) return false;
  return (await readdir(dir)).some((n) => /^mutation-\d+\.json$/.test(n));
}

/** Ids of the mutants a recorded pass has judged. An invalid row judged nothing, so it does not count. */
export async function doneMutantIds(packageDir: string): Promise<Set<string>> {
  const dir = path.join(packageDir, EVIDENCE_DIR);
  const done = new Set<string>();
  if (!existsSync(dir)) return done;
  for (const name of (await readdir(dir)).filter((n) => /^mutation-\d+\.json$/.test(n))) {
    try {
      const record = JSON.parse(await readFile(path.join(dir, name), "utf8")) as MutationRecord;
      for (const m of record.mutants) if (m.status !== "invalid") done.add(m.id);
    } catch {
      continue;
    }
  }
  return done;
}

/** The given specs minus those a recorded pass in this package has already judged, in their original order. */
export async function unjudgedMutants(packageDir: string, specs: MutantSpec[]): Promise<MutantSpec[]> {
  const done = await doneMutantIds(packageDir);
  return specs.filter((s) => !done.has(s.id));
}

/** Mutants the reviewers proposed (`research-evidence/mutants.json`) that no recorded mutation pass has run yet. A spec with `"runnable": false` says the tests cannot be run here, so nothing is pending. */
export async function pendingMutants(packageDir: string): Promise<MutantSpec[]> {
  const dir = path.join(packageDir, EVIDENCE_DIR);
  const specFile = path.join(dir, MUTANTS_SPEC);
  if (!existsSync(specFile)) return [];
  let specs: MutantSpec[];
  try {
    const raw: unknown = JSON.parse(await readFile(specFile, "utf8"));
    if ((raw as { runnable?: unknown } | null)?.runnable === false) return [];
    specs = parseMutantSpec(raw);
  } catch {
    return [];
  }
  return unjudgedMutants(packageDir, specs);
}
