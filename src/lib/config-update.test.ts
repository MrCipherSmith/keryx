import { afterAll, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
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

// review-highload-w4:F-001. The lock holder used to rename without re-checking,
// so a writer whose wait ran out (lock-free fallback) and landed in the
// holder's read-to-rename window was silently undone: a removed permissions
// pattern came back after the removal had reported "written".
test("a write that lands between the lock holder's read and rename is re-read and kept", () => {
  const file = tempFile(JSON.stringify(["a", "X"]));
  let calls = 0;
  const outcome = updateConfigFile(file, (read) => {
    calls += 1;
    // A writer that stopped waiting renames in its removal of X while we hold the lock.
    if (calls === 1) writeFileSync(file, JSON.stringify(["a"]));
    return append("Y")(read);
  });
  expect(outcome).toBe("written");
  expect(calls).toBe(2);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(["a", "Y"]);
  expect(existsSync(`${file}.lock`)).toBe(false);
});

test("a lock holder whose file never stops changing reports failed instead of overwriting", () => {
  const file = tempFile(JSON.stringify(["a"]));
  let n = 0;
  const outcome = updateConfigFile(file, (read) => {
    n += 1;
    writeFileSync(file, JSON.stringify(["churn", n]));
    return append("b")(read);
  });
  expect(outcome).toBe("failed");
  expect(JSON.parse(readFileSync(file, "utf8"))[0]).toBe("churn");
  expect(existsSync(`${file}.lock`)).toBe(false);
});

// The verifier's two-process repro: process H holds the lock and, inside its
// mutate, spawns W (a removal of X). W waits out the 750 ms lock timeout, then
// takes the lock-free path and renames before H does.
test("two processes: a removal that outwaits the lock is not undone by the holder", () => {
  const dir = path.dirname(tempFile());
  const file = path.join(dir, "permissions.json");
  writeFileSync(file, JSON.stringify({ patterns: ["X"] }), { mode: 0o600 });
  const mod = path.resolve(import.meta.dir, "config-update.ts");
  const w = path.join(dir, "w.ts");
  writeFileSync(
    w,
    `import { updateConfigFile } from ${JSON.stringify(mod)};
const out = updateConfigFile(process.argv[2]!, (cur) => {
  const obj = cur.ok ? JSON.parse(cur.text) : {};
  obj.patterns = (obj.patterns ?? []).filter((p: string) => p !== "X");
  return JSON.stringify(obj);
});
console.log(out);
`,
  );
  let spawned = false;
  const outcome = updateConfigFile(file, (cur) => {
    const obj = cur.ok ? JSON.parse(cur.text) : { patterns: [] };
    if (!spawned) {
      spawned = true;
      const r = Bun.spawnSync(["bun", w, file], { stdout: "pipe", stderr: "pipe" });
      expect(r.stdout.toString().trim()).toBe("written");
    }
    obj.patterns = [...obj.patterns, "Y"];
    return JSON.stringify(obj);
  });
  expect(outcome).toBe("written");
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ patterns: ["Y"] });
}, 15_000);

// review-degradation-w5:F-003. temp + rename over a symlink replaced the link.
test("a symlinked store is written through to its target, not replaced by a regular file", () => {
  const real = tempFile(JSON.stringify(["a"]));
  const link = path.join(path.dirname(real), "link.json");
  symlinkSync(real, link);
  expect(updateConfigFile(link, append("b"))).toBe("written");
  expect(lstatSync(link).isSymbolicLink()).toBe(true);
  expect(JSON.parse(readFileSync(real, "utf8"))).toEqual(["a", "b"]);
});

test("a dangling symlink is created at its target", () => {
  const root = path.dirname(tempFile());
  const target = path.join(root, "target.json");
  const link = path.join(root, "dangling.json");
  symlinkSync(target, link);
  expect(updateConfigFile(link, append("a"))).toBe("written");
  expect(lstatSync(link).isSymbolicLink()).toBe(true);
  expect(JSON.parse(readFileSync(target, "utf8"))).toEqual(["a"]);
});
