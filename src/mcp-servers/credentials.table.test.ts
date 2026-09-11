// The OAuth credential store, as a TABLE — AC1, AC2, AC15.
//
// Three classes, and each is a property whose absence has a name:
// the bits on disk, the key a token is filed under, and what a
// renderer is allowed to see.
//
// The mode assertion reads the FILESYSTEM rather than trusting that
// the right helper was called. "We used `writeOwnerOnlyFile`" and "the
// file is 0600" are two different facts, and only the second one is
// what protects the token from the machine's other users.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { classTableProblems } from "./class-table";
import {
  clearCredential,
  credentialKey,
  credentialsFile,
  describeCredential,
  EXPIRY_MARGIN_MS,
  isExpired,
  readCredential,
  writeCredential,
  type StoredTokens,
} from "./credentials";

function store(): string {
  return mkdtempSync(path.join(tmpdir(), "keryx-cred-"));
}

const NOW = 1_700_000_000_000;
const TOKEN = "sk-oauth-access-must-never-print";
const REFRESH = "sk-oauth-refresh-must-never-print";

function tokens(over: Partial<StoredTokens> = {}): StoredTokens {
  return { access_token: TOKEN, refresh_token: REFRESH, token_type: "Bearer", ...over };
}

type Row = {
  readonly label: string;
  readonly tokens: StoredTokens | undefined;
  /** What `describeCredential` must say. */
  readonly says: string;
  /** The axis for this class. */
  readonly outcome: string;
};

const DESCRIBE_TABLE: Array<{ klass: string; why: string; rows: Row[] }> = [
  {
    klass: "a renderer learns whether to re-authenticate, and nothing else",
    why: "0.2.91 shipped a `keryx mcp list` that printed a password; every surface here is one that would print a token if handed one",
    rows: [
      {
        label: "no credential at all",
        tokens: undefined,
        says: "no stored credential",
        outcome: "absent",
      },
      {
        label: "a valid credential says how long it has",
        tokens: tokens({ expires_at: NOW + 10 * 60_000 }),
        says: "valid for about 10 more minute(s)",
        outcome: "present",
      },
      {
        label: "an expired one with a refresh token says it will be refreshed",
        tokens: tokens({ expires_at: NOW - 60_000 }),
        says: "will be refreshed",
        outcome: "present",
      },
      {
        label: "an expired one WITHOUT a refresh token says re-authenticate",
        // Different instruction, because the operator has to do
        // something in one case and nothing in the other.
        tokens: { access_token: TOKEN, expires_at: NOW - 60_000 },
        says: "re-authenticate",
        outcome: "present",
      },
      {
        label: "BOUNDARY — no stated expiry is not the same as expired",
        // A server that gives no `expires_in` is saying the token does
        // not expire. Reporting it as expired would refresh forever.
        tokens: tokens(),
        says: "no stated expiry",
        outcome: "present",
      },
    ],
  },
];

describe("what a surface may show, by CLASS", () => {
  for (const { klass, why, rows } of DESCRIBE_TABLE) {
    describe(`${klass} — ${why}`, () => {
      for (const row of rows) {
        test(row.label, () => {
          const shown = describeCredential(row.tokens === undefined ? undefined : { tokens: row.tokens }, NOW);
          expect({ label: row.label, shown }).toEqual({ label: row.label, shown: expect.stringContaining(row.says) as never });
          // The property the whole class exists for, on every row.
          expect(shown).not.toContain(TOKEN);
          expect(shown).not.toContain(REFRESH);
        });
      }
    });
  }

  test("every class has three rows and a BOUNDARY", () => {
    expect(classTableProblems(DESCRIBE_TABLE, (row) => row.outcome)).toEqual([]);
  });
});

