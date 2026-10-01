// The local shell token: a second secret, in the user-global dir, mode 600,
// created by serve, only read by shells, compared in constant time.

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { readConfigFile } from "../lib/config-dir";
import { fileMode, makeRemoteDir } from "./remote.test-helpers";
import { createShellTokenVerifier, ensureShellToken, readShellToken, shellTokenPath } from "./shell-token";

const dirs: string[] = [];
function freshDir(): string {
  const dir = makeRemoteDir();
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("ensureShellToken (serve side)", () => {
  test("creates the file owner-only and returns a long random token", () => {
    const dir = freshDir();
    const made = ensureShellToken(dir);
    expect(made.ok).toBe(true);
    expect(fileMode(shellTokenPath(dir))).toBe(0o600);
    expect(made.ok && made.value.length).toBeGreaterThanOrEqual(32);
  });

  test("keeps what is there: a restart does not invalidate shells that already hold the token", () => {
    const dir = freshDir();
    const first = ensureShellToken(dir);
    const second = ensureShellToken(dir);
    expect(first.ok && second.ok && first.value === second.value).toBe(true);
  });

  test("deleting the file is the rotation", () => {
    const dir = freshDir();
    const first = ensureShellToken(dir);
    rmSync(shellTokenPath(dir));
    const second = ensureShellToken(dir);
    expect(first.ok && second.ok && first.value !== second.value).toBe(true);
  });

  test("is not the serve bearer and not stored beside it", () => {
    const dir = freshDir();
    ensureShellToken(dir);
    expect(shellTokenPath(dir)).not.toBe(dir);
    expect(shellTokenPath(dir)).toContain("remote");
  });
});

describe("readShellToken (shell side)", () => {
  test("never creates: with no serve there is no token, and the reason says what to do", () => {
    const dir = freshDir();
    const read = readShellToken(dir);
    expect(read.ok).toBe(false);
    expect(read.ok === false && read.reason).toContain("keryx serve");
    expect(existsSync(shellTokenPath(dir))).toBe(false);
  });

  test("reads what serve wrote", () => {
    const dir = freshDir();
    const made = ensureShellToken(dir);
    const read = readShellToken(dir);
    expect(read.ok && made.ok && read.value === made.value).toBe(true);
  });

  test("refuses a file readable by group or others, without echoing the token", () => {
    const dir = freshDir();
    const made = ensureShellToken(dir);
    chmodSync(shellTokenPath(dir), 0o644);
    const read = readShellToken(dir);
    expect(read.ok).toBe(false);
    expect(read.ok === false && read.reason).toContain("chmod 600");
    expect(read.ok === false && made.ok && read.reason.includes(made.value)).toBe(false);
  });

  test("refuses a file that does not hold a token, without echoing it", () => {
    const dir = freshDir();
    ensureShellToken(dir);
    writeFileSync(shellTokenPath(dir), "secret value with spaces!\n", { mode: 0o600 });
    const read = readShellToken(dir);
    expect(read.ok).toBe(false);
    expect(read.ok === false && read.reason).not.toContain("secret value");
    // And the file is not the one serve would trust: ensure refuses it as well.
    expect(ensureShellToken(dir).ok).toBe(false);
    expect(readConfigFile(shellTokenPath(dir)).ok).toBe(true);
  });
});

describe("createShellTokenVerifier", () => {
  const token = "A".repeat(43);
  const verify = createShellTokenVerifier(token);

  test("accepts the token and nothing else", () => {
    expect(verify(token)).toBe(true);
    for (const wrong of ["", " ", token.slice(0, -1), `${token}x`, "B".repeat(43), token.toLowerCase(), `Bearer ${token}`, "\u0000"]) {
      expect({ wrong, ok: verify(wrong) }).toEqual({ wrong, ok: false });
    }
  });

  test("does not throw on a huge or odd input", () => {
    expect(verify("x".repeat(1_000_000))).toBe(false);
    expect(verify("\ud800")).toBe(false);
  });
});
