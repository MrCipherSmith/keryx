import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export type MutantSpec = {
  id: string;
  file: string;
  /** Exact text that occurs once in the file. */
  anchor: string;
  replacement: string;
  note?: string | undefined;
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
};

export type MutationRecord = {
  schemaVersion: 1;
  worktree: string;
  command: string;
  baseline: { exitCode: number; ms: number };
  mutants: MutantResult[];
  totals: Record<MutantStatus, number>;
};

export const MUTANTS_SPEC = "mutants.json";
export const EVIDENCE_DIR = "research-evidence";

const SKIP_COPY = new Set([".git", "node_modules"]);

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
    return { id, file: m.file as string, anchor: m.anchor as string, replacement: m.replacement as string, note: typeof m.note === "string" ? m.note : undefined };
  });
}

function runCommand(command: string, cwd: string, timeoutMs: number): Promise<{ exitCode: number; timedOut: boolean; ms: number }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command, { cwd, shell: true, stdio: "ignore", detached: true });
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
      resolve({ exitCode: code ?? 1, timedOut, ms: Date.now() - started });
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ exitCode: 127, timedOut, ms: Date.now() - started });
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

async function copyTree(source: string, target: string): Promise<void> {
  await cp(source, target, {
    recursive: true,
    filter: (entry) => !SKIP_COPY.has(path.basename(entry)) || path.resolve(entry) === path.resolve(source),
  });
  const modules = path.join(source, "node_modules");
  if (existsSync(modules)) await symlink(modules, path.join(target, "node_modules"), "dir");
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
  scratchRoot?: string | undefined;
}): Promise<MutationRecord> {
  const worktree = path.resolve(options.worktree);
  const timeoutMs = options.timeoutMs ?? 300_000;
  const scratch = await mkdtemp(path.join(options.scratchRoot ?? tmpdir(), "keryx-mutate-"));
  try {
    const copy = path.join(scratch, "tree");
    await copyTree(worktree, copy);
    const baseline = await runCommand(options.command, copy, timeoutMs);
    if (baseline.exitCode !== 0 || baseline.timedOut)
      throw new Error(`the baseline run of \`${options.command}\` ${baseline.timedOut ? "timed out" : `exited ${baseline.exitCode}`} on an unmodified copy; mutants would all read as killed, so none were run`);

    const results: MutantResult[] = [];
    for (const mutant of options.mutants) {
      const base = { id: mutant.id, file: mutant.file, anchor: mutant.anchor, replacement: mutant.replacement, note: mutant.note, command: options.command };
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
      try {
        const run = await runCommand(options.command, copy, timeoutMs);
        results.push({ ...base, line: lineOf(original, first), status: run.timedOut ? "timeout" : run.exitCode === 0 ? "survived" : "killed", exitCode: run.exitCode, ms: run.ms });
      } finally {
        await writeFile(target, original, "utf8");
      }
    }
    const totals: Record<MutantStatus, number> = { killed: 0, survived: 0, invalid: 0, timeout: 0 };
    for (const r of results) totals[r.status] += 1;
    return { schemaVersion: 1, worktree, command: options.command, baseline: { exitCode: baseline.exitCode, ms: baseline.ms }, mutants: results, totals };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export function renderMutationTable(record: MutationRecord): string {
  // A backtick would end a code span early and cannot be escaped inside one, so it becomes a quote.
  const cell = (value: string) => value.replace(/\|/g, "\\|").replace(/[\r\n]/g, " ").replace(/`/g, "'");
  const code = (value: string) => `\`${cell(value)}\``;
  const columns: { header: string; render: (m: MutantResult) => string }[] = [
    { header: "Mutant", render: (m) => cell(m.id) },
    { header: "Where", render: (m) => `${cell(m.file)}${m.line === undefined ? "" : `:${m.line}`}` },
    { header: "Change", render: (m) => `${code(m.anchor)} → ${code(m.replacement)}` },
    { header: "Result", render: (m) => `${m.status}${m.reason ? ` (${cell(m.reason)})` : ""}` },
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
    `Killed ${t.killed}, survived ${t.survived}, timeout ${t.timeout}, invalid ${t.invalid}.`,
    "",
    line(columns.map((c) => c.header)),
    `|${columns.map(() => "---|").join("")}`,
    ...rows,
    "",
    t.survived > 0 ? "A survivor means no assertion pins that behaviour: the severity audit reads it as evidence." : "No survivor.",
    "",
  ].join("\n");
}

/** Writes `mutation-<n>.json` and `.md` into `<package>/research-evidence/`. */
export async function writeMutationEvidence(packageDir: string, record: MutationRecord): Promise<{ json: string; md: string }> {
  const dir = path.join(packageDir, EVIDENCE_DIR);
  await mkdir(dir, { recursive: true });
  const taken = (await readdir(dir)).map((n) => /^mutation-(\d+)\.json$/.exec(n)?.[1]).filter((n): n is string => n !== undefined).map(Number);
  const n = (taken.length ? Math.max(...taken) : 0) + 1;
  const json = path.join(dir, `mutation-${n}.json`);
  const md = path.join(dir, `mutation-${n}.md`);
  await writeFile(json, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  await writeFile(md, renderMutationTable(record), "utf8");
  return { json, md };
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
  const done = new Set<string>();
  for (const name of (await readdir(dir)).filter((n) => /^mutation-\d+\.json$/.test(n))) {
    try {
      const record = JSON.parse(await readFile(path.join(dir, name), "utf8")) as MutationRecord;
      for (const m of record.mutants) if (m.status !== "invalid") done.add(m.id);
    } catch {
      continue;
    }
  }
  return specs.filter((s) => !done.has(s.id));
}
