// Header resolution, as a TABLE — one row per case, organised by CLASS.
//
// AC10, and it is frozen as a criterion rather than left to judgement
// because of what P0 cost. Four rounds of review there each found the
// previous fix correct at the site it was given and wrong one step to the
// side, and the verifier's diagnosis was that the acceptance criterion in
// use — "does the reported reproduction now pass" — cannot converge.
//
// So the unit here is the class, and every class carries members nobody
// reported plus its BOUNDARY: the neighbouring case that must come out the
// other way. Two meta-assertions enforce that shape, because a class with
// only positive rows is a class whose rule could be `() => true`.
//
// This file is written BEFORE the first review of P1, which is the whole
// point of learning the lesson.

import { describe, expect, test } from "bun:test";
import {
  describeHollow,
  displayUrl,
  referencedVariable,
  resolveHttpHeaders,
  urlProblem,
  userinfoProblem,
} from "./http-headers";
import { expandVars, type McpServerEntry } from "./config";
import { classTableProblems } from "./class-table";

type Case = {
  readonly label: string;
  readonly raw: McpServerEntry;
  readonly env: Record<string, string | undefined>;
  /** Headers expected on the wire, or `false` if the dial must be refused. */
  readonly expect: Record<string, string> | false;
  /** When refused, a fragment the message must contain. */
  readonly says?: string;
};

/**
 * Apply `${VAR}` the way `config.ts` does — by CALLING what config.ts calls.
 *
 * This was a hand-copied regex, and a hand-copied regex is a second
 * implementation of the rule that the table then tests instead of the
 * first. If production's expansion changed, every row here would go on
 * passing against the copy.
 */
function expand(raw: McpServerEntry, env: Record<string, string | undefined>): McpServerEntry {
  const sub = (v: string): string => expandVars(v, env);
  return {
    ...raw,
    ...(raw.headers === undefined
      ? {}
      : { headers: Object.fromEntries(Object.entries(raw.headers).map(([k, v]) => [k, sub(v)])) }),
  };
}

