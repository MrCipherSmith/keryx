// Offline coverage for the long-session tasks' generators and oracles (flow 387 T22a). Synthetic
// before/after trees only: no network, no model, no git. Beyond "a perfect answer passes" it
// proves the traps in each corpus actually bite: the naive strategies a shortcut-taking agent
// would use (global sed, stale tokens, first-switch-wins) must FAIL the oracle.

import { describe, expect, test } from "bun:test";
import {
  LONG_TASKS,
  REGISTRY_DIR,
  REGISTRY_SHARD_COUNT,
  RENAME_DIR,
  RENAME_FILE_COUNT,
  buildRegistryCase,
  buildRenameCase,
  checkRegistryAnswer,
  checkRenameTree,
  finalZone,
  selectLongTasks,
} from "./long-tasks";

const READ_CAP = 20_000; // interactive-tools MAX_READ_BYTES: one read_file call returns a whole file below this

function readerOf(files: ReadonlyMap<string, string>): (rel: string) => string | undefined {
  return (rel) => files.get(rel);
}

describe("registry-recall corpus", () => {
  const exp = buildRegistryCase();
  const byPath = new Map(exp.files.map((f) => [f.path, f.content]));

  test("is deterministic", () => {
    const again = buildRegistryCase();
    expect(again.files.map((f) => f.content)).toEqual(exp.files.map((f) => f.content));
    expect(again.answer).toEqual(exp.answer);
  });

  test("has 22 shards, each readable in one read_file call and big enough to matter", () => {
    const shards = exp.files.filter((f) => f.path.startsWith(`${REGISTRY_DIR}/shards/`));
    expect(shards).toHaveLength(REGISTRY_SHARD_COUNT);
    for (const s of shards) {
      expect(s.content.length).toBeLessThan(READ_CAP);
      expect(s.content.length).toBeGreaterThan(15_000);
    }
    const tokens = shards.reduce((n, s) => n + Math.ceil(s.content.length / 4), 0);
    expect(tokens).toBeGreaterThan(90_000);
  });

  test("the registry dump is a spill-sized output with the table mid-file and the revision later", () => {
    const dump = byPath.get(`${REGISTRY_DIR}/registry-dump.txt`) as string;
    const lines = dump.split("\n");
    expect(lines.length).toBeGreaterThan(2000);
    expect(Buffer.byteLength(dump)).toBeGreaterThan(50 * 1024);
    const firstVault = lines.findIndex((l) => l.startsWith("ZONE-VAULT "));
    const firstRevised = lines.findIndex((l) => l.startsWith("ZONE-VAULT-REVISED"));
    expect(firstVault).toBeGreaterThan(900);
    expect(firstVault).toBeLessThan(1100);
    expect(firstRevised).toBeGreaterThan(1400);
    // Neither lands in the head or tail preview a spilled output shows.
    expect(lines.length - firstRevised).toBeGreaterThan(300);
  });

  test("seed files name no answer and nothing of the task's solution", () => {
    for (const f of exp.files) expect(f.content.toLowerCase()).not.toContain("answer");
  });

  // An independent re-derivation from the seeded TEXT (not from the generator's models).
  function deriveFromText(): Record<string, string> {
    const dump = (byPath.get(`${REGISTRY_DIR}/registry-dump.txt`) as string).split("\n");
    const vault = new Map<string, string>();
    const revised = new Map<string, string>();
    for (const line of dump) {
      const m = /^(ZONE-VAULT|ZONE-VAULT-REVISED) (Z-\d\d) token=(\S+)$/.exec(line);
      if (m === null) continue;
      (m[1] === "ZONE-VAULT" ? vault : revised).set(m[2] as string, m[3] as string);
    }
    const out: Record<string, string> = {};
    for (let i = 1; i <= REGISTRY_SHARD_COUNT; i += 1) {
      const key = `shard-${String(i).padStart(2, "0")}`;
      const text = byPath.get(`${REGISTRY_DIR}/shards/${key}.log`) as string;
      const lines = text.split("\n");
      const stack = [(/initial-zone=(Z-\d\d)/.exec(lines[0] as string) as RegExpExecArray)[1] as string];
      for (const line of lines.slice(1)) {
        if (/ ZONE-SWITCH-ROLLBACK /.test(line)) {
          if (stack.length > 1) stack.pop();
        } else if (/ ZONE-SWITCH active-zone=/.test(line)) {
          stack.push((/active-zone=(Z-\d\d)/.exec(line) as RegExpExecArray)[1] as string);
        }
      }
      const zone = stack[stack.length - 1] as string;
      out[key] = revised.get(zone) ?? (vault.get(zone) as string);
    }
    return out;
  }

  test("the answer key equals an independent parse of the seeded files", () => {
    expect(deriveFromText()).toEqual({ ...exp.answer });
  });

  test("the answer is not degenerate and every shard carries a draft, a switch and decoys", () => {
    expect(new Set(Object.values(exp.answer)).size).toBeGreaterThanOrEqual(6);
    for (const s of exp.shards) {
      expect(s.text).toContain("ZONE-SWITCH-DRAFT");
      expect(s.text).toMatch(/ZONE-SWITCH active-zone=/);
    }
    expect(exp.shards.some((s) => s.text.includes("ZONE-SWITCH-ROLLBACK"))).toBe(true);
    expect(exp.shards.some((s) => s.text.includes("zone-check ok"))).toBe(true);
  });

  test("the traps bite: first-switch, no-rollback and stale/unrevised tokens each give a wrong answer somewhere", () => {
    const dump = (byPath.get(`${REGISTRY_DIR}/registry-dump.txt`) as string).split("\n");
    const vault = new Map<string, string>();
    const old = new Map<string, string>();
    for (const line of dump) {
      const m = /^(ZONE-VAULT|ZONE-VAULT-OLD) (Z-\d\d) token=(\S+)$/.exec(line);
      if (m !== null) (m[1] === "ZONE-VAULT" ? vault : old).set(m[2] as string, m[3] as string);
    }
    const noRevision = exp.shards.map((s) => vault.get(finalZone(s.initial, s.events)) as string);
    const keys = Object.keys(exp.answer);
    expect(noRevision.some((t, i) => t !== exp.answer[keys[i] as string])).toBe(true);
    const stale = exp.shards.map((s) => old.get(finalZone(s.initial, s.events)) as string);
    expect(stale.some((t, i) => t !== exp.answer[keys[i] as string])).toBe(true);
    const truth = exp.shards.map((s) => finalZone(s.initial, s.events));
    const noRollback = exp.shards.map((s) => finalZone(s.initial, s.events.filter((e) => e.kind !== "rollback")));
    expect(noRollback.some((z, i) => z !== truth[i])).toBe(true);
    const firstSwitch = exp.shards.map((s) => s.events.find((e) => e.kind === "switch")?.zone ?? s.initial);
    expect(firstSwitch.some((z, i) => z !== truth[i])).toBe(true);
  });
});

