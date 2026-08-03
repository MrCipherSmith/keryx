// The `keryx serve` bearer credential (flow 128 / roadmap R4b).
//
// Written BEFORE src/lib/serve-credential.ts exists. The first run must fail
// with "Cannot find module ./serve-credential".
//
// Two properties carry the security of this slice and are tested as such:
//
//  1. The token is knowable exactly once. Only a salted hash and an opaque id
//     are persisted, so there is nothing to print later even by mistake.
//  2. The comparison is constant-time and LENGTH-INDEPENDENT. "Constant-time"
//     is easy to write and easy to get wrong: a compare that returns early on
//     the first differing byte, or on a length mismatch, leaks the position of
//     the difference and the length of the secret.
//
// (2) is asserted STRUCTURALLY rather than by timing, because a timing
// assertion is flaky under a loaded CI runner and a flaky security test gets
// deleted. The comparison is fed index-counting proxies and must be shown to
// read every index on both sides even when byte 0 already differs. The
// assertion is mutation-checked in the flow journal by substituting `===` and
// confirming this file goes red.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { shellConfigPath } from "./shell-config";
import {
  constantTimeEqual,
  credentialFingerprint,
  issueServeToken,
  loadServeCredential,
  readServeCredential,
  revokeServeToken,
  rotateServeToken,
  serveCredentialPath,
  verifyServeToken,
} from "./serve-credential";

let configDir = "";