const TABLE: Array<{ klass: string; why: string; cases: Case[] }> = [
  {
    klass: "a resolved credential reaches the wire",
    why: "the happy path, and the boundary for every refusal below",
    cases: [
      {
        label: "an expanded bearer",
        raw: { url: "https://x", headers: { Authorization: "Bearer ${TOKEN}" } },
        env: { TOKEN: "sk-live" },
        expect: { Authorization: "Bearer sk-live" },
      },
      {
        label: "a literal header needing no expansion",
        raw: { url: "https://x", headers: { "X-Api-Key": "static" } },
        env: {},
        expect: { "X-Api-Key": "static" },
      },
      {
        label: "several headers at once",
        raw: { url: "https://x", headers: { A: "1", B: "${B}" } },
        env: { B: "2" },
        expect: { A: "1", B: "2" },
      },
      {
        label: "bearer_token_env_var builds the header",
        raw: { url: "https://x", bearer_token_env_var: "LINEAR_TOKEN" },
        env: { LINEAR_TOKEN: "lin_abc" },
        expect: { Authorization: "Bearer lin_abc" },
      },
      {
        label: "no credential at all is fine — a public server",
        raw: { url: "https://x" },
        env: {},
        expect: {},
      },
      {
        label: "a ${VAR:-default} that falls back",
        raw: { url: "https://x", headers: { "X-Env": "${MISSING:-staging}" } },
        env: {},
        expect: { "X-Env": "staging" },
      },
      {
        label: "BOUNDARY — a value that resolves to NOTHING does not reach the wire",
        // The boundary this class was missing: the class is "a RESOLVED
        // credential reaches the wire", so its edge is a value expansion
        // completed on and that is worthless anyway. `${MISSING:-}` is a
        // fallback the operator wrote empty — an empty default is no
        // default, so it is reported as the variable being unset rather
        // than as a value that was supplied.
        raw: { url: "https://x", headers: { "X-Env": "${MISSING:-}" } },
        env: {},
        expect: false,
        says: "MISSING",
      },
      {
        label: "BOUNDARY — nor does one that resolves to whitespace",
        raw: { url: "https://x", headers: { Authorization: "Bearer ${TOKEN}" } },
        env: { TOKEN: "   " },
        expect: false,
        says: "TOKEN",
      },
    ],
  },
  {
    klass: "a HOLLOW credential is refused before the socket",
    why: "AC19. `Bearer ` is worse than no header: it produces a 401 from someone else's server, or on a server that reads it as anonymous, the wrong identity",
    cases: [
      {
        label: "the variable is unset",
        raw: { url: "https://x", headers: { Authorization: "Bearer ${TOKEN}" } },
        env: {},
        expect: false,
        says: "TOKEN",
      },
      {
        label: "the variable is set to empty",
        raw: { url: "https://x", headers: { Authorization: "Bearer ${TOKEN}" } },
        env: { TOKEN: "" },
        expect: false,
        says: "TOKEN",
      },
      {
        label: "bearer_token_env_var names an unset variable",
        raw: { url: "https://x", bearer_token_env_var: "LINEAR_TOKEN" },
        env: {},
        expect: false,
        says: "LINEAR_TOKEN",
      },
      {
        label: "bearer_token_env_var names an empty variable",
        raw: { url: "https://x", bearer_token_env_var: "LINEAR_TOKEN" },
        env: { LINEAR_TOKEN: "" },
        expect: false,
        says: "LINEAR_TOKEN",
      },
      {
        label: "a NON-auth header that came out empty is refused too",
        // Not obviously a credential, and refused anyway: an empty
        // `X-Tenant` selects the wrong tenant as surely as an empty bearer
        // selects the wrong identity.
        raw: { url: "https://x", headers: { "X-Tenant": "${TENANT}" } },
        env: {},
        expect: false,
        says: "TENANT",
      },
      {
        label: "a header the operator literally wrote empty",
        // Different message: there is no variable to name.
        raw: { url: "https://x", headers: { Authorization: "" } },
        env: {},
        expect: false,
        says: "is empty",
      },
      {
        label: "BOUNDARY — one good header does not rescue a hollow sibling",
        raw: { url: "https://x", headers: { Good: "yes", Authorization: "Bearer ${TOKEN}" } },
        env: {},
        expect: false,
        says: "TOKEN",
      },
      {
        label: "BOUNDARY — the same config with the variable set connects",
        raw: { url: "https://x", headers: { Good: "yes", Authorization: "Bearer ${TOKEN}" } },
        env: { TOKEN: "t" },
        expect: { Good: "yes", Authorization: "Bearer t" },
      },
    ],
  },
  {
    klass: "precedence between the two ways to say Authorization",
    why: "writing both is a config nobody should have written; the explicit one is the more specific intent",
    cases: [
      {
        label: "an explicit header wins over bearer_token_env_var",
        raw: {
          url: "https://x",
          headers: { Authorization: "Bearer explicit" },
          bearer_token_env_var: "TOKEN",
        },
        env: { TOKEN: "from-env" },
        expect: { Authorization: "Bearer explicit" },
      },
      {
        label: "case-insensitively — HTTP header names are not case-sensitive",
        raw: { url: "https://x", headers: { authorization: "Bearer lower" }, bearer_token_env_var: "TOKEN" },
        env: { TOKEN: "from-env" },
        expect: { authorization: "Bearer lower" },
      },
      {
        label: "BOUNDARY — with no explicit header, the env var is used",
        raw: { url: "https://x", headers: { "X-Other": "y" }, bearer_token_env_var: "TOKEN" },
        env: { TOKEN: "from-env" },
        expect: { "X-Other": "y", Authorization: "Bearer from-env" },
      },
      {
        label: "an explicit header that is HOLLOW still refuses, rather than falling back",
        // Falling back to the env var here would silently use a different
        // credential than the one the config names.
        raw: { url: "https://x", headers: { Authorization: "Bearer ${A}" }, bearer_token_env_var: "TOKEN" },
        env: { TOKEN: "from-env" },
        expect: false,
        says: "A",
      },
    ],
  },
  {
    klass: "an absent bearer_token_env_var is not an error",
    why: "most servers are public, and a missing optional field must not read as a missing credential",
    cases: [
      { label: "undefined", raw: { url: "https://x" }, env: {}, expect: {} },
      {
        label: "empty string — treated as absent, not as a variable named ''",
        raw: { url: "https://x", bearer_token_env_var: "" },
        env: {},
        expect: {},
      },
      {
        label: "BOUNDARY — a real name with a real value is used",
        raw: { url: "https://x", bearer_token_env_var: "T" },
        env: { T: "v" },
        expect: { Authorization: "Bearer v" },
      },
      {
        label: "BOUNDARY — but a real name with NO value is an error",
        // The edge this class was missing. "Absent is fine" and "present
        // but unset is fine" are one character apart in the code and
        // opposite in consequence: the first is a public server, the second
        // is a credential the operator believes they configured.
        raw: { url: "https://x", bearer_token_env_var: "T" },
        env: {},
        expect: false,
        says: "T",
      },
    ],
  },
  {
    klass: "a header that cannot legally be SENT",
    why: "a value keryx accepts and fetch then rejects is a crash at dial time with no diagnosis; and a name differing only in case is two headers the operator thinks are one",
    cases: [
      {
        label: "a newline in the value — header injection, refused",
        raw: { url: "https://x", headers: { "X-Note": "a\r\nX-Admin: true" } },
        env: {},
        expect: false,
        says: "control character",
      },
      {
        label: "a control character arriving THROUGH a variable is caught too",
        // The check has to run after expansion, or the config looks clean
        // and the environment supplies the injection.
        raw: { url: "https://x", headers: { "X-Note": "${EVIL}" } },
        env: { EVIL: "a\nX-Admin: true" },
        expect: false,
        says: "EVIL",
      },
      {
        label: "a name with a space in it is not a header name",
        raw: { url: "https://x", headers: { "X Api Key": "v" } },
        env: {},
        expect: false,
        says: "not a valid HTTP header name",
      },
      {
        label: "the same name twice in different case",
        raw: { url: "https://x", headers: { "X-Api-Key": "a", "x-api-key": "b" } },
        env: {},
        expect: false,
        says: "more than once",
      },
      {
        label: "BOUNDARY — the punctuation RFC 9110 actually allows is legal",
        // `!#$%&'*+-.^_`|~` are all token characters. Rejecting them would
        // be the over-correction, and this row is what stops it.
        raw: { url: "https://x", headers: { "X-Weird_Name.1": "v", "X.Y-Z": "w" } },
        env: {},
        expect: { "X-Weird_Name.1": "v", "X.Y-Z": "w" },
      },
      {
        label: "BOUNDARY — two DIFFERENT names are not a duplicate",
        raw: { url: "https://x", headers: { "X-Api-Key": "a", "X-Api-Secret": "b" } },
        env: {},
        expect: { "X-Api-Key": "a", "X-Api-Secret": "b" },
      },
    ],
  },
  {
    klass: "more than one thing wrong at once",
    why: "reporting the first problem and stopping makes the operator fix, re-run, fix, re-run; and a value naming two variables is not the single-variable case twice",
    cases: [
      {
        label: "two hollow headers name BOTH variables, not just the first",
        raw: { url: "https://x", headers: { Authorization: "Bearer ${A}", "X-Tenant": "${B}" } },
        env: {},
        expect: false,
        says: "B",
      },
      {
        label: "a value naming two variables, one unset, names the unset one",
        raw: { url: "https://x", headers: { "X-Id": "${TEAM}-${USER}" } },
        env: { TEAM: "acme" },
        expect: false,
        says: "USER",
      },
      {
        label: "a value naming two variables, BOTH unset, names both",
        raw: { url: "https://x", headers: { "X-Id": "${TEAM}-${USER}" } },
        env: {},
        expect: false,
        says: "TEAM",
      },
      {
        label: "BOUNDARY — with both set the composed value goes out whole",
        raw: { url: "https://x", headers: { "X-Id": "${TEAM}-${USER}" } },
        env: { TEAM: "acme", USER: "alice" },
        expect: { "X-Id": "acme-alice" },
      },
      {
        label: "BOUNDARY — a value that merely LOOKS composed is left alone",
        raw: { url: "https://x", headers: { "X-Id": "acme-$USER-{literal}" } },
        env: {},
        expect: { "X-Id": "acme-$USER-{literal}" },
      },
    ],
  },
];

