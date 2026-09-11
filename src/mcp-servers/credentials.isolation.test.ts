// AC14 — authenticating writes ONE file, and AC3's last surface.
//
// The claim is not "we intended to write one file". It is that every
// other file in the config directory is byte-identical afterwards,
// asserted by hashing the whole tree before and after. An OAuth flow
// that helpfully rewrote `mcp-servers.json` would reformat a file the
// operator hand-edited, drop the comments `parseJsonTolerant` accepts,
// and reorder their servers — none of which they asked for, and all
// of which a "did it work" test passes straight through.

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { clearCredential, credentialsFile, writeCredential } from "./credentials";
import { createOAuthProvider } from "./oauth-provider";

const URL_ = "https://mcp.linear.app/mcp";

/** Every file under `dir`, relative path → sha256 of its exact bytes. */
function fingerprint(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      out[path.relative(dir, full)] = createHash("sha256").update(readFileSync(full)).digest("hex");
    }
  };
  walk(dir);
  return out;
}

/** A config directory with the files a real one has, none of them ours. */
function populated(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "keryx-isolation-"));
  writeFileSync(
    path.join(dir, "mcp-servers.json"),
    // Comments and hand-chosen ordering: the things a rewrite destroys.
    '{\n  // the one I actually use\n  "schemaVersion": 1,\n  "servers": { "linear": { "url": "https://mcp.linear.app/mcp" } }\n}\n',
  );
  writeFileSync(path.join(dir, "mcp-disabled.json"), '{"disabled":["noisy"]}\n');
  writeFileSync(path.join(dir, "mcp-trust.json"), '{"approved":{}}\n');
  writeFileSync(path.join(dir, "search-credentials.json"), '{"tavily":"other-secret"}\n');
  mkdirSync(path.join(dir, "nested"), { recursive: true });
  writeFileSync(path.join(dir, "nested", "keep.json"), "{}\n");
  return dir;
}

function withoutCredentials(fp: Record<string, string>): Record<string, string> {
  const { "mcp-credentials.json": _ours, ...rest } = fp;
  return rest;
}

describe("AC14 — the credential store is the only file written", () => {
  test("writing a token leaves every other file byte-identical", () => {
    const dir = populated();
    const before = fingerprint(dir);
    writeCredential("linear", URL_, { tokens: { access_token: "t" } }, dir);
    expect(withoutCredentials(fingerprint(dir))).toEqual(withoutCredentials(before));
  });

  test("and mcp-servers.json in particular keeps its comments and ordering", () => {
    // The assertion the hash makes abstract, spelled out: this file is
    // hand-edited, and a rewrite is data loss that reports success.
    const dir = populated();
    const original = readFileSync(path.join(dir, "mcp-servers.json"), "utf8");
    writeCredential("linear", URL_, { tokens: { access_token: "t" } }, dir);
    expect(readFileSync(path.join(dir, "mcp-servers.json"), "utf8")).toBe(original);
  });

  test("a whole provider round trip — register, verifier, tokens — still writes one file", () => {
    const dir = populated();
    const before = fingerprint(dir);
    const provider = createOAuthProvider({
      serverName: "linear",
      serverUrl: URL_,
      configDir: dir,
      // Interactive: registration is part of the `keryx mcp auth`
      // path, and a session provider now refuses it outright.
      interactive: true,
    });
    provider.saveClientInformation({ client_id: "registered" });
    provider.saveCodeVerifier("verifier");
    provider.saveTokens({ access_token: "t", refresh_token: "r", expires_in: 3600 });
    expect(withoutCredentials(fingerprint(dir))).toEqual(withoutCredentials(before));
  });

  test("and clearing one does too", () => {
    const dir = populated();
    writeCredential("linear", URL_, { tokens: { access_token: "t" } }, dir);
    const before = fingerprint(dir);
    clearCredential("linear", URL_, dir);
    expect(withoutCredentials(fingerprint(dir))).toEqual(withoutCredentials(before));
  });

  test("BOUNDARY — the credential file itself DID change", () => {
    // Without this the four tests above pass for a `writeCredential`
    // that writes nothing at all.
    const dir = populated();
    expect(fingerprint(dir)["mcp-credentials.json"]).toBeUndefined();
    writeCredential("linear", URL_, { tokens: { access_token: "t" } }, dir);
    expect(fingerprint(dir)["mcp-credentials.json"]).toBeDefined();
  });

  test("the file it writes is the one named in the specification", () => {
    const dir = populated();
    writeCredential("linear", URL_, { tokens: { access_token: "t" } }, dir);
    expect(credentialsFile(dir)).toBe(path.join(dir, "mcp-credentials.json"));
    expect(readdirSync(dir).filter((n) => n.endsWith(".json")).sort()).toEqual([
      "mcp-credentials.json",
      "mcp-disabled.json",
      "mcp-servers.json",
      "mcp-trust.json",
      "search-credentials.json",
    ]);
  });

  test("no stray temp file survives the atomic write", () => {
    // An atomic write that leaves `mcp-credentials.json.tmp-1234`
    // behind has left the token in a second file nobody will think to
    // check the mode of.
    const dir = populated();
    writeCredential("linear", URL_, { tokens: { access_token: "t" } }, dir);
    expect(readdirSync(dir).filter((name) => name.includes("tmp"))).toEqual([]);
  });
});

describe("the bits on disk are 0600, asserted rather than assumed", () => {
  test("owner read/write and nothing else", () => {
    // "We called the right helper" is a different fact from "the file
    // is unreadable by the machine's other users", and only the second
    // one is the property.
    const dir = populated();
    writeCredential("linear", URL_, { tokens: { access_token: "t" } }, dir);
    expect(statSync(credentialsFile(dir)).mode & 0o777).toBe(0o600);
  });

  test("and a rewrite does not widen it", () => {
    // The second write goes through a different path — read, merge,
    // replace — and it is the one that historically loses the mode.
    const dir = populated();
    writeCredential("linear", URL_, { tokens: { access_token: "a" } }, dir);
    writeCredential("linear", URL_, { tokens: { access_token: "b" } }, dir);
    expect(statSync(credentialsFile(dir)).mode & 0o777).toBe(0o600);
  });

  test("nor does clearing", () => {
    const dir = populated();
    writeCredential("linear", URL_, { tokens: { access_token: "a" } }, dir);
    clearCredential("linear", URL_, dir);
    expect(statSync(credentialsFile(dir)).mode & 0o777).toBe(0o600);
  });
});
