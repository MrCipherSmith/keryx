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
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
  usesOAuth,
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

// AC2 as a table on its OWN axis: does the stored token come back?
//
// Both halves of the key have to matter, and a table makes the
// asymmetry impossible to write away — a one-sided key passes half
// these rows and fails the other half, where two prose tests can
// drift until only the convenient one is left.
type KeyRow = {
  readonly label: string;
  readonly writeAs: readonly [name: string, url: string];
  readonly readAs: readonly [name: string, url: string];
  readonly outcome: "found" | "not found";
};

const KEY_TABLE: Array<{ klass: string; why: string; rows: KeyRow[] }> = [
  {
    klass: "a token is filed under the identity AND the host",
    why: "either half alone hands a live credential to somewhere it was never issued",
    rows: [
      {
        label: "the same name at a DIFFERENT url does not reuse the token",
        // Repointing a server at another host must not send it a
        // credential issued to the first, because somebody edited a
        // string in a config file.
        writeAs: ["linear", "https://mcp.linear.app/mcp"],
        readAs: ["linear", "https://evil.test/mcp"],
        outcome: "not found",
      },
      {
        label: "a DIFFERENT name at the same url does not either",
        // Two servers can share a host and hold different scopes.
        writeAs: ["a", "https://shared/mcp"],
        readAs: ["b", "https://shared/mcp"],
        outcome: "not found",
      },
      {
        label: "neither half matching is certainly not found",
        writeAs: ["a", "https://a/mcp"],
        readAs: ["b", "https://b/mcp"],
        outcome: "not found",
      },
      {
        label: "a url differing only in path is a different server",
        // `/mcp` and `/v2/mcp` at one host are routinely two
        // deployments with two token audiences.
        writeAs: ["api", "https://h/mcp"],
        readAs: ["api", "https://h/v2/mcp"],
        outcome: "not found",
      },
      {
        label: "BOUNDARY — the same name AND the same url IS found",
        writeAs: ["a", "https://shared/mcp"],
        readAs: ["a", "https://shared/mcp"],
        outcome: "found",
      },
    ],
  },
];

describe("AC2/AC15 — which key finds a token, by CLASS", () => {
  for (const { klass, why, rows } of KEY_TABLE) {
    describe(`${klass} — ${why}`, () => {
      for (const row of rows) {
        test(row.label, () => {
          const dir = store();
          writeCredential(row.writeAs[0], row.writeAs[1], { tokens: tokens() }, dir);
          const found = readCredential(row.readAs[0], row.readAs[1], dir).record !== undefined;
          expect({ label: row.label, outcome: found ? "found" : "not found" }).toEqual({
            label: row.label,
            outcome: row.outcome,
          });
        });
      }
    });
  }

  test("every class has three rows and both outcomes", () => {
    expect(classTableProblems(KEY_TABLE, (row) => row.outcome)).toEqual([]);
  });
});

// The store's own states, on the axis of what a WRITE is allowed to do
// to them. The rule being tabulated: a store that cannot be understood
// is never replaced, because replacing it logs the operator out of
// every server at once and reports success.
type StoreRow = {
  readonly label: string;
  /** Written to the store file before the attempt. Undefined = absent. */
  readonly existing: string | undefined;
  readonly outcome: "write accepted" | "write refused";
};

const STORE_TABLE: Array<{ klass: string; why: string; rows: StoreRow[] }> = [
  {
    klass: "a store that cannot be understood is refused, never reset",
    why: "unlike the disable overlay, this file holds tokens that cost a browser round trip each",
    rows: [
      { label: "truncated JSON is refused", existing: "{not json", outcome: "write refused" },
      {
        label: "a JSON array is refused — it is not the shape this file has",
        existing: "[]",
        outcome: "write refused",
      },
      {
        label: "a JSON string is refused for the same reason",
        existing: '"nope"',
        outcome: "write refused",
      },
      {
        label: "BOUNDARY — an ABSENT store is not corrupt, it is empty",
        // Refusing here would mean the first authorisation on a new
        // machine could never succeed.
        existing: undefined,
        outcome: "write accepted",
      },
      {
        label: "BOUNDARY — a well-formed store accepts the write",
        existing: '{"schemaVersion":1,"credentials":{}}',
        outcome: "write accepted",
      },
    ],
  },
];