describe("AC1 — the bits on disk, not the name of the helper", () => {
  test("the file is owner-only after a write", () => {
    const dir = store();
    writeCredential("linear", "https://mcp.linear.app/mcp", { tokens: tokens() }, dir);
    const mode = statSync(credentialsFile(dir)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("and still owner-only after a SECOND write, which is the read-modify-write path", () => {
    // An atomic write that replaces the file can lose the mode if the
    // temp file was created with the default umask. Two writes is the
    // case where that shows.
    const dir = store();
    writeCredential("a", "https://a/mcp", { tokens: tokens() }, dir);
    writeCredential("b", "https://b/mcp", { tokens: tokens() }, dir);
    expect(statSync(credentialsFile(dir)).mode & 0o777).toBe(0o600);
  });

  test("a token round-trips through the store", () => {
    const dir = store();
    writeCredential("linear", "https://x/mcp", { tokens: tokens() }, dir);
    expect(readCredential("linear", "https://x/mcp", dir).record?.tokens?.access_token).toBe(TOKEN);
  });
});

describe("AC2 — a token belongs to an identity AT A HOST", () => {
  test("the same name at a different url does not reuse the token", () => {
    // Repointing a server at another host must not send it a
    // credential issued to the first one, because somebody edited a
    // string in a config file.
    const dir = store();
    writeCredential("linear", "https://mcp.linear.app/mcp", { tokens: tokens() }, dir);
    expect(readCredential("linear", "https://evil.test/mcp", dir).record).toBeUndefined();
  });

  test("and a different name at the same url does not either", () => {
    // Two servers can share a host and hold different scopes.
    const dir = store();
    writeCredential("a", "https://shared/mcp", { tokens: tokens() }, dir);
    expect(readCredential("b", "https://shared/mcp", dir).record).toBeUndefined();
  });

  test("BOUNDARY — the same name AND url does", () => {
    const dir = store();
    writeCredential("a", "https://shared/mcp", { tokens: tokens() }, dir);
    expect(readCredential("a", "https://shared/mcp", dir).record?.tokens?.access_token).toBe(TOKEN);
  });

  test("the key names both halves", () => {
    expect(credentialKey("a", "https://h/mcp")).toBe("a:https://h/mcp");
  });
});

describe("a corrupt store is refused, never reset", () => {
  test("a write against unreadable JSON changes nothing and says so", () => {
    // Unlike the disable overlay, which holds only toggles and is
    // rebuilt in one command, this file holds tokens that cost a
    // browser round trip each. Resetting it would log the operator out
    // of every server at once and report success.
    const dir = store();
    writeCredential("keep", "https://k/mcp", { tokens: tokens() }, dir);
    const before = credentialsFile(dir);
    writeFileSync(before, "{not json");

    const result = writeCredential("new", "https://n/mcp", { tokens: tokens() }, dir);
    expect(result.ok).toBe(false);
    // The file is untouched, so a human can still repair it.
    expect(readCredential("new", "https://n/mcp", dir).problem).toContain("not valid JSON");
  });

  test("BOUNDARY — a readable store accepts the write", () => {
    const dir = store();
    expect(writeCredential("new", "https://n/mcp", { tokens: tokens() }, dir).ok).toBe(true);
  });

  test("an absent store is not a problem, it is an empty one", () => {
    const dir = store();
    const read = readCredential("nothing", "https://n/mcp", dir);
    expect(read.record).toBeUndefined();
    expect(read.problem).toBeUndefined();
  });
});

describe("expiry", () => {
  test("a token expiring inside the margin is already expired", () => {
    // The margin is not decoration: a token that expires during the
    // request is indistinguishable, to the operator, from a server
    // that rejected them.
    expect(isExpired(tokens({ expires_at: NOW + EXPIRY_MARGIN_MS - 1 }), NOW)).toBe(true);
  });

  test("BOUNDARY — and one expiring just outside it is not", () => {
    expect(isExpired(tokens({ expires_at: NOW + EXPIRY_MARGIN_MS + 1_000 }), NOW)).toBe(false);
  });

  test("no stated expiry is not expired", () => {
    expect(isExpired(tokens(), NOW)).toBe(false);
  });

  test("and no token at all is", () => {
    expect(isExpired(undefined, NOW)).toBe(true);
  });
});

describe("clearing", () => {
  test("removes one server and leaves the others", () => {
    const dir = store();
    writeCredential("a", "https://a/mcp", { tokens: tokens() }, dir);
    writeCredential("b", "https://b/mcp", { tokens: tokens() }, dir);
    clearCredential("a", "https://a/mcp", dir);
    expect(readCredential("a", "https://a/mcp", dir).record).toBeUndefined();
    expect(readCredential("b", "https://b/mcp", dir).record?.tokens?.access_token).toBe(TOKEN);
  });

  test("and leaves the file owner-only", () => {
    const dir = store();
    writeCredential("a", "https://a/mcp", { tokens: tokens() }, dir);
    clearCredential("a", "https://a/mcp", dir);
    expect(statSync(credentialsFile(dir)).mode & 0o777).toBe(0o600);
  });
});