describe("finalZone", () => {
  test("switch pushes, rollback pops to the previous zone, draft is ignored, rollback at the base is a no-op", () => {
    expect(finalZone("Z-01", [{ kind: "switch", zone: "Z-02" }, { kind: "draft", zone: "Z-09" }])).toBe("Z-02");
    expect(finalZone("Z-01", [{ kind: "switch", zone: "Z-02" }, { kind: "switch", zone: "Z-03" }, { kind: "rollback" }])).toBe("Z-02");
    expect(finalZone("Z-01", [{ kind: "switch", zone: "Z-02" }, { kind: "rollback" }, { kind: "rollback" }])).toBe("Z-01");
  });
});

describe("checkRegistryAnswer", () => {
  const expected = { "shard-01": "amber-1", "shard-02": "basalt-2", "shard-03": "cobalt-3" };

  test("an exact answer passes with score 1", () => {
    const r = checkRegistryAnswer(expected, JSON.stringify(expected));
    expect(r).toMatchObject({ success: true, score: 1, correct: 3, total: 3 });
  });

  test("a wrong token fails and reports it; a missing key counts as missing", () => {
    const r = checkRegistryAnswer(expected, JSON.stringify({ "shard-01": "amber-1", "shard-02": "WRONG" }));
    expect(r.success).toBe(false);
    expect(r.correct).toBe(1);
    expect(r.score).toBeCloseTo(1 / 3);
    expect(r.counters).toEqual({ missing: 1, wrong: 1 });
    expect(r.failures.join("\n")).toContain("shard-02: expected basalt-2, got WRONG");
    expect(r.failures.join("\n")).toContain("shard-03: missing");
  });

  test("no file, invalid JSON, and a non-object all score 0", () => {
    expect(checkRegistryAnswer(expected, undefined)).toMatchObject({ success: false, score: 0 });
    expect(checkRegistryAnswer(expected, "{nope")).toMatchObject({ success: false, score: 0 });
    expect(checkRegistryAnswer(expected, "[1,2]")).toMatchObject({ success: false, score: 0 });
  });

  test("extra keys are ignored and a non-string value is wrong, not a crash", () => {
    expect(checkRegistryAnswer(expected, JSON.stringify({ ...expected, extra: "x" })).success).toBe(true);
    expect(checkRegistryAnswer(expected, JSON.stringify({ ...expected, "shard-01": 5 })).success).toBe(false);
  });

  test("the real case: untouched tree fails, the full key passes", () => {
    const task = LONG_TASKS.find((t) => t.name === "registry-recall");
    const built = task!.build();
    expect(built.check(() => undefined).success).toBe(false);
    const key = JSON.stringify(buildRegistryCase().answer);
    expect(built.check((rel) => (rel === `${REGISTRY_DIR}/answer.json` ? key : undefined))).toMatchObject({ success: true, correct: REGISTRY_SHARD_COUNT });
  });
});

