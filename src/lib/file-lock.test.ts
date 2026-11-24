import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { withFileLock, withFileLockAsync } from "./file-lock";

function scratch(): string {
  return mkdtempSync(path.join(tmpdir(), "keryx-file-lock-"));
}

/** A lock another holder took just now, which a long stale window never breaks. */
function plantFresh(lock: string): void {
  writeFileSync(lock, "another-holder");
}

/** A lock its holder abandoned a minute ago. */
function plantAbandoned(lock: string): void {
  writeFileSync(lock, "crashed-holder");
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);
}

type Lock = <T>(lockPath: string, fn: () => T, options?: Parameters<typeof withFileLock>[2]) => Promise<T | null>;

const variants: [string, Lock][] = [
  ["withFileLock", async (lockPath, fn, options) => withFileLock(lockPath, fn, options)],
  ["withFileLockAsync", (lockPath, fn, options) => withFileLockAsync(lockPath, fn, options)],
];

for (const [name, lock] of variants) {
  describe(name, () => {
    test("runs the section holding the lock file, then removes it", async () => {
      const root = scratch();
      try {
        const file = path.join(root, "nested", "x.lock");
        expect(await lock(file, () => existsSync(file))).toBe(true);
        expect(existsSync(file)).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    test("a section that throws still releases the lock", async () => {
      const root = scratch();
      try {
        const file = path.join(root, "x.lock");
        await expect(lock(file, () => { throw new Error("section failed"); })).rejects.toThrow("section failed");
        expect(existsSync(file)).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    test("a held lock is waited for until the timeout, then null; the holder's lock is left alone", async () => {
      const root = scratch();
      try {
        const file = path.join(root, "x.lock");
        plantFresh(file);
        let ran = false;
        expect(await lock(file, () => { ran = true; }, { timeoutMs: 20, staleMs: 60_000 })).toBeNull();
        expect(ran).toBe(false);
        expect(readFileSync(file, "utf8")).toBe("another-holder");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    test("an abandoned lock is broken and the section runs", async () => {
      const root = scratch();
      try {
        const file = path.join(root, "x.lock");
        plantAbandoned(file);
        expect(await lock(file, () => readFileSync(file, "utf8"), { staleMs: 1_000 })).not.toBe("crashed-holder");
        expect(existsSync(file)).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    test("createDir: false never creates the directory; a missing one throws ENOENT at once instead of timing out", async () => {
      const root = scratch();
      try {
        const gone = path.join(root, "gone");
        const file = path.join(gone, "x.lock");
        let ran = false;
        await expect(lock(file, () => { ran = true; }, { createDir: false, timeoutMs: 200 })).rejects.toMatchObject({ code: "ENOENT" });
        expect(ran).toBe(false);
        expect(existsSync(gone)).toBe(false);
        // An existing directory is used as it is.
        expect(await lock(path.join(root, "x.lock"), () => "ran", { createDir: false })).toBe("ran");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    test("a nonce that does not land drops the lock file it opened, and the next attempt takes the lock", async () => {
      const root = scratch();
      const write = fs.writeFileSync;
      let failed = 0;
      // The boundary: the first write to the open lock file (the nonce, written by descriptor) fails, as on a full disk.
      const spy = spyOn(fs, "writeFileSync").mockImplementation(((target: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
        if (typeof target === "number" && failed === 0) {
          failed++;
          throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
        }
        return (write as (...args: unknown[]) => void)(target, ...rest);
      }) as typeof fs.writeFileSync);
      try {
        const file = path.join(root, "x.lock");
        // Never stale: a lock file left behind by the failed attempt would hold the next attempt off until the timeout.
        expect(await lock(file, () => readFileSync(file, "utf8").length > 0, { timeoutMs: 2_000, staleMs: 60_000 })).toBe(true);
        expect(failed).toBe(1);
        expect(existsSync(file)).toBe(false);
      } finally {
        spy.mockRestore();
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
}

describe("withFileLockAsync", () => {
  test("waits for a held lock without blocking the event loop", async () => {
    const root = scratch();
    try {
      const file = path.join(root, "x.lock");
      plantFresh(file);
      // Never stale, a long timeout: only the holder letting go can let this section in.
      const pending = withFileLockAsync(file, () => "ran", { timeoutMs: 10_000, staleMs: 60_000 });
      // This line runs only because the wait yielded; a blocking wait would return null after the timeout first.
      rmSync(file);
      expect(await pending).toBe("ran");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("awaits an async section before releasing", async () => {
    const root = scratch();
    try {
      const file = path.join(root, "x.lock");
      const seen = await withFileLockAsync(file, async () => {
        await Promise.resolve();
        return existsSync(file);
      });
      expect(seen).toBe(true);
      expect(existsSync(file)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
