// The per-machine export and the merge: one raw file per machine, one merged dataset, no words, no seed.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { exportRef } from "./export";
import { machineExport, mergeMachineRows, parseMachineRows, renderMachineRows, type MachineRow } from "./machine-export";
import { saltFile } from "./arms";
import { journalFile } from "./store";

const hostOf = (letter: string): string => letter.repeat(8);
const hashOf = (letter: string): string => letter.repeat(8) + "0".repeat(56);

function row(letter: string, seq: number, openedAt: string, extra: Record<string, unknown> = {}): MachineRow {
  return { ref: `r${letter}${seq}`, openedAt, arm: "A", hasRecommendation: true, backfilled: false, seq, host: hostOf(letter), seedHash: hashOf(letter), ...extra };
}

describe("mergeMachineRows", () => {
  test("a (host, seq) pair seen twice across files is an error", () => {
    const a = { label: "raw/decisions-aaaaaaaa.jsonl", rows: [row("a", 1, "2026-10-02T00:00:00.000Z")] };
    const b = { label: "raw/decisions-aaaaaaaa-copy.jsonl", rows: [row("a", 1, "2026-10-03T00:00:00.000Z")] };
    expect(() => mergeMachineRows([a, b])).toThrow("duplicate (host, seq)");
  });

  test("the same seq on two machines is two different rows", () => {
    const merged = mergeMachineRows([
      { label: "a", rows: [row("a", 1, "2026-10-02T00:00:00.000Z")] },
      { label: "b", rows: [row("b", 1, "2026-10-02T00:00:00.000Z")] },
    ]);
    expect(merged.rows.map((item) => item.host)).toEqual([hostOf("a"), hostOf("b")]);
    expect(merged.perHost).toEqual([{ host: hostOf("a"), count: 1 }, { host: hostOf("b"), count: 1 }]);
  });

  test("orders by openedAt, then host, then seq; globalSeq is the last key and 1-based; seq, arm and backfilled stay", () => {
    const merged = mergeMachineRows([
      { label: "b", rows: [row("b", 1, "2026-10-04T00:00:00.000Z", { arm: "D" }), row("b", 2, "2026-10-02T00:00:00.000Z", { backfilled: true, arm: "C" })] },
      { label: "a", rows: [row("a", 7, "2026-10-03T00:00:00.000Z"), row("a", 3, "2026-10-02T00:00:00.000Z")] },
    ]);
    expect(merged.rows.map((item) => [item.host, item.seq, item.globalSeq])).toEqual([
      [hostOf("a"), 3, 1],
      [hostOf("b"), 2, 2],
      [hostOf("a"), 7, 3],
      [hostOf("b"), 1, 4],
    ]);
    for (const item of merged.rows) expect(Object.keys(item).at(-1)).toBe("globalSeq");
    const kept = merged.rows.find((item) => item.seq === 2 && item.host === hostOf("b"));
    expect(kept?.backfilled).toBe(true);
    expect(kept?.arm).toBe("C");
    expect(merged.rows.find((item) => item.seq === 1 && item.host === hostOf("b"))?.arm).toBe("D");
    expect(merged.perHost).toEqual([{ host: hostOf("a"), count: 2 }, { host: hostOf("b"), count: 2 }]);
  });

  test("no files, no rows", () => {
    expect(mergeMachineRows([])).toEqual({ rows: [], perHost: [] });
    expect(renderMachineRows([])).toBe("");
  });
});

