// Flow 404 (AC2 to AC8): `keryx research sync` keeps three files next to the Part 1 materials current,
// writes nothing else, leaves git alone, and on a failure leaves the last good data as it was.
//
// Each test works in a throwaway git repository holding a copy of the real catalog and a few flows, so the
// real script runs at that repository's HEAD and `git status` there is the whole truth about what a run wrote.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { appendFile, copyFile, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { exportRef } from "../decisions/export";
import { EXPORT_FIELDS, journalFile, saltFile } from "../decisions/service";
import {
  CATALOG_DIR,
  LATEST_COUNTS,
  LATEST_EXPORT,
  RAW_DIR,
  STATUS_FILE,
  namesOffLimits,
  readLastSyncRun,
  runResearchSync,
  type SyncDeps,
} from "./research-sync";

const exec = promisify(execFile);
const REAL = path.resolve(import.meta.dir, "..", "..");
const REAL_CATALOG = path.join(REAL, CATALOG_DIR);
const CLI = path.join(REAL, "src", "cli.ts");

const SNAPSHOT_FILES = ["part1-counts.json", "decisions-export-2026-10-04.jsonl", "part1-counts.py"];
const SYNC_FILES = [LATEST_COUNTS, LATEST_EXPORT, STATUS_FILE];
// Every file of the real catalog except what the sync itself generates: a file added to the catalog later is copied
// into the fixture too, so the kept-out-term check of AC7 reaches it without anyone editing this list.
// Only the files at its top level: the machines' raw exports and the requests are real data, never copied into a fixture.
const CATALOG_COPY = readdirSync(REAL_CATALOG).filter((name) => !SYNC_FILES.includes(name) && statSync(path.join(REAL_CATALOG, name)).isFile());

// The script is run unchanged: its digest is pinned, so editing it (even to make the sync easier) fails here.
const SCRIPT_SHA256 = "145a3d74fb19d986299f2a9c691533b71eff8e78628dddc1930525169769ba3a";

// The allow-list of AC6 of flow 402: identifiers, mode or arm, order, preselection, match, time to answer,
// whether a reason exists, source. The same list `src/docs/part1-materials.test.ts` pins.
const ALLOWED_FIELDS = [
  "answered", "answeredAt", "arm", "backfilled", "changes", "channel", "chosenIndex", "deviation", "eligible",
  "forced", "hasRecommendation", "legacy", "openedAt", "optionCount", "order", "other", "preselected", "ratings",
  "reasonNamed", "reasonRequested", "recommendedIndex", "ref", "seed", "stage", "timeToAnswerMs",
];
// A machine's rows: the same fields without the seed, plus the machine and the order (flow 400 and the journal merge).
const MACHINE_FIELDS = [...ALLOWED_FIELDS.filter((name) => name !== "seed"), "seq", "seqDerived", "host", "seedHash", "globalSeq"];
const OFF_LIMITS = ["frontend", "backend", "board", "process-metrics"];
const SECRETS = ["QSECRET-research-question", "OPTLABEL-research-alpha", "RECREASON-research-why", "OPTID-research-secret"];

const hasPython = (() => {
  try {
    return Bun.spawnSync([process.platform === "win32" ? "python" : "python3", "--version"]).exitCode === 0;
  } catch {
    return false;
  }
})();

// A missing python3 must not turn AC2 to AC8 into silent skips where the checks are meant to run.
test("python3 is available wherever CI runs these tests", () => {
  if (process.env.CI !== undefined && process.env.CI !== "") expect(hasPython).toBe(true);
});

const T1 = new Date("2026-10-05T04:00:00Z");
const T2 = new Date("2026-10-06T04:00:30Z");

let root: string;
let configDir: string;
let savedConfigDir: string | undefined;
/** This machine: the host and the seed hash of the seed file the fixture wrote, and its raw export. */
let host: string;
let ownRaw: string;

const sha = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex");
const inCatalog = (name: string): string => path.join(root, CATALOG_DIR, name);
const text = (name: string): string => readFileSync(inCatalog(name), "utf8");

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd });
  return stdout;
}

function openLine(id: string, at: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "open",
    id,
    at,
    flow: "404",
    stage: "review",
    question: SECRETS[0],
    options: [{ id: SECRETS[3], label: SECRETS[1] }, { id: "b", label: "B" }],
    recommendation: { optionId: SECRETS[3], reason: SECRETS[2] },
    mode: "ordinary",
    order: [SECRETS[3], "b"],
    showMark: true,
    irreversible: false,
    arm: "B",
    seed: 7,
    preselected: false,
    channel: "tui",
    ...extra,
  };
}

const answerLine = (id: string, at: string): Record<string, unknown> => ({
  kind: "answer",
  id,
  at,
  seq: 1,
  choice: SECRETS[3],
  timeToAnswerMs: 4000,
  changed: false,
});

async function appendJournal(lines: Array<Record<string, unknown>>): Promise<void> {
  const file = journalFile(root);
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
}

/** Four opening times around the boundary (2026-10-02T00:00Z), one per timestamp form, and one clearly before. */
const BOUNDARY = [
  ["in-z", "2026-10-02T00:30:00.000Z", true],
  ["in-minus5", "2026-10-01T22:30:00-05:00", true], // 2026-10-02T03:30Z
  ["out-plus3", "2026-10-02T01:00:00+03:00", false], // 2026-10-01T22:00Z
  ["out-plus0", "2026-10-01T23:00:00+00:00", false],
  ["out-old", "2026-09-30T10:00:00.000Z", false],
] as const;