describe("HTTP header resolution, by CLASS", () => {
  for (const { klass, why, cases } of TABLE) {
    describe(`${klass} — ${why}`, () => {
      for (const c of cases) {
        test(c.label, () => {
          const result = resolveHttpHeaders(expand(c.raw, c.env), c.raw, c.env);
          if (c.expect === false) {
            expect({ label: c.label, ok: result.ok }).toEqual({ label: c.label, ok: false });
            if (result.ok === false && c.says !== undefined) {
              expect(describeHollow(result.hollow)).toContain(c.says);
            }
            return;
          }
          expect({ label: c.label, ok: result.ok }).toEqual({ label: c.label, ok: true });
          if (result.ok) expect(result.headers).toEqual(c.expect);
        });
      }
    });
  }

  test("every class has three rows and a BOUNDARY", () => {
    // Both halves of this were hand-written here and both were wrong. The
    // boundary check read `refused > 0 || allowed > 0` — true of any class
    // with one row, so the meta-assertion the whole design rests on
    // asserted nothing. With the intended `&&`, two of four classes failed:
    // one was all-allowals, one all-refusals, exactly the shape the pattern
    // forbids. The rows they were missing are now in the table.
    //
    // The rule now lives in `class-table.ts` so there is one copy of it
    // rather than one per table, and `invariants.test.ts` proves that copy
    // rejects a bad table instead of grepping for this sentence.
    expect(
      classTableProblems(
        TABLE.map(({ klass, cases }) => ({ klass, rows: cases })),
        (c) => (c.expect === false ? "refused" : "allowed"),
      ),
    ).toEqual([]);
  });

  test("no expected header value is ever the empty string", () => {
    // The invariant the whole module exists for, asserted over the table
    // itself: if a row ever expects `""` on the wire, the rule has been
    // weakened and this file agreed to it.
    for (const { cases } of TABLE) {
      for (const c of cases) {
        if (c.expect === false) continue;
        for (const [name, value] of Object.entries(c.expect)) {
          expect({ label: c.label, name, empty: value === "" }).toEqual({ label: c.label, name, empty: false });
        }
      }
    }
  });
});