describe("parseMachineRows", () => {
  const label = "raw/decisions-aaaaaaaa.jsonl";
  const line = (value: MachineRow): string => `${JSON.stringify(value)}\n`;

  test("a valid file round-trips through renderMachineRows", () => {
    const rows = [row("a", 1, "2026-10-02T00:00:00.000Z"), row("a", 2, "2026-10-02T01:00:00.000Z", { seqDerived: true })];
    expect(parseMachineRows(renderMachineRows(rows), label)).toEqual(rows);
  });

  test("rejects a seed, a text key (at any depth), a host that does not match its hash, and a foreign host", () => {
    const ok = row("a", 1, "2026-10-02T00:00:00.000Z");
    expect(() => parseMachineRows(line({ ...ok, seed: 7 }), label)).toThrow("seed");
    expect(() => parseMachineRows(line({ ...ok, reason: "x" }), label)).toThrow("text field");
    expect(() => parseMachineRows(line({ ...ok, ratings: [{ title: "x" }] }), label)).toThrow("text field");
    expect(() => parseMachineRows(line({ ...ok, host: "bbbbbbbb" }), label)).toThrow("host does not match seedHash");
    expect(() => parseMachineRows(line(row("b", 1, "2026-10-02T00:00:00.000Z")), label)).toThrow("file name");
    expect(() => parseMachineRows(line({ ...ok, globalSeq: 1 }), label)).toThrow("globalSeq");
  });

  test("rejects a missing or malformed seq, openedAt, seedHash and a non-JSON line", () => {
    const ok = row("a", 1, "2026-10-02T00:00:00.000Z");
    expect(() => parseMachineRows(line({ ...ok, seq: "1" }), label)).toThrow("seq");
    expect(() => parseMachineRows(line({ ...ok, seq: 1.5 }), label)).toThrow("seq");
    expect(() => parseMachineRows(line({ ...ok, openedAt: null }), label)).toThrow("openedAt");
    expect(() => parseMachineRows(line({ ...ok, seedHash: "abc" }), label)).toThrow("seedHash");
    expect(() => parseMachineRows("not json\n", label)).toThrow("not valid JSON");
  });

  test("rejects two hosts in one file and a (host, seq) repeated inside a file; the message names no path", () => {
    expect(() => parseMachineRows(line(row("a", 1, "2026-10-02T00:00:00.000Z")) + line(row("a", 1, "2026-10-03T00:00:00.000Z")), "raw/x.jsonl")).toThrow("duplicate (host, seq)");
    expect(() => parseMachineRows(line(row("a", 1, "2026-10-02T00:00:00.000Z")) + line(row("b", 2, "2026-10-03T00:00:00.000Z")), "raw/x.jsonl")).toThrow("more than one host");
    try {
      parseMachineRows("not json\n", label);
    } catch (error) {
      expect((error as Error).message).toBe(`${label}: line 1: not valid JSON`);
    }
  });
});

describe("machineExport", () => {
  let dir: string;
  let config: string;

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(path.join(tmpdir(), "keryx-machine-export-")));
    config = await realpath(await mkdtemp(path.join(tmpdir(), "keryx-machine-config-")));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(config, { recursive: true, force: true });
  });

  const open = (id: string, at: string, extra: Record<string, unknown> = {}): string =>
    JSON.stringify({
      kind: "open", id, at, flow: "1", stage: "ask_user", question: "QSECRET", options: [{ id: "x", label: "L" }, { id: "y", label: "M" }],
      recommendation: { optionId: "x", reason: "WHY" }, mode: "ordinary", order: ["x", "y"], showMark: true, irreversible: false, arm: "A", seed: 7, preselected: false, ...extra,
    });

  async function writeJournal(lines: string[]): Promise<void> {
    await mkdir(path.dirname(journalFile(dir)), { recursive: true });
    await writeFile(journalFile(dir), `${lines.join("\n")}\n`);
  }

  test("returns null and creates nothing when the machine has no seed", async () => {
    await writeJournal([open("one", "2026-10-02T00:00:00.000Z")]);
    expect(await machineExport(dir, { configDir: config })).toBeNull();
    expect(await readdir(config)).toEqual([]);
    expect(existsSync(await saltFile(dir, { configDir: config }))).toBe(false);
  });

  test("tags every row with host and seedHash, drops the seed, keeps an explicit seq and derives the rest", async () => {
    const seed = "machine-seed-value-0123456789";
    const file = await saltFile(dir, { configDir: config });
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${seed}\n`);
    const hash = createHash("sha256").update(`${seed}\n`).digest("hex");
    await writeJournal([open("one", "2026-10-02T00:00:00.000Z"), open("two", "2026-10-02T01:00:00.000Z", { seq: 2 }), open("three", "2026-10-02T02:00:00.000Z")]);

    const out = await machineExport(dir, { configDir: config });
    expect(out?.host).toBe(hash.slice(0, 8));
    expect(out?.seedHash).toBe(hash);
    expect(out?.rows.map((item) => [item.seq, item.seqDerived])).toEqual([[1, true], [2, undefined], [3, true]]);
    expect(out?.rows[0]?.ref).toBe(exportRef("one"));
    for (const item of out?.rows ?? []) {
      expect("seed" in item).toBe(false);
      expect(Object.keys(item).slice(-2)).toEqual(["host", "seedHash"]);
    }
    const body = renderMachineRows(out?.rows ?? []);
    for (const secret of ["QSECRET", "WHY", seed]) expect(body.includes(secret)).toBe(false);
    expect(parseMachineRows(body, `raw/decisions-${out?.host}.jsonl`)).toHaveLength(3);
  });

  test("a journal line that cannot be exported stops the export", async () => {
    const file = await saltFile(dir, { configDir: config });
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "machine-seed-value-0123456789\n");
    await writeJournal([open("one", "2026-10-02T00:00:00.000Z"), "{not json"]);
    await expect(machineExport(dir, { configDir: config })).rejects.toThrow("could not be exported");
  });
});