async function seedJournal(): Promise<void> {
  const lines: Array<Record<string, unknown>> = [];
  for (const [id, at] of BOUNDARY) lines.push(openLine(id, at), answerLine(id, "2026-10-03T10:00:04.000Z"));
  await appendJournal(lines);
}

async function makeRepo(): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "keryx-research-sync-")));
  const catalog = path.join(dir, CATALOG_DIR);
  await mkdir(catalog, { recursive: true });
  for (const name of CATALOG_COPY) await copyFile(path.join(REAL_CATALOG, name), path.join(catalog, name));
  for (const [id, status, confirmed] of [["001-alpha", "done", true], ["002-beta", "in-progress", false]] as const) {
    const flow = path.join(dir, ".metaproject", "flows", id);
    await mkdir(path.join(flow, "reviews", "r1"), { recursive: true });
    await writeFile(path.join(flow, "acceptance-criteria.md"), "## Criteria\n\n- AC1: one thing [verify: exec `true`]\n- AC2: another\n");
    await writeFile(path.join(flow, "flow.json"), JSON.stringify({ status, createdAt: "2026-10-01", acConfirmed: confirmed ? { AC1: "x" } : {} }));
    await writeFile(path.join(flow, "reviews", "r1", "manifest.json"), "{}");
    await writeFile(path.join(flow, "reviews", "r1", "findings.json"), JSON.stringify([{ severity: "major", verification: { verdict: "confirmed" } }]));
  }
  await git(dir, "init", "-q", "-b", "main");
  // The journal and the private data under .metaproject/data are not tracked in the real repository either.
  await appendFile(path.join(dir, ".git", "info", "exclude"), ".metaproject/data/\n");
  await git(dir, "add", "-A");
  await git(dir, "commit", "-q", "-m", "fixture");
  return dir;
}

/** The text of a raw file of another machine: one row per [seq, openedAt, extra]. */
const OTHER_HASH = (letter: string): string => letter.repeat(8) + "0".repeat(56);
function otherRows(letter: string, rows: Array<[number, string, Record<string, unknown>?]>): string {
  return rows
    .map(([seq, openedAt, extra]) => JSON.stringify({ ref: `${letter}${seq}`.padEnd(12, "0"), openedAt, arm: "D", hasRecommendation: true, backfilled: false, seq, host: letter.repeat(8), seedHash: OTHER_HASH(letter), ...extra }))
    .join("\n")
    .concat("\n");
}
async function writeRaw(name: string, body: string): Promise<void> {
  await mkdir(inCatalog(RAW_DIR), { recursive: true });
  await writeFile(inCatalog(path.join(RAW_DIR, name)), body);
}
const rawText = (name: string): string => readFileSync(inCatalog(path.join(RAW_DIR, name)), "utf8");
const jsonRows = (body: string): Array<Record<string, unknown>> => body.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);

beforeEach(async () => {
  root = await makeRepo();
  // The machine's seed lives outside the repository: a throwaway config directory stands in for it, so no test reads
  // or writes the real one.
  savedConfigDir = process.env["KERYX_CONFIG_DIR"];
  configDir = await realpath(await mkdtemp(path.join(tmpdir(), "keryx-research-config-")));
  process.env["KERYX_CONFIG_DIR"] = configDir;
  await useSeed("this-machine-seed-0123456789abcdef");
});