// The same rule, one field to the left.
//
// The AC19 machinery looked only at `headers`, and `url` takes `${VAR}`
// too. `https://api.example/${TENANT}/mcp` with TENANT unset is a VALID
// url addressing the wrong path, and it was reported as "nothing is
// listening" — a diagnosis that sends the operator to check a server
// that is running fine.
const URL_TABLE: Array<{
  klass: string;
  why: string;
  cases: Array<{
    label: string;
    url: string;
    env?: Record<string, string | undefined>;
    /** A fragment of the refusal, or `false` when the URL is acceptable. */
    problem: string | false;
  }>;
}> = [
  {
    klass: "a ${VAR} in the url must resolve",
    why: "an unset one silently rewrites the path or the host rather than failing",
    cases: [
      { label: "unset in the path", url: "https://api.test/${TENANT}/mcp", problem: "TENANT" },
      { label: "unset in the host", url: "https://${REGION}.api.test/mcp", problem: "REGION" },
      {
        label: "two unset are both named",
        url: "https://${REGION}.api.test/${TENANT}/mcp",
        problem: "TENANT",
      },
      {
        label: "BOUNDARY — set, so no problem",
        url: "https://api.test/${TENANT}/mcp",
        env: { TENANT: "acme" },
        problem: false,
      },
      { label: "BOUNDARY — a url with no variables at all", url: "https://api.test/mcp", problem: false },
      {
        label: "BOUNDARY — a ${VAR:-default} that falls back is supplied, not missing",
        url: "https://api.test/${TENANT:-public}/mcp",
        problem: false,
      },
    ],
  },
];

