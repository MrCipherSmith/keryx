import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CONFIG_UPDATE_LOCK_STALE_MS, CONFIG_UPDATE_LOCK_TIMEOUT_MS, updateConfigFile } from "./config-update";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempFile(initial?: string): string {
  const root = mkdtempSync(path.join(tmpdir(), "keryx-config-update-"));
  roots.push(root);
  const file = path.join(root, "store.json");
  if (initial !== undefined) writeFileSync(file, initial, { mode: 0o600 });
  return file;
}

const append = (entry: string) => (read: { ok: boolean; text?: string }): string => {
  const list: string[] = read.ok ? (JSON.parse(read.text!) as string[]) : [];
  return JSON.stringify([...list, entry]);
};

test("applies the mutation to the file's current content and releases the lock", () => {
  const file = tempFile(JSON.stringify(["a"]));
  expect(updateConfigFile(file, append("b"))).toBe("written");
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(["a", "b"]);
  expect(existsSync(`${file}.lock`)).toBe(false);
  expect(statSync(file).mode & 0o777).toBe(0o600);
});

test("a mutation that returns undefined leaves the file untouched", () => {
  const file = tempFile("original");
  expect(updateConfigFile(file, () => undefined)).toBe("unchanged");
  expect(readFileSync(file, "utf8")).toBe("original");
});

// The removed PR #718 lock could stall the TUI for its whole timeout on every
// contended write. A lock held by a live process (fresh, never released) must
// cost at most the short wait, and the write must still land, on the fresh file.
test("a lock another process never releases costs at most the short wait, and the update still lands", () => {
  const file = tempFile(JSON.stringify(["a"]));
  writeFileSync(`${file}.lock`, "someone-else", { mode: 0o600 });
  const started = Date.now();
  expect(updateConfigFile(file, append("b"))).toBe("written");
  const elapsed = Date.now() - started;
  expect(elapsed).toBeGreaterThanOrEqual(CONFIG_UPDATE_LOCK_TIMEOUT_MS - 50);
  expect(elapsed).toBeLessThan(CONFIG_UPDATE_LOCK_TIMEOUT_MS + 1_000);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(["a", "b"]);
  // Not ours: left for its holder (or for the stale check) to remove.
  expect(readFileSync(`${file}.lock`, "utf8")).toBe("someone-else");
});

test("a lock abandoned by a crashed holder is broken instead of waited out", () => {
  const file = tempFile(JSON.stringify(["a"]));
  writeFileSync(`${file}.lock`, "crashed", { mode: 0o600 });
  const old = (Date.now() - CONFIG_UPDATE_LOCK_STALE_MS - 5_000) / 1_000;
  utimesSync(`${file}.lock`, old, old);
  const started = Date.now();
  expect(updateConfigFile(file, append("b"))).toBe("written");
  expect(Date.now() - started).toBeLessThan(CONFIG_UPDATE_LOCK_TIMEOUT_MS);
  expect(existsSync(`${file}.lock`)).toBe(false);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(["a", "b"]);
});

test("without the lock, a write that lands between the read and the rename is re-read and kept", () => {
  const file = tempFile(JSON.stringify(["a"]));
  writeFileSync(`${file}.lock`, "someone-else", { mode: 0o600 });
  let calls = 0;
  const outcome = updateConfigFile(file, (read) => {
    calls += 1;
    // Another process renames in its own change right after our first read.
    if (calls === 1) writeFileSync(file, JSON.stringify(["a", "other"]));
    return append("b")(read);
  });
  expect(outcome).toBe("written");
  expect(calls).toBe(2);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(["a", "other", "b"]);
});

test("without the lock, a file that never stops changing is reported failed, not overwritten", () => {
  const file = tempFile(JSON.stringify(["a"]));
  writeFileSync(`${file}.lock`, "someone-else", { mode: 0o600 });
  let n = 0;
  const outcome = updateConfigFile(file, (read) => {
    n += 1;
    writeFileSync(file, JSON.stringify(["churn", n]));
    return append("b")(read);
  });
  expect(outcome).toBe("failed");
  expect(JSON.parse(readFileSync(file, "utf8"))[0]).toBe("churn");
});