describe("AC15 — what a write may do to each store state, by CLASS", () => {
  for (const { klass, why, rows } of STORE_TABLE) {
    describe(`${klass} — ${why}`, () => {
      for (const row of rows) {
        test(row.label, () => {
          const dir = store();
          if (row.existing !== undefined) writeFileSync(credentialsFile(dir), row.existing);
          const result = writeCredential("new", "https://n/mcp", { tokens: tokens() }, dir);
          expect({ label: row.label, outcome: result.ok ? "write accepted" : "write refused" }).toEqual({
            label: row.label,
            outcome: row.outcome,
          });
          if (row.outcome === "write refused" && row.existing !== undefined) {
            // Refused means UNTOUCHED, so a human can still repair it.
            expect(Bun.file(credentialsFile(dir)).size).toBe(Buffer.byteLength(row.existing));
          }
        });
      }
    });
  }

  test("every class has three rows and both outcomes", () => {
    expect(classTableProblems(STORE_TABLE, (row) => row.outcome)).toEqual([]);
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

  test("EXACTLY at the margin is expired — the comparison is <=, not <", () => {
    // One millisecond of ambiguity, and the mutation that removes it
    // survived: a token that expires at precisely the moment the
    // margin allows for is not worth the round trip.
    expect(isExpired(tokens({ expires_at: NOW + EXPIRY_MARGIN_MS }), NOW)).toBe(true);
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

// `usesOAuth` had no direct test at all: five mutations of its two
// guard clauses survived a sweep, including DELETING them outright.
// The axis is the question the function answers.
type OAuthRow = {
  readonly label: string;
  readonly server: Record<string, unknown>;
  readonly outcome: "OAuth" | "not OAuth";
};

const USES_OAUTH_TABLE: Array<{ klass: string; why: string; rows: OAuthRow[] }> = [
  {
    klass: "does this server authenticate with OAuth",
    why: "a wrong yes starts a browser flow nothing will use; a wrong no leaves a server unreachable with no way to fix it",
    rows: [
      {
        label: "a stdio server has nothing to authorise against",
        server: { command: "npx" },
        outcome: "not OAuth",
      },
      {
        label: "an EMPTY url is not a url",
        // `url: ""` reaches here from a config whose `${VAR}` expanded
        // to nothing.
        server: { url: "" },
        outcome: "not OAuth",
      },
      {
        label: "`oauth: false` is the operator saying the server is public",
        server: { url: "https://h/mcp", oauth: false },
        outcome: "not OAuth",
      },
      {
        label: "a bearer_token_env_var is an explicit instruction",
        server: { url: "https://h/mcp", bearer_token_env_var: "TOKEN" },
        outcome: "not OAuth",
      },
      {
        label: "so is a declared Authorization header, whatever its case",
        server: { url: "https://h/mcp", headers: { authorization: "Bearer ${T}" } },
        outcome: "not OAuth",
      },
      {
        label: "BOUNDARY — a url and nothing else is the OAuth case",
        server: { url: "https://h/mcp" },
        outcome: "OAuth",
      },
      {
        label: "BOUNDARY — a configured oauth block certainly is",
        server: { url: "https://h/mcp", oauth: { clientId: "c" } },
        outcome: "OAuth",
      },
      {
        label: "BOUNDARY — an unrelated header does not count as a credential",
        // Only `Authorization` is a credential. Refusing on any header
        // at all would exclude every server that sets an API version.
        server: { url: "https://h/mcp", headers: { "X-Api-Version": "2" } },
        outcome: "OAuth",
      },
      {
        label: "an EMPTY bearer_token_env_var is not an instruction",
        server: { url: "https://h/mcp", bearer_token_env_var: "" },
        outcome: "OAuth",
      },
    ],
  },
];

describe("AC15 — which servers use OAuth, by CLASS", () => {
  for (const { klass, why, rows } of USES_OAUTH_TABLE) {
    describe(`${klass} — ${why}`, () => {
      for (const row of rows) {
        test(row.label, () => {
          const answer = usesOAuth(row.server);
          expect({ label: row.label, outcome: answer ? "OAuth" : "not OAuth" }).toEqual({
            label: row.label,
            outcome: row.outcome,
          });
        });
      }
    });
  }

  test("every class has three rows and both outcomes", () => {
    expect(classTableProblems(USES_OAUTH_TABLE, (row) => row.outcome)).toEqual([]);
  });
});

describe("an empty configDir never resolves to the real one", () => {
  test("credentialsFile('') stays out of the user's config directory", () => {
    // `configDir ?? ensureKeryxConfigDir()` must not become `||`. With
    // `||` an empty string is falsy and silently resolves to the REAL
    // store — the exact hazard that has twice had tests read the
    // developer's own secrets.
    const real = credentialsFile();
    const empty = credentialsFile("");
    expect(empty).not.toBe(real);
    expect(path.isAbsolute(empty)).toBe(false);
  });
});

describe("clearing a credential against a store that cannot be read", () => {
  test("is REFUSED, and the file is left byte-identical", () => {
    // The guard here survived being DELETED outright. Without it,
    // clearing one server's credential rewrites a corrupt store from
    // an empty object — destroying every OTHER server's token, while
    // reporting success. `writeCredential` had this test and
    // `clearCredential` did not, which is the same defect one step to
    // the side for the fourth time in this package.
    const dir = store();
    const target = credentialsFile(dir);
    const corrupt = '{"credentials": {"keep:https://k/mcp": {"tokens": truncated…';
    writeFileSync(target, corrupt);

    const result = clearCredential("a", "https://a/mcp", dir);
    expect(result.ok).toBe(false);
    expect(readFileSync(target, "utf8")).toBe(corrupt);
  });

  test("BOUNDARY — clearing against a readable store succeeds", () => {
    const dir = store();
    writeCredential("a", "https://a/mcp", { tokens: tokens() }, dir);
    expect(clearCredential("a", "https://a/mcp", dir).ok).toBe(true);
  });
});

describe("concurrent writers do not lose each other's tokens", () => {
  test("two servers written from separate processes both survive", async () => {
    // The defect this guards, stated as the interleaving: A reads, B
    // reads, A writes {A-new, B-old}, B writes {A-old, B-new}. An
    // atomic write prevents a TORN file and does nothing about a LOST
    // update, and read-modify-write is exactly the shape that loses
    // one. Sessions dial four servers at a time, so two refreshes
    // overlapping is ordinary, not exotic.
    //
    // Real processes, because the race is between processes: two
    // promises in one process would interleave only where this code
    // awaits, and it never does.
    const dir = store();
    const script = (name: string, url: string, token: string): string =>
      `import { writeCredential } from "${path.resolve("src/mcp-servers/credentials.ts")}";` +
      `writeCredential(${JSON.stringify(name)}, ${JSON.stringify(url)},` +
      ` { tokens: { access_token: ${JSON.stringify(token)} } }, ${JSON.stringify(dir)});`;

    await Promise.all(
      Array.from({ length: 6 }, (_unused, i) =>
        Bun.spawn(["bun", "-e", script(`s${i}`, `https://h/${i}`, `tok-${i}`)], {
          stdout: "ignore",
          stderr: "ignore",
        }).exited,
      ),
    );

    // Every one of them, not just the last writer.
    for (let i = 0; i < 6; i++) {
      expect(readCredential(`s${i}`, `https://h/${i}`, dir).record?.tokens?.access_token).toBe(`tok-${i}`);
    }
  }, 30_000);

  test("and the file is still valid JSON and still 0600 afterwards", async () => {
    const dir = store();
    const script = (i: number): string =>
      `import { writeCredential } from "${path.resolve("src/mcp-servers/credentials.ts")}";` +
      `writeCredential("s${i}", "https://h/${i}", { tokens: { access_token: "t${i}" } }, ${JSON.stringify(dir)});`;
    await Promise.all(
      Array.from({ length: 4 }, (_unused, i) =>
        Bun.spawn(["bun", "-e", script(i)], { stdout: "ignore", stderr: "ignore" }).exited,
      ),
    );
    expect(() => JSON.parse(readFileSync(credentialsFile(dir), "utf8")) as unknown).not.toThrow();
    expect(statSync(credentialsFile(dir)).mode & 0o777).toBe(0o600);
  }, 30_000);
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