describe("URL variables, by CLASS", () => {
  for (const { klass, why, cases } of URL_TABLE) {
    describe(`${klass} — ${why}`, () => {
      for (const c of cases) {
        test(c.label, () => {
          const problem = urlProblem(c.url, c.env ?? {});
          if (c.problem === false) {
            expect({ label: c.label, problem }).toEqual({ label: c.label, problem: undefined });
            return;
          }
          expect(problem ?? "").toContain(c.problem);
        });
      }
    });
  }

  test("every class has three rows and a BOUNDARY", () => {
    expect(
      classTableProblems(
        URL_TABLE.map(({ klass, cases }) => ({ klass, rows: cases })),
        (c) => (c.problem === false ? "accepted" : "refused"),
      ),
    ).toEqual([]);
  });
});

describe("a credential in the URL itself is refused", () => {
  test("userinfo is named, with the reason", () => {
    // Bun's fetch DROPS userinfo, so the operator would get the secret on
    // screen in every report and an unauthenticated connection.
    const problem = userinfoProblem("https://alice:hunter2@api.test/mcp");
    expect(problem).toContain("username/password");
  });

  test("a username with no password counts", () => {
    expect(userinfoProblem("https://alice@api.test/mcp")).toContain("username/password");
  });

  test("BOUNDARY — an ordinary url does not", () => {
    expect(userinfoProblem("https://api.test/mcp")).toBeUndefined();
  });

  test("BOUNDARY — an @ in the PATH is not userinfo", () => {
    expect(userinfoProblem("https://api.test/@scope/mcp")).toBeUndefined();
  });

  test("an unparseable url is left to the transport to report", () => {
    expect(userinfoProblem("not a url")).toBeUndefined();
  });
});

describe("displayUrl is safe to print", () => {
  test("the query is elided wholesale, because it carries ?api_key=", () => {
    const shown = displayUrl("https://api.test/mcp?api_key=sk-live-secret&x=1");
    expect(shown).not.toContain("sk-live-secret");
    expect(shown).toBe("https://api.test/mcp?…");
  });

  test("userinfo is elided too", () => {
    expect(displayUrl("https://alice:hunter2@api.test/mcp")).not.toContain("hunter2");
  });

  test("BOUNDARY — a url with nothing to hide is shown in full", () => {
    // Without this, `displayUrl = () => "…"` passes every test above.
    expect(displayUrl("https://api.test/v1/mcp")).toBe("https://api.test/v1/mcp");
  });

  test("a ${VAR} keeps its CASE, because that is the variable's name", () => {
    // `new URL` parses this and lowercases the host, so the report said
    // `${region}` — an environment variable that does not exist — while
    // `REGION` sat unset. Found by the boundary row, not by a reviewer.
    expect(displayUrl("https://${REGION}.api.test/mcp")).toBe("https://${REGION}.api.test/mcp");
  });

  test("and a templated url still has its query and userinfo elided", () => {
    expect(displayUrl("https://u:p@${REGION}.api.test/mcp?key=sk-live")).toBe(
      "https://…@${REGION}.api.test/mcp?…",
    );
  });

  test("undefined is the empty string, not the word undefined", () => {
    expect(displayUrl(undefined)).toBe("");
  });
});

describe("referencedVariable names what the operator has to set", () => {
  test("it finds the variable in a raw value", () => {
    expect(referencedVariable("Bearer ${GITHUB_TOKEN}")).toBe("GITHUB_TOKEN");
    expect(referencedVariable("${A:-fallback}")).toBe("A");
  });

  test("and reports none when the value names none", () => {
    expect(referencedVariable("")).toBeUndefined();
    expect(referencedVariable("Bearer literal")).toBeUndefined();
    expect(referencedVariable(undefined)).toBeUndefined();
  });
});