beforeEach(() => {
  configDir = mkdtempSync(path.join(tmpdir(), "keryx-serve-cred-"));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

/**
 * A byte view that records which indices were read.
 *
 * `constantTimeEqual` accepts `ArrayLike<number>`, so a Proxy over a PLAIN
 * array-like object satisfies it while making the access pattern observable.
 * (A Proxy wrapping a Uint8Array directly cannot be used: reading `.length`
 * through it throws "Receiver should be a typed array view".)
 */
function counting(bytes: Uint8Array): { view: ArrayLike<number>; reads: number[] } {
  const reads: number[] = [];
  const target: Record<string, number> = { length: bytes.length };
  bytes.forEach((byte, index) => {
    target[String(index)] = byte;
  });
  const view = new Proxy(target, {
    get(source, property, receiver) {
      if (typeof property === "string" && /^\d+$/.test(property)) {
        reads.push(Number(property));
      }
      return Reflect.get(source, property, receiver) as unknown;
    },
  }) as unknown as ArrayLike<number>;
  return { view, reads };
}

describe("constant-time comparison", () => {
  test("is correct", () => {
    expect(constantTimeEqual(Uint8Array.from([1, 2, 3]), Uint8Array.from([1, 2, 3]))).toBe(true);
    expect(constantTimeEqual(Uint8Array.from([1, 2, 3]), Uint8Array.from([1, 2, 4]))).toBe(false);
    expect(constantTimeEqual(Uint8Array.from([]), Uint8Array.from([]))).toBe(true);
    expect(constantTimeEqual(Uint8Array.from([0]), Uint8Array.from([]))).toBe(false);
    expect(constantTimeEqual(Uint8Array.from([1, 2]), Uint8Array.from([1, 2, 0]))).toBe(false);
  });

  test("reads every index even when the FIRST byte already differs", () => {
    // The defect this catches: `for (…) if (a[i] !== b[i]) return false`. That
    // implementation reads index 0 and stops, so the number of reads reveals
    // where the secret first diverges from the guess.
    const width = 32;
    const left = new Uint8Array(width).fill(0xaa);
    const right = new Uint8Array(width).fill(0xaa);
    right[0] = 0x00;

    const a = counting(left);
    const b = counting(right);
    expect(constantTimeEqual(a.view, b.view)).toBe(false);

    expect(a.reads.sort((x, y) => x - y)).toEqual([...Array(width).keys()]);
    expect(b.reads.sort((x, y) => x - y)).toEqual([...Array(width).keys()]);
  });

  test("reads the same indices whether the difference is first or last", () => {
    const width = 32;
    const base = new Uint8Array(width).fill(0xaa);

    const differsFirst = new Uint8Array(base);
    differsFirst[0] = 0x00;
    const differsLast = new Uint8Array(base);
    differsLast[width - 1] = 0x00;

    const first = counting(differsFirst);
    const last = counting(differsLast);
    constantTimeEqual(counting(base).view, first.view);
    constantTimeEqual(counting(base).view, last.view);

    expect(first.reads.length).toBe(last.reads.length);
    expect(first.reads.length).toBe(width);
  });

  test("does not short-circuit on a length mismatch", () => {
    // `if (a.length !== b.length) return false` is the other half of the same
    // leak: it tells an attacker the length of the stored value for free.
    const long = counting(new Uint8Array(32).fill(0xaa));
    const short = counting(new Uint8Array(1));
    expect(constantTimeEqual(long.view, short.view)).toBe(false);
    expect(long.reads.sort((x, y) => x - y)).toEqual([...Array(32).keys()]);
  });

  test("the counting harness itself observes what it claims to", () => {
    // Without this, a Proxy that silently stopped recording would make every
    // assertion above vacuously true.
    const probe = counting(Uint8Array.from([7, 8, 9]));
    expect(probe.view[0]).toBe(7);
    expect(probe.view[2]).toBe(9);
    expect(probe.reads).toEqual([0, 2]);
  });
});

describe("location", () => {
  test("the credential store sits beside auth.json in the user-global directory", () => {
    expect(path.dirname(serveCredentialPath(configDir))).toBe(path.dirname(shellConfigPath(configDir)));
    expect(path.basename(serveCredentialPath(configDir))).toBe("serve-credentials.json");
  });
});

describe("issue", () => {
  test("returns a high-entropy token and persists only a salted hash plus an opaque id", () => {
    const issued = issueServeToken(configDir);
    expect(issued.ok).toBe(true);
    if (!issued.ok) {
      return;
    }
    // 32 random bytes, base64url-encoded.
    expect(issued.token.length).toBeGreaterThanOrEqual(43);
    expect(issued.token).toMatch(/^[A-Za-z0-9_-]+$/);

    const raw = readFileSync(serveCredentialPath(configDir), "utf8");
    expect(raw).not.toContain(issued.token);
    const stored = JSON.parse(raw) as { active: Record<string, unknown> };
    expect(Object.keys(stored.active).sort()).toEqual(["algorithm", "createdAt", "hash", "id", "salt"]);
    expect(stored.active.algorithm).toBe("sha256");
    expect(stored.active.id).toBe(issued.record.id);
    // The stored hash is not the token and not a transformation an attacker can
    // reverse without the salt.
    expect(String(stored.active.hash)).toMatch(/^[0-9a-f]{64}$/);
    expect(String(stored.active.salt)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("two issues on two stores produce different tokens, salts and ids", () => {
    const second = mkdtempSync(path.join(tmpdir(), "keryx-serve-cred-b-"));
    try {
      const a = issueServeToken(configDir);
      const b = issueServeToken(second);
      expect(a.ok && b.ok).toBe(true);
      if (!a.ok || !b.ok) {
        return;
      }
      expect(a.token).not.toBe(b.token);
      expect(a.record.salt).not.toBe(b.record.salt);
      expect(a.record.id).not.toBe(b.record.id);
    } finally {
      rmSync(second, { recursive: true, force: true });
    }
  });

  test("refuses to overwrite an existing credential, so a live token is never silently invalidated", () => {
    const first = issueServeToken(configDir);
    expect(first.ok).toBe(true);
    const second = issueServeToken(configDir);
    expect(second.ok).toBe(false);
    if (second.ok) {
      return;
    }
    expect(second.reason).toBe("already-issued");
    expect(second.message).toContain("rotate");
    // And the original still verifies.
    if (first.ok) {
      expect(verifyServeToken(first.token, loadServeCredential(configDir)!)).toBe(true);
    }
  });

  test("the file is owner-only", () => {
    if (process.platform === "win32") {
      return;
    }
    issueServeToken(configDir);
    expect(statSync(serveCredentialPath(configDir)).mode & 0o777).toBe(0o600);
  });
});

describe("at-rest protection", () => {
  // A security review demonstrated the attack these close: `writeFileSync`'s
  // `mode` and `mkdirSync`'s `mode` apply at CREATION only. `saveShellConfig`
  // creates the shared user-global directory first with no mode, so under the
  // common `umask 002` it lands 0775 — group-writable. Anyone able to write that
  // directory replaces the store with a salt/hash of a token THEY chose and
  // repoints serve.json at it. No keryx code is involved and nothing notices.

  test("rotate is a real recovery from a widened store: it rewrites AND re-tightens", () => {
    // The refusal message tells the operator to inspect the store and then
    // rotate. That instruction has to work, or it is a comment describing a
    // recovery that does not exist.
    if (process.platform === "win32") {
      return;
    }
    issueServeToken(configDir);
    chmodSync(serveCredentialPath(configDir), 0o644);
    expect(readServeCredential(configDir).status).toBe("unreadable");

    const rotated = rotateServeToken(configDir);
    expect(rotated.ok).toBe(true);
    expect(statSync(serveCredentialPath(configDir)).mode & 0o777).toBe(0o600);
    expect(readServeCredential(configDir).status).toBe("ok");
    if (rotated.ok) {
      expect(verifyServeToken(rotated.token, loadServeCredential(configDir)!)).toBe(true);
    }
  });

  test("issue refuses over a widened store rather than overwriting it", () => {
    // Fail-closed: a store whose mode was changed from outside may already have
    // been replaced, and quietly issuing over it destroys the evidence.
    if (process.platform === "win32") {
      return;
    }
    issueServeToken(configDir);
    chmodSync(serveCredentialPath(configDir), 0o666);
    const second = issueServeToken(configDir);
    expect(second.ok).toBe(false);
    expect(statSync(serveCredentialPath(configDir)).mode & 0o777).toBe(0o666);
  });

  test("an already-permissive config DIRECTORY is tightened to 0700 on write", () => {
    if (process.platform === "win32") {
      return;
    }
    mkdirSync(configDir, { recursive: true });
    chmodSync(configDir, 0o775);
    expect(statSync(configDir).mode & 0o777).toBe(0o775);

    issueServeToken(configDir);
    expect(statSync(configDir).mode & 0o777).toBe(0o700);
  });

  test("a group- or other-accessible store is refused, not trusted", () => {
    // Fail-closed. If something outside keryx widened the mode, the store may
    // already have been replaced, and authenticating against it is exactly the
    // attack. The operator is told to look rather than being silently protected
    // by a chmod that happens on the next write.
    if (process.platform === "win32") {
      return;
    }
    issueServeToken(configDir);
    expect(readServeCredential(configDir).status).toBe("ok");

    for (const mode of [0o640, 0o604, 0o660, 0o606, 0o666]) {
      chmodSync(serveCredentialPath(configDir), mode);
      const result = readServeCredential(configDir);
      expect({ mode: mode.toString(8), status: result.status }).toEqual({
        mode: mode.toString(8),
        status: "unreadable",
      });
      if (result.status === "unreadable") {
        expect(result.message).toContain("permission");
      }
    }

    chmodSync(serveCredentialPath(configDir), 0o600);
    expect(readServeCredential(configDir).status).toBe("ok");
  });

  test("the store is replaced atomically, not truncated in place", () => {
    // `projects.json` beside it already writes temp+fsync+rename. A truncating
    // write leaves a readable zero-length store if the process dies mid-write,
    // which reads as "no credential" and locks the operator out.
    const issued = issueServeToken(configDir);
    if (!issued.ok) {
      throw new Error("issue failed");
    }
    const before = statSync(serveCredentialPath(configDir)).ino;
    rotateServeToken(configDir);
    const after = statSync(serveCredentialPath(configDir)).ino;
    expect(after).not.toBe(before);
    // And no temp file is left behind.
    expect(readdirSync(configDir).filter((name) => name.includes(".tmp"))).toEqual([]);
  });
});

describe("concurrency", () => {
  test("eight concurrent issues print exactly one token, and it is the one that works", async () => {
    // Real subprocesses, not `Promise.all` over a synchronous call — the flow
    // 127 lesson records a "concurrency" test that wrapped a synchronous call in
    // `Promise.resolve`, ran nothing concurrently, and passed while the
    // implementation reproducibly lost writes.
    //
    // Without the lock a security review measured six of eight processes
    // printing a token to their operator while only one of those tokens worked.
    // A token that is printed once, cannot be recovered, and does not work is
    // the worst outcome this module can produce.
    const script = path.join(configDir, "issue-once.ts");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      script,
      `import { issueServeToken } from "${path.resolve(import.meta.dir, "serve-credential.ts")}";\n` +
        `const outcome = issueServeToken(process.argv[2]);\n` +
        `if (outcome.ok) { console.log("ISSUED " + outcome.token); }\n`,
      "utf8",
    );

    const store = path.join(configDir, "store");
    mkdirSync(store, { recursive: true });
    const runs = await Promise.all(
      Array.from({ length: 8 }, () => {
        const proc = Bun.spawn(["bun", "run", script, store], { stdout: "pipe", stderr: "pipe" });
        return new Response(proc.stdout).text().then(async (text) => {
          await proc.exited;
          return text;
        });
      }),
    );

    const printed = runs
      .map((text) => /ISSUED (\S+)/.exec(text)?.[1])
      .filter((token): token is string => token !== undefined);

    expect(printed).toHaveLength(1);
    const record = loadServeCredential(store);
    expect(record).not.toBeNull();
    expect(verifyServeToken(printed[0]!, record!)).toBe(true);
  }, 60_000);
});

describe("verify", () => {
  test("accepts the issued token and rejects everything else", () => {
    const issued = issueServeToken(configDir);
    expect(issued.ok).toBe(true);
    if (!issued.ok) {
      return;
    }
    const record = loadServeCredential(configDir)!;
    expect(verifyServeToken(issued.token, record)).toBe(true);
    expect(verifyServeToken("", record)).toBe(false);
    expect(verifyServeToken(`${issued.token}x`, record)).toBe(false);
    expect(verifyServeToken(issued.token.slice(0, -1), record)).toBe(false);
    expect(verifyServeToken(issued.token.toUpperCase(), record)).toBe(false);
  });

  test("a token issued against a different salt does not verify", () => {
    // Proves the salt is actually mixed in, rather than the hash being of the
    // token alone — which would make one leaked hash reusable across installs.
    const second = mkdtempSync(path.join(tmpdir(), "keryx-serve-cred-c-"));
    try {
      const a = issueServeToken(configDir);
      const b = issueServeToken(second);
      if (!a.ok || !b.ok) {
        throw new Error("issue failed");
      }
      expect(verifyServeToken(a.token, b.record)).toBe(false);
      expect(verifyServeToken(b.token, a.record)).toBe(false);
    } finally {
      rmSync(second, { recursive: true, force: true });
    }
  });

  test("a corrupt stored hash rejects rather than throwing or accepting", () => {
    const issued = issueServeToken(configDir);
    if (!issued.ok) {
      throw new Error("issue failed");
    }
    expect(verifyServeToken(issued.token, { ...issued.record, hash: "not-hex" })).toBe(false);
    expect(verifyServeToken(issued.token, { ...issued.record, hash: "" })).toBe(false);
  });
});

describe("rotate", () => {
  test("issues a new token and invalidates the previous one in the same operation", () => {
    const first = issueServeToken(configDir);
    if (!first.ok) {
      throw new Error("issue failed");
    }
    const rotated = rotateServeToken(configDir);
    expect(rotated.ok).toBe(true);
    if (!rotated.ok) {
      return;
    }
    expect(rotated.token).not.toBe(first.token);
    expect(rotated.replacedId).toBe(first.record.id);

    const record = loadServeCredential(configDir)!;
    expect(verifyServeToken(rotated.token, record)).toBe(true);
    // The invalidation is the point: the old token must not still open the door.
    expect(verifyServeToken(first.token, record)).toBe(false);
    // Exactly one credential is active — not both.
    const stored = JSON.parse(readFileSync(serveCredentialPath(configDir), "utf8")) as {
      active: { id: string };
    };
    expect(stored.active.id).toBe(rotated.record.id);
    expect(readFileSync(serveCredentialPath(configDir), "utf8")).not.toContain(first.token);
  });

  test("rotating with nothing issued behaves as an issue", () => {
    const rotated = rotateServeToken(configDir);
    expect(rotated.ok).toBe(true);
    if (!rotated.ok) {
      return;
    }
    expect(rotated.replacedId).toBeNull();
    expect(verifyServeToken(rotated.token, loadServeCredential(configDir)!)).toBe(true);
  });
});

describe("revoke", () => {
  test("removes the credential so nothing verifies afterwards", () => {
    const issued = issueServeToken(configDir);
    if (!issued.ok) {
      throw new Error("issue failed");
    }
    expect(revokeServeToken(configDir)).toBe("revoked");
    expect(loadServeCredential(configDir)).toBeNull();
    expect(readFileSync(serveCredentialPath(configDir), "utf8")).not.toContain(issued.token);
  });

  test("revoking nothing is reported distinctly, not as success", () => {
    expect(revokeServeToken(configDir)).toBe("not-found");
  });
});

describe("load", () => {
  test("returns null when the store is absent, empty or malformed", () => {
    expect(loadServeCredential(configDir)).toBeNull();
    mkdirSync(path.dirname(serveCredentialPath(configDir)), { recursive: true });
    writeFileSync(serveCredentialPath(configDir), "{not json", "utf8");
    expect(loadServeCredential(configDir)).toBeNull();
    writeFileSync(serveCredentialPath(configDir), JSON.stringify({ active: { id: "x" } }), "utf8");
    expect(loadServeCredential(configDir)).toBeNull();
  });
});

describe("fingerprint", () => {
  test("is derived from the stored hash, is short, and is not the token", () => {
    const issued = issueServeToken(configDir);
    if (!issued.ok) {
      throw new Error("issue failed");
    }
    const fingerprint = credentialFingerprint(issued.record);
    expect(fingerprint).toMatch(/^[0-9a-f]{8}$/);
    // NOT `expect(token).not.toContain(fingerprint)`: that asserts the
    // independence of two unrelated random values and would flake at ~1e-8 while
    // proving nothing. What matters is that the fingerprint is derived from the
    // stored hash and is not a prefix of it — a truncated hash would be a
    // partial disclosure of the thing it labels.
    expect(issued.record.hash.startsWith(fingerprint)).toBe(false);
    // Stable for the same record, different for a different one.
    expect(credentialFingerprint(issued.record)).toBe(fingerprint);
    const rotated = rotateServeToken(configDir);
    if (!rotated.ok) {
      throw new Error("rotate failed");
    }
    expect(credentialFingerprint(rotated.record)).not.toBe(fingerprint);
  });
});