async function useSeed(seed: string): Promise<void> {
  const file = await saltFile(root);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${seed}\n`);
  host = createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 8);
  ownRaw = path.join(RAW_DIR, `decisions-${host}.jsonl`);
}

afterEach(async () => {
  if (savedConfigDir === undefined) delete process.env["KERYX_CONFIG_DIR"];
  else process.env["KERYX_CONFIG_DIR"] = savedConfigDir;
  await rm(configDir, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
});

const sync = (extra: Partial<SyncDeps> = {}) => runResearchSync({ root, now: () => T1, ...extra });
const withoutRunLine = (page: string): string => page.replace(/^Запуск \(run, UTC\): .*$/m, "RUN");

describe("AC2 and AC3: what a run writes", () => {
  test("the script the sync runs is the catalog's, unchanged", () => {
    expect(sha(path.join(REAL_CATALOG, "part1-counts.py"))).toBe(SCRIPT_SHA256);
  });

  test.skipIf(!hasPython)("creates the three files and this machine's raw export, leaves the snapshot byte-identical, and touches no git history", async () => {
    await seedJournal();
    const before = SNAPSHOT_FILES.map((name) => sha(inCatalog(name)));
    const commits = await git(root, "rev-list", "--count", "--all");
    const branches = await git(root, "branch", "--list");

    const outcome = await sync();
    expect(outcome).toEqual({ ok: true, changed: [ownRaw, ...SYNC_FILES].map((name) => path.join(CATALOG_DIR, name)) });

    expect(SNAPSHOT_FILES.map((name) => sha(inCatalog(name)))).toEqual(before);
    const status = (await git(root, "status", "--porcelain", "--untracked-files=all")).split("\n").filter(Boolean).sort();
    expect(status).toEqual([ownRaw, ...SYNC_FILES].map((name) => `?? ${CATALOG_DIR}/${name}`).sort());
    expect(await git(root, "rev-list", "--count", "--all")).toBe(commits);
    expect(await git(root, "branch", "--list")).toBe(branches);
  });

  test.skipIf(!hasPython)("the counts are the unchanged script's output at HEAD, the export has the snapshot's format plus the machine fields", async () => {
    await seedJournal();
    await sync();

    const head = (await git(root, "rev-parse", "--short", "HEAD")).trim();
    const latest = JSON.parse(text(LATEST_COUNTS)) as Record<string, unknown>;
    const snapshot = JSON.parse(text("part1-counts.json")) as Record<string, unknown>;
    expect(Object.keys(latest)).toEqual(Object.keys(snapshot));
    expect(latest.commit).toBe(head);
    expect(latest.flows).toBe(2);
    expect(latest.acceptance_criteria).toBe(4);
    expect(latest.acceptance_criteria_confirmed).toBe(1);
    expect(latest.verify_tags).toEqual({ exec: 2, untagged: 2 });
    expect(latest.review_rounds).toBe(2);
    expect(latest.findings).toBe(2);
    // The archive of HEAD is the input: the sync does not leave a counts file in the root.
    expect(existsSync(path.join(root, "part1-counts.json"))).toBe(false);

    const snapshotRow = JSON.parse((readFileSync(inCatalog("decisions-export-2026-10-04.jsonl"), "utf8").split("\n")[0]) as string) as Record<string, unknown>;
    const rows = text(LATEST_EXPORT).split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(text(LATEST_EXPORT).endsWith("\n")).toBe(true);
    expect(rows.length).toBeGreaterThan(0);
    // The snapshot's fields without the seed, then the machine's: seq, seqDerived (the fixture's opens carry no seq), host, seedHash, and globalSeq in the merge.
    const keys = Object.keys(snapshotRow).filter((key) => key !== "seed");
    for (const row of rows) expect(Object.keys(row)).toEqual([...keys, "seq", "seqDerived", "host", "seedHash", "globalSeq"]);
    for (const row of jsonRows(rawText(path.basename(ownRaw)))) expect(Object.keys(row)).toEqual([...keys, "seq", "seqDerived", "host", "seedHash"]);
  });

  test.skipIf(!hasPython)("the counts are those of HEAD, not of the working tree: an uncommitted flow and an uncommitted edit are not counted", async () => {
    // Added after the commit, never staged: only a count taken from the tree would see them.
    const flow = path.join(root, ".metaproject", "flows", "003-gamma");
    await mkdir(flow, { recursive: true });
    await writeFile(path.join(flow, "acceptance-criteria.md"), "## Criteria\n\n- AC1: new [verify: exec `true`]\n- AC2: new\n- AC3: new\n");
    await writeFile(path.join(flow, "flow.json"), JSON.stringify({ status: "done", createdAt: "2026-10-04", acConfirmed: { AC1: "x" } }));
    await appendFile(path.join(root, ".metaproject", "flows", "001-alpha", "acceptance-criteria.md"), "- AC3: edited but not committed\n");
    expect(await git(root, "status", "--porcelain")).toContain("003-gamma");

    await seedJournal();
    expect((await sync()).ok).toBe(true);
    const latest = JSON.parse(text(LATEST_COUNTS)) as Record<string, unknown>;
    expect(latest.flows).toBe(2);
    expect(latest.acceptance_criteria).toBe(4);
    expect(latest.acceptance_criteria_confirmed).toBe(1);
    expect(latest.verify_tags).toEqual({ exec: 2, untagged: 2 });
  });

  test.skipIf(!hasPython)("the whole journal is exported, with no date filter, every timestamp form read as an instant and ordered by it", async () => {
    await seedJournal();
    await sync();
    const rows = jsonRows(text(LATEST_EXPORT)) as Array<{ openedAt: string; seq: number; globalSeq: number; host: string }>;
    expect(rows.map((row) => row.openedAt)).toEqual([
      "2026-09-30T10:00:00.000Z",
      "2026-10-01T22:00:00.000Z",
      "2026-10-01T23:00:00.000Z",
      "2026-10-02T00:30:00.000Z",
      "2026-10-02T03:30:00.000Z",
    ]);
    expect(rows.map((row) => row.globalSeq)).toEqual([1, 2, 3, 4, 5]);
    // seq is the machine's own ordinal of the open records, in journal order (in-z is the first one written).
    expect(rows.map((row) => row.seq)).toEqual([5, 3, 4, 1, 2]);
    expect(new Set(rows.map((row) => row.host))).toEqual(new Set([host]));
    // The raw file is the machine's journal in journal order; the merged file is the same rows reordered.
    expect(jsonRows(rawText(path.basename(ownRaw))).map((row) => row.seq)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("AC4: the export carries no words", () => {
  test.skipIf(!hasPython)("every key is on the allow-list of flow 402, and no planted text reaches the file", async () => {
    await seedJournal();
    await sync();
    expect([...(EXPORT_FIELDS as readonly string[])].sort()).toEqual([...ALLOWED_FIELDS].sort());
    const body = text(LATEST_EXPORT);
    for (const secret of SECRETS) expect(body.includes(secret)).toBe(false);
    for (const file of [body, rawText(path.basename(ownRaw))]) {
      for (const secret of SECRETS) expect(file.includes(secret)).toBe(false);
      expect(file.includes("this-machine-seed")).toBe(false);
    }
    for (const line of [...body.split("\n"), ...rawText(path.basename(ownRaw)).split("\n")].filter(Boolean)) {
      const row = JSON.parse(line) as Record<string, unknown>;
      expect("seed" in row).toBe(false);
      for (const key of Object.keys(row)) expect(MACHINE_FIELDS).toContain(key);
      for (const rating of (row.ratings as Array<Record<string, unknown>>) ?? []) {
        for (const key of Object.keys(rating)) expect(["rater", "quality", "model", "cleanContext", "modelAgree", "at"]).toContain(key);
      }
    }
  });
});

describe("AC5: the status page", () => {
  test.skipIf(!hasPython)("holds the run time, HEAD, a row per snapshot key, the journal summary and the contribution rows", async () => {
    await seedJournal();
    await sync();
    const page = text(STATUS_FILE);
    const head = (await git(root, "rev-parse", "HEAD")).trim();
    expect(page).toContain("\nЗапуск (run, UTC): 2026-10-05 04:00 UTC\n");
    expect(page).toContain(`HEAD: ${head}`);
    expect(page).toContain(`- Машин в журнале (machines in the journal): 1; записей по машинам (records per machine): ${host} 5\n`);
    expect(page).toContain("- Решений во всех машинах (decisions, all machines): 5; с рекомендацией (with a recommendation): 5; живых, не backfilled (live, not backfilled): 5\n");
    expect(page).toContain("| Ключ (key) | снимок 04809f4f | сейчас |");
    for (const key of Object.keys(JSON.parse(text("part1-counts.json")) as Record<string, unknown>)) expect(page).toContain(`| ${key} | `);
    const rows = (text("contribution-log.md").match(/^\d{4}-\d{2}-\d{2} · /gm) ?? []).length;
    expect(page).toContain(`Строк в contribution-log.md (rows): ${rows}`);
    for (const label of ["Решений (decisions): 5; с рекомендацией (with a recommendation): 5", "(matches, normal)", "(matches, blind)", "с причиной (with a reason)", "без причины (without a reason)", "(excluded-irreversible)", "порогу P7", "AC11 флоу 392"]) {
      expect(page).toContain(label);
    }
    // AC11 of flow 392 also needs two weeks of use and an operator's judgement: the page reports numbers, not the verdict.
    expect(page).toMatch(/числа (не )?достигнуты \(numeric targets (not )?met\)/);
    expect(page).not.toContain("выполнено");
    expect(await readLastSyncRun(root)).toBe("2026-10-05 04:00 UTC");
  });
});

describe("AC6: a second run with no new data", () => {
  test.skipIf(!hasPython)("changes no file except the run time in the status page", async () => {
    await seedJournal();
    await sync();
    const first = new Map(SYNC_FILES.map((name) => [name, text(name)] as const));
    const rawBefore = text(ownRaw);

    const outcome = await runResearchSync({ root, now: () => T2 });
    expect(outcome.ok).toBe(true);
    expect(outcome.changed).toEqual([path.join(CATALOG_DIR, STATUS_FILE)]);
    expect(text(LATEST_COUNTS)).toBe(first.get(LATEST_COUNTS) as string);
    expect(text(LATEST_EXPORT)).toBe(first.get(LATEST_EXPORT) as string);
    expect(text(ownRaw)).toBe(rawBefore);
    expect(text(STATUS_FILE)).not.toBe(first.get(STATUS_FILE) as string);
    expect(withoutRunLine(text(STATUS_FILE))).toBe(withoutRunLine(first.get(STATUS_FILE) as string));
    expect(text(STATUS_FILE)).toContain("Запуск (run, UTC): 2026-10-06 04:00 UTC");

    // The same minute again: not even the status page is written.
    expect((await runResearchSync({ root, now: () => new Date(T2.getTime() + 10_000) })).changed).toEqual([]);
  });

  test.skipIf(!hasPython)("new journal data changes the export and the status page, not the counts", async () => {
    await seedJournal();
    await sync();
    const counts = text(LATEST_COUNTS);
    const exportBefore = text(LATEST_EXPORT);
    await appendJournal([openLine("fresh", "2026-10-04T09:00:00.000Z"), answerLine("fresh", "2026-10-04T09:00:05.000Z")]);

    const outcome = await runResearchSync({ root, now: () => T2 });
    expect(outcome.changed).toEqual([ownRaw, LATEST_EXPORT, STATUS_FILE].map((name) => path.join(CATALOG_DIR, name)));
    expect(text(LATEST_COUNTS)).toBe(counts);
    expect(text(LATEST_EXPORT).split("\n").filter(Boolean)).toHaveLength(exportBefore.split("\n").filter(Boolean).length + 1);
    expect(text(STATUS_FILE)).toContain("Решений (decisions): 6;");
  });
});

describe("AC7: the operator's team repositories are named nowhere", () => {
  test.skipIf(!hasPython)("no file the sync writes, and no file in the catalog, holds a kept-out term", async () => {
    await seedJournal();
    await sync();
    const names = readdirSync(path.join(root, CATALOG_DIR)).filter((name) => statSync(inCatalog(name)).isFile());
    for (const name of SYNC_FILES) expect(names).toContain(name);
    names.push(ownRaw);
    for (const name of names) {
      const body = text(name).toLowerCase();
      for (const term of OFF_LIMITS) expect(`${name}: ${body.includes(term)}`).toBe(`${name}: false`);
    }
  });

  test("a result that would name one is refused, and the last good data stays", async () => {
    await seedJournal();
    const good = JSON.stringify({ commit: "abc", generated_at: "2026-10-05T04:00Z", flows: 1 }, null, 2);
    await sync({ runCounts: async () => good, headHash: async () => "h".repeat(40) });
    const kept = text(LATEST_COUNTS);

    const outcome = await runResearchSync({
      root,
      now: () => T2,
      runCounts: async () => JSON.stringify({ commit: "abc", generated_at: "x", flows: 2, board: 1 }),
      headHash: async () => "h".repeat(40),
    });
    expect(outcome.ok).toBe(false);
    expect(text(LATEST_COUNTS)).toBe(kept);
    expect(text(STATUS_FILE).toLowerCase()).not.toContain("board");
  });
});

describe("AC8: a failed run", () => {
  test.skipIf(!hasPython)("leaves the previous -latest files untouched and writes the reason, in one line, into the status page", async () => {
    await seedJournal();
    await sync();
    const before = { counts: text(LATEST_COUNTS), exported: text(LATEST_EXPORT), status: text(STATUS_FILE), raw: text(ownRaw) };
    // New journal data the failing run would have exported: a -latest file written too early would hold this row.
    await appendJournal([openLine("fresh", "2026-10-04T09:00:00.000Z"), answerLine("fresh", "2026-10-04T09:00:05.000Z")]);

    const outcome = await runResearchSync({
      root,
      now: () => T2,
      runCounts: async () => {
        throw new Error(`counts script failed in ${root}\n    at stack frame one\n    at stack frame two`);
      },
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.changed).toEqual([]);
    expect(text(LATEST_COUNTS)).toBe(before.counts);
    expect(text(LATEST_EXPORT)).toBe(before.exported);
    expect(text(LATEST_EXPORT)).not.toContain(exportRef("fresh"));
    expect(text(ownRaw)).toBe(before.raw);

    const page = text(STATUS_FILE);
    expect(page).toContain("Решений (decisions): 5;");
    const reasonLines = page.split("\n").filter((line) => line.startsWith("Состояние (status): "));
    expect(reasonLines).toEqual(["Состояние (status): ошибка (failed): counts script failed in ."]);
    expect(page).not.toContain("stack frame");
    expect(page).not.toContain(root);
    expect(page).toContain("Запуск (run, UTC): 2026-10-06 04:00 UTC");
    expect(page).toContain("Последний успешный запуск (last successful run, UTC): 2026-10-05 04:00 UTC");
    // The data of the last good run stays readable below the reason.
    expect(page).toContain("## Журнал решений (decisions journal)");

    // A second failure keeps the time of the last good run, not the time of the first failure.
    await runResearchSync({ root, now: () => new Date("2026-10-07T04:00:00Z"), runCounts: async () => Promise.reject(new Error("again")) });
    expect(text(STATUS_FILE)).toContain("Последний успешный запуск (last successful run, UTC): 2026-10-05 04:00 UTC");
    expect(text(STATUS_FILE)).toContain("ошибка (failed): again");
    expect(text(LATEST_COUNTS)).toBe(before.counts);
  });

  test("a write that fails on the second file leaves the previous trio as it was, and no temp file behind", async () => {
    await seedJournal();
    const counts = (flows: number): string => JSON.stringify({ commit: "abc", generated_at: "2026-10-05T04:00Z", flows });
    const fakeHead = async (): Promise<string> => "h".repeat(40);
    await sync({ runCounts: async () => counts(1), headHash: fakeHead });
    const before = { counts: text(LATEST_COUNTS), exported: text(LATEST_EXPORT), status: text(STATUS_FILE), raw: text(ownRaw) };
    // Everything differs now: other counts, one more export row, another run time.
    await appendJournal([openLine("fresh", "2026-10-04T09:00:00.000Z"), answerLine("fresh", "2026-10-04T09:00:05.000Z")]);

    const written: string[] = [];
    const outcome = await runResearchSync({
      root,
      now: () => T2,
      runCounts: async () => counts(2),
      headHash: fakeHead,
      writeStaged: async (file, content) => {
        if (path.basename(file).startsWith(LATEST_EXPORT)) throw new Error("disk full");
        written.push(path.basename(file));
        await writeFile(file, content, "utf8");
      },
    });
    // The counts file was staged before the failure; it must not have been renamed over the old one.
    expect(written.some((name) => name.startsWith(LATEST_COUNTS))).toBe(true);
    expect(outcome).toEqual({ ok: false, reason: "disk full", changed: [] });
    expect(text(LATEST_COUNTS)).toBe(before.counts);
    expect(text(LATEST_EXPORT)).toBe(before.exported);
    expect(text(ownRaw)).toBe(before.raw);
    expect(readdirSync(path.join(root, CATALOG_DIR)).filter((name) => name.includes(".tmp-"))).toEqual([]);
    expect(readdirSync(inCatalog(RAW_DIR)).filter((name) => name.includes(".tmp-"))).toEqual([]);

    // The status page is the one place the reason goes; the data below it is the last good run's.
    const page = text(STATUS_FILE);
    expect(page).toContain("Состояние (status): ошибка (failed): disk full");
    expect(page).toContain("Последний успешный запуск (last successful run, UTC): 2026-10-05 04:00 UTC");
    expect(page).toContain("Решений (decisions): 5;");
    expect(before.status).toContain("Состояние (status): ok");
  });

  test("a rename that fails on the second file restores the first, so the trio stays of one generation", async () => {
    await seedJournal();
    const counts = (flows: number): string => JSON.stringify({ commit: "abc", generated_at: "2026-10-05T04:00Z", flows });
    const fakeHead = async (): Promise<string> => "h".repeat(40);
    await sync({ runCounts: async () => counts(1), headHash: fakeHead });
    const before = { counts: text(LATEST_COUNTS), exported: text(LATEST_EXPORT), raw: text(ownRaw) };
    await appendJournal([openLine("fresh", "2026-10-04T09:00:00.000Z"), answerLine("fresh", "2026-10-04T09:00:05.000Z")]);

    const outcome = await runResearchSync({
      root,
      now: () => T2,
      runCounts: async () => counts(2),
      headHash: fakeHead,
      renameStaged: async (from, to) => {
        if (path.basename(to) === LATEST_EXPORT) throw new Error("rename denied");
        await rename(from, to);
      },
    });
    expect(outcome).toEqual({ ok: false, reason: "rename denied", changed: [] });
    expect(text(LATEST_COUNTS)).toBe(before.counts);
    expect(text(LATEST_EXPORT)).toBe(before.exported);
    // The raw file was renamed first: it is put back, so it never holds a row the -latest file lacks.
    expect(text(ownRaw)).toBe(before.raw);
    expect(readdirSync(path.join(root, CATALOG_DIR)).filter((name) => name.includes(".tmp-"))).toEqual([]);
    expect(text(STATUS_FILE)).toContain("Состояние (status): ошибка (failed): rename denied");
  });

  test("the off-limits check matches whole words: dashboard passes, a standalone board does not", () => {
    expect(namesOffLimits("the dashboard and the keyboard")).toBe(false);
    expect(namesOffLimits("a board")).toBe(true);
    expect(namesOffLimits("Board, frontend-app, process-metrics")).toBe(true);
    expect(namesOffLimits("my_board")).toBe(true);
  });

  test("a counts result that is not JSON fails the run and writes nothing but the reason", async () => {
    const outcome = await sync({ runCounts: async () => "not json", headHash: async () => "h".repeat(40) });
    expect(outcome).toEqual({ ok: false, reason: "counts is not valid JSON", changed: [] });
    expect(existsSync(inCatalog(LATEST_COUNTS))).toBe(false);
    expect(existsSync(inCatalog(LATEST_EXPORT))).toBe(false);
    expect(text(STATUS_FILE)).toContain("Состояние (status): ошибка (failed): counts is not valid JSON");
    expect(text(STATUS_FILE)).toContain("Последний успешный запуск (last successful run, UTC): нет (none)");
  });

  test("outside the repository root it fails without writing anything", async () => {
    const empty = await realpath(await mkdtemp(path.join(tmpdir(), "keryx-research-empty-")));
    try {
      const outcome = await runResearchSync({ root: empty, now: () => T1 });
      expect(outcome.ok).toBe(false);
      expect(outcome.reason).toContain("run from the repository root");
      expect(readdirSync(empty)).toEqual([]);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  test("the sync sources hold no commit call, no staging, no hook registration and no hourly logic", async () => {
    // The daily job (flow 404, AC8) is part of the sync code, and so are the places that wire it in: the serve
    // composition root, the TUI panel and the registry. Whole files are scanned where they belong to the sync; in
    // `serve.ts` and `cli-registry.ts` only the lines that name the research sync are, so the rest of those files
    // cannot cause a false alarm. `serve-research-sync.ts` is the one place that owns the repeating timer serve needs
    // to look at the clock, so only it is exempt from the timer rule; the TUI panel's once-a-minute read-only poll is
    // a timer too, and is the second (and last) exemption.
    const here = import.meta.dir;
    const whole = [
      path.join(here, "research-sync.ts"),
      path.join(here, "research-sync-status.ts"),
      path.join(here, "..", "scheduler", "research-sync-job.ts"),
      path.join(here, "serve-research-sync.ts"),
      path.join(here, "..", "tui", "research-sync-panel.ts"),
    ];
    const researchLines = (file: string): string => readFileSync(file, "utf8").split("\n").filter((line) => /research/i.test(line)).join("\n");
    const sources = [
      ...whole.map((file) => ({ name: path.basename(file), body: readFileSync(file, "utf8") })),
      { name: "serve.ts (research lines)", body: researchLines(path.join(here, "serve.ts")) },
      { name: "cli-registry.ts (research lines)", body: researchLines(path.join(here, "..", "cli-registry.ts")) },
    ];
    // The extraction really found the wiring, so an emptied block cannot pass the scan by being empty.
    expect(sources.find((s) => s.name.startsWith("serve.ts"))?.body).toContain("createServeResearchSync");
    expect(sources.find((s) => s.name.startsWith("cli-registry.ts"))?.body).toContain("researchCommand");
    const banned: Array<[string, RegExp]> = [
      ["a git history call", /git\s+(push|branch|tag|stash|commit|add)\b|["'](push|branch|tag|stash|commit|add)["']/],
      ["a commit call", /\bcommit\s*\(/],
      ["a pull request", /\bgh\s+pr\b|["']pr["']\s*,\s*["'](create|merge)["']/],
      ["a file watcher", /\bfs\.watch\b|\bwatchFile\b|(?<![\w.])watch\s*\(|\.watch\s*\(|chokidar/],
      ["a process hook registration", /process\.(on|once|addListener)\s*\(/],
      ["a hook registration", /registerHook|installHook|addHook|\bhooks?\.(on|register|add|install)\b|post-commit|\.git\/hooks|PostToolUse/],
      ["an hourly or cron wording", /hourly|\bcron\b/i],
      ["a repeating timer", /setInterval/],
    ];
    const timerExempt = new Set(["serve-research-sync.ts", "research-sync-panel.ts"]);
    for (const { name, body } of sources) {
      for (const [what, pattern] of banned) {
        if (timerExempt.has(name) && what === "a repeating timer") continue;
        expect(`${name}: ${what}: ${pattern.test(body)}`).toBe(`${name}: ${what}: false`);
      }
    }
    // The timer in serve looks once every few minutes and runs nothing hourly: the only interval is the check.
    const serveBody = sources.find((s) => s.name === "serve-research-sync.ts")?.body ?? "";
    expect(/hourly|\bcron\b/i.test(serveBody)).toBe(false);
  });
});

// The journal merge: each machine writes only its own raw file, and -latest is the merge of every raw file.
describe("one raw export per machine, merged into -latest", () => {
  // The counts are not what these tests are about: a fixed result keeps them off python and git.
  const fakeCounts = { runCounts: async () => JSON.stringify({ commit: "abc", generated_at: "2026-10-05T04:00Z", flows: 1 }), headHash: async () => "h".repeat(40) };
  const OTHER = "aaaaaaaa";
  const otherName = `decisions-${OTHER}.jsonl`;
  const otherFile = (): string =>
    otherRows("a", [
      [1, "2026-10-02T00:10:00.000Z", { backfilled: true, arm: "C" }],
      [2, "2026-10-04T12:00:00.000Z"],
    ]);

  test("two machines: the own raw file is written, the other's is byte-identical, -latest holds every row in order with globalSeq", async () => {
    await seedJournal();
    await writeRaw(otherName, otherFile());
    const otherBefore = sha(inCatalog(path.join(RAW_DIR, otherName)));

    const outcome = await sync(fakeCounts);
    expect(outcome.ok).toBe(true);
    expect(outcome.changed).toEqual([ownRaw, LATEST_COUNTS, LATEST_EXPORT, STATUS_FILE].map((name) => path.join(CATALOG_DIR, name)));
    expect(sha(inCatalog(path.join(RAW_DIR, otherName)))).toBe(otherBefore);
    expect(jsonRows(rawText(path.basename(ownRaw))).map((row) => row.seq)).toEqual([1, 2, 3, 4, 5]);

    const rows = jsonRows(text(LATEST_EXPORT));
    expect(rows).toHaveLength(7);
    expect(rows.map((row) => row.openedAt)).toEqual([...rows.map((row) => row.openedAt as string)].sort());
    expect(rows.map((row) => row.globalSeq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    // seq stays as each machine wrote it; the other machine's arm and backfilled flag are kept as they were.
    const theirs = rows.filter((row) => row.host === OTHER);
    expect(theirs.map((row) => [row.seq, row.arm, row.backfilled])).toEqual([[1, "C", true], [2, "D", false]]);
    expect(rows.filter((row) => row.host === host).map((row) => row.seq).sort()).toEqual([1, 2, 3, 4, 5]);
    expect(rows.find((row) => row.openedAt === "2026-10-02T00:10:00.000Z")?.globalSeq).toBe(4);

    const perHost = [`${OTHER} 2`, `${host} 5`].sort().join(", ");
    const page = text(STATUS_FILE);
    expect(page).toContain(`- Машин в журнале (machines in the journal): 2; записей по машинам (records per machine): ${perHost}\n`);
    expect(page).toContain("- Решений во всех машинах (decisions, all machines): 7; с рекомендацией (with a recommendation): 7; живых, не backfilled (live, not backfilled): 6\n");

    // A second run, even a minute later, changes nothing but the run time.
    const second = await runResearchSync({ root, now: () => T2, ...fakeCounts });
    expect(second.changed).toEqual([path.join(CATALOG_DIR, STATUS_FILE)]);
    expect((await runResearchSync({ root, now: () => new Date(T2.getTime() + 10_000), ...fakeCounts })).changed).toEqual([]);
    expect(sha(inCatalog(path.join(RAW_DIR, otherName)))).toBe(otherBefore);
  });

  test("a machine with no seed writes no raw file and no raw directory; -latest is the merge of the files already there", async () => {
    await rm(await saltFile(root));
    await appendJournal([openLine("x", "2026-10-02T00:30:00.000Z")]);
    expect((await sync(fakeCounts)).changed).toEqual([LATEST_COUNTS, LATEST_EXPORT, STATUS_FILE].map((name) => path.join(CATALOG_DIR, name)));
    expect(existsSync(inCatalog(RAW_DIR))).toBe(false);
    expect(text(LATEST_EXPORT)).toBe("");
    expect(text(STATUS_FILE)).toContain("machines in the journal): 0; записей по машинам (records per machine): нет (none)\n");

    await writeRaw(otherName, otherFile());
    expect((await runResearchSync({ root, now: () => T2, ...fakeCounts })).changed).toEqual([LATEST_EXPORT, STATUS_FILE].map((name) => path.join(CATALOG_DIR, name)));
    expect(jsonRows(text(LATEST_EXPORT)).map((row) => row.globalSeq)).toEqual([1, 2]);
    expect(readdirSync(inCatalog(RAW_DIR))).toEqual([otherName]);
  });

  test("a duplicate (host, seq) in raw fails the run: -latest and the own raw file stay, the reason goes into the status page", async () => {
    await seedJournal();
    await writeRaw(otherName, otherFile());
    await sync(fakeCounts);
    const before = { latest: text(LATEST_EXPORT), raw: text(ownRaw), counts: text(LATEST_COUNTS) };
    // The same machine, the same seq, in a second file; and new journal data that would have changed -latest.
    await writeRaw(`decisions-${OTHER}-copy.jsonl`, otherRows("a", [[2, "2026-10-04T13:00:00.000Z"]]));
    await appendJournal([openLine("fresh", "2026-10-04T09:00:00.000Z")]);

    const outcome = await runResearchSync({ root, now: () => T2, ...fakeCounts });
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain("duplicate (host, seq)");
    expect(outcome.changed).toEqual([]);
    expect(text(LATEST_EXPORT)).toBe(before.latest);
    expect(text(ownRaw)).toBe(before.raw);
    expect(text(LATEST_COUNTS)).toBe(before.counts);
    expect(text(STATUS_FILE)).toContain("Состояние (status): ошибка (failed): duplicate (host, seq)");
    expect(text(STATUS_FILE)).not.toContain(root);
  });

  test("an invalid raw file (a seed in a row) or a row naming a kept-out repository fails the run and writes nothing", async () => {
    await seedJournal();
    await sync(fakeCounts);
    const before = { latest: text(LATEST_EXPORT), raw: text(ownRaw) };
    await appendJournal([openLine("fresh", "2026-10-04T09:00:00.000Z")]);

    await writeRaw(otherName, otherRows("a", [[1, "2026-10-02T00:10:00.000Z", { seed: 7 }]]));
    let outcome = await runResearchSync({ root, now: () => T2, ...fakeCounts });
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain(`raw/${otherName}: line 1: a row carries a seed`);

    await writeRaw(otherName, otherRows("a", [[1, "2026-10-02T00:10:00.000Z", { channel: "board" }]]));
    outcome = await runResearchSync({ root, now: () => T2, ...fakeCounts });
    expect(outcome).toEqual({ ok: false, reason: "output names a repository that must not appear", changed: [] });

    expect(text(LATEST_EXPORT)).toBe(before.latest);
    expect(text(ownRaw)).toBe(before.raw);
    expect(text(STATUS_FILE).toLowerCase()).not.toContain("board");
  });
});

describe("the command", () => {
  const run = async (cwd: string, ...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
    try {
      const { stdout, stderr } = await exec(process.execPath, [CLI, ...args], { cwd, timeout: 120_000 });
      return { code: 0, stdout, stderr };
    } catch (error) {
      const failed = error as { code?: number; stdout?: string; stderr?: string };
      return { code: typeof failed.code === "number" ? failed.code : 1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
    }
  };

  test("`keryx research --help` and `keryx --help` list `research sync`", async () => {
    const help = await run(root, "research", "--help");
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("keryx research sync");
    const flat = await run(root, "--help");
    expect(flat.stdout).toContain("keryx research sync");
    expect(flat.stdout).toContain("research  Part 1 materials");
  });

  test("an unknown research subcommand fails", async () => {
    const result = await run(root, "research", "nope");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Unknown command: nope");
  });

  test.skipIf(!hasPython)("`keryx research sync` from the root writes the three files and exits 0; a second run changes nothing", async () => {
    await seedJournal();
    const first = await run(root, "research", "sync");
    expect(first.code).toBe(0);
    const status = (await git(root, "status", "--porcelain", "--untracked-files=all")).split("\n").filter(Boolean).sort();
    expect(status).toEqual([ownRaw, ...SYNC_FILES].map((name) => `?? ${CATALOG_DIR}/${name}`).sort());
    // What the first run wrote, byte for byte, taken before the second run starts.
    const afterFirst = new Map(SYNC_FILES.map((name) => [name, text(name)] as const));
    const second = await run(root, "research", "sync");
    expect(second.code).toBe(0);
    expect(await readFile(inCatalog(LATEST_COUNTS), "utf8")).toBe(afterFirst.get(LATEST_COUNTS) as string);
    expect(await readFile(inCatalog(LATEST_EXPORT), "utf8")).toBe(afterFirst.get(LATEST_EXPORT) as string);
    // The status page may differ in its run line only (the two runs can fall in different minutes).
    expect(withoutRunLine(await readFile(inCatalog(STATUS_FILE), "utf8"))).toBe(withoutRunLine(afterFirst.get(STATUS_FILE) as string));
    expect(second.stdout).toContain("Research sync done");
  });

  test("`--schedule daily` creates the daily entry without running the sync; `--unschedule` takes it away", async () => {
    const entry = path.join(root, ".metaproject", "data", "research-sync", "schedule.json");
    const help = await run(root, "research", "--help");
    for (const text of ["keryx research sync --schedule daily", "keryx research sync --unschedule"]) expect(help.stdout).toContain(text);

    const created = await run(root, "research", "sync", "--schedule", "daily");
    expect(created.code).toBe(0);
    expect(created.stdout).toContain("Daily research sync scheduled");
    expect(existsSync(entry)).toBe(true);
    // Creating the entry runs nothing: no -latest file, no status page.
    for (const name of SYNC_FILES) expect(existsSync(inCatalog(name))).toBe(false);

    const again = await run(root, "research", "sync", "--schedule=daily");
    expect(again.code).toBe(0);
    expect(again.stdout).toContain("already scheduled");

    const removed = await run(root, "research", "sync", "--unschedule");
    expect(removed.code).toBe(0);
    expect(removed.stdout).toContain("Daily research sync removed");
    expect(existsSync(entry)).toBe(false);
    const nothing = await run(root, "research", "sync", "--unschedule");
    expect(nothing.code).toBe(0);
    expect(nothing.stdout).toContain("No daily research sync was scheduled");
  });

  test("bad schedule arguments fail with one line on stderr and create nothing", async () => {
    const entry = path.join(root, ".metaproject", "data", "research-sync", "schedule.json");
    for (const args of [["--schedule"], ["--schedule", "hourly"], ["--schedule", "daily", "--unschedule"], ["--bogus"], ["daily"]]) {
      const result = await run(root, "research", "sync", ...args);
      expect(`${args.join(" ")}: ${result.code}`).toBe(`${args.join(" ")}: 1`);
      expect(result.stderr.trim().split("\n")).toHaveLength(1);
    }
    expect(existsSync(entry)).toBe(false);
  });

  test("`--schedule daily` outside the repository root fails and writes nothing", async () => {
    const empty = await realpath(await mkdtemp(path.join(tmpdir(), "keryx-research-empty-")));
    try {
      const result = await run(empty, "research", "sync", "--schedule", "daily");
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("run from the repository root");
      expect(readdirSync(empty)).toEqual([]);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  test("from a directory that is not the root it exits non-zero with one line on stderr", async () => {
    const empty = await realpath(await mkdtemp(path.join(tmpdir(), "keryx-research-empty-")));
    try {
      const result = await run(empty, "research", "sync");
      expect(result.code).toBe(1);
      expect(result.stderr.trim().split("\n")).toHaveLength(1);
      expect(result.stderr).toContain("Research sync failed");
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});