describe("rename-twist corpus", () => {
  const exp = buildRenameCase();

  test("is deterministic", () => {
    const again = buildRenameCase();
    expect([...again.before.entries()]).toEqual([...exp.before.entries()]);
    expect([...again.after.entries()]).toEqual([...exp.after.entries()]);
  });

  test("has 22 modules, each readable in one call and big enough to matter", () => {
    expect(exp.before.size).toBe(RENAME_FILE_COUNT);
    let tokens = 0;
    for (const [, text] of exp.before) {
      expect(text.length).toBeLessThan(READ_CAP);
      expect(text.length).toBeGreaterThan(15_000);
      tokens += Math.ceil(text.length / 4);
    }
    expect(tokens).toBeGreaterThan(80_000);
  });

  test("the expected after-tree renames the real uses and keeps every decoy", () => {
    const all = [...exp.after.values()].join("\n");
    expect(all).toContain("export async function loadRecord(id: string)");
    expect(all).toContain('import { loadRecord } from "./mod-00";');
    expect(all).toContain('import { loadRecord as fr } from "./mod-00";');
    expect(all).toContain("await fr(id)");
    expect(all).toContain("store.loadRecord(id)");
    // decoys survive: client method, plural identifier, comment, string, local shadow
    expect(all).toContain("client.fetchRecord(id)");
    expect(all).toContain("fetchRecords(");
    expect(all).toContain("// NOTE(");
    expect(all).toContain('"fetchRecord failed for "');
    expect(all).toContain("const fetchRecord = (k: string)");
    // and no real use is left behind: every remaining `fetchRecord(` is a decoy shape
    const leftovers = all.split("\n").filter((l) => /\bfetchRecord\b/.test(l));
    for (const l of leftovers) {
      expect(/client\.fetchRecord\(|^\/\/ NOTE|"fetchRecord failed|const fetchRecord = |return fetchRecord\(key\)/.test(l)).toBe(true);
    }
  });

  test("every module differs from its after-text only on lines the rename touches", () => {
    let changedFiles = 0;
    for (const [rel, before] of exp.before) {
      const after = exp.after.get(rel) as string;
      const b = before.split("\n");
      const a = after.split("\n");
      expect(a.length).toBe(b.length);
      if (before !== after) changedFiles += 1;
    }
    // Every importer family except the alias-less "none" and the namespace/alias decoy-only shapes still has real edits overall.
    expect(changedFiles).toBeGreaterThanOrEqual(15);
    // Files with no real use exist too (kind "none"), so a blanket edit has something to break.
    expect(RENAME_FILE_COUNT - changedFiles).toBeGreaterThanOrEqual(3);
  });

  test("seed files do not contain the new name outside the expected after-tree", () => {
    for (const [, text] of exp.before) expect(text).not.toContain("loadRecord");
  });

  test("the seeded files include types.ts but the oracle ignores it", () => {
    expect(exp.files.some((f) => f.path === `${RENAME_DIR}/types.ts`)).toBe(true);
    expect(exp.before.has(`${RENAME_DIR}/types.ts`)).toBe(false);
  });
});

describe("checkRenameTree", () => {
  const exp = buildRenameCase();

  test("untouched tree fails with every real edit counted as missed", () => {
    const r = checkRenameTree(exp, readerOf(exp.before));
    expect(r.success).toBe(false);
    expect(r.counters.missedEdits).toBeGreaterThan(20);
    expect(r.counters.overEdits).toBe(0);
  });

  test("the exact after-tree passes with score 1", () => {
    expect(checkRenameTree(exp, readerOf(exp.after))).toMatchObject({ success: true, score: 1, correct: RENAME_FILE_COUNT });
  });

  test("CRLF line endings and a missing/extra trailing newline do not count as a difference", () => {
    const crlf = new Map([...exp.after].map(([k, v]) => [k, `${v.replace(/\n/g, "\r\n")}\r\n\r\n`]));
    expect(checkRenameTree(exp, readerOf(crlf)).success).toBe(true);
  });

  test("a blanket replace fails: it over-edits decoys", () => {
    const blanket = new Map([...exp.before].map(([k, v]) => [k, v.replaceAll("fetchRecord", "loadRecord")]));
    const r = checkRenameTree(exp, readerOf(blanket));
    expect(r.success).toBe(false);
    expect(r.counters.overEdits).toBeGreaterThan(0);
  });

  test("a whole-word replace still fails: it cannot tell client/shadow/comment/string/alias cases apart", () => {
    const wordOnly = new Map([...exp.before].map(([k, v]) => [k, v.replace(/\bfetchRecord\b/g, "loadRecord")]));
    const r = checkRenameTree(exp, readerOf(wordOnly));
    expect(r.success).toBe(false);
    expect(r.counters.overEdits).toBeGreaterThan(0);
    expect(r.counters.missedEdits).toBe(0);
  });

  test("one missed real edit fails exactly one file and is classed as missed", () => {
    const broken = new Map(exp.after);
    const target = [...exp.before.keys()].find((k) => exp.before.get(k) !== exp.after.get(k)) as string;
    broken.set(target, exp.before.get(target) as string);
    const r = checkRenameTree(exp, readerOf(broken));
    expect(r.correct).toBe(RENAME_FILE_COUNT - 1);
    expect(r.counters.missedEdits).toBeGreaterThan(0);
    expect(r.failures[0]).toContain(target);
  });

  test("a missing module is counted, a deleted line is a structural diff", () => {
    const missing = new Map(exp.after);
    const key = [...missing.keys()][3] as string;
    missing.delete(key);
    expect(checkRenameTree(exp, readerOf(missing)).counters.missingFiles).toBe(1);
    const shortened = new Map(exp.after);
    shortened.set(key, (exp.after.get(key) as string).split("\n").slice(1).join("\n"));
    const r = checkRenameTree(exp, readerOf(shortened));
    expect(r.success).toBe(false);
    expect(r.counters.otherDiffs).toBeGreaterThan(0);
  });
});

describe("task catalog", () => {
  test("every task has distinct name, both prompts, and a volume contract above the prune window", () => {
    expect(new Set(LONG_TASKS.map((t) => t.name)).size).toBe(LONG_TASKS.length);
    for (const t of LONG_TASKS) {
      expect(t.prompt).toContain(t.description);
      expect(t.cliPromptText).toContain(t.description);
      expect(t.expectedToolOutputTokens).toBeGreaterThan(60_000);
      expect(t.build().seedFiles.length).toBeGreaterThan(t.expectedDistinctReads);
    }
  });

  test("selectLongTasks: long/all is everything, names select, unknown throws", () => {
    expect(selectLongTasks("long")).toHaveLength(LONG_TASKS.length);
    expect(selectLongTasks("rename-twist").map((t) => t.name)).toEqual(["rename-twist"]);
    expect(() => selectLongTasks("nope")).toThrow(/unknown long task/);
    expect(() => selectLongTasks(" , ")).toThrow(/selected no task/);
  });
});
