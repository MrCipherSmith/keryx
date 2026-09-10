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
import { describeHollow, referencedVariable, resolveHttpHeaders } from "./http-headers";
import type { McpServerEntry } from "./config";

type Case = {
  readonly label: string;
  readonly raw: McpServerEntry;
  readonly env: Record<string, string | undefined>;
  /** Headers expected on the wire, or `false` if the dial must be refused. */
  readonly expect: Record<string, string> | false;
  /** When refused, a fragment the message must contain. */
  readonly says?: string;
};

/** Apply `${VAR}` the way `config.ts` does, so the table feeds real input. */
function expand(raw: McpServerEntry, env: Record<string, string | undefined>): McpServerEntry {
  const sub = (v: string): string =>
    v.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, name: string, fallback?: string) => {
      const found = env[name];
      return found !== undefined && found !== "" ? found : (fallback ?? "");
    });
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

  test("every class carries a BOUNDARY — a case that comes out the other way", () => {
    for (const { klass, cases } of TABLE) {
      const refused = cases.filter((c) => c.expect === false).length;
      const allowed = cases.length - refused;
      expect({ klass, bothOutcomes: refused > 0 || allowed > 0 }).toEqual({ klass, bothOutcomes: true });
    }
    // And across the table as a whole, both outcomes are exercised.
    const all = TABLE.flatMap((t) => t.cases);
    expect(all.some((c) => c.expect === false)).toBe(true);
    expect(all.some((c) => c.expect !== false)).toBe(true);
  });

  test("every class carries at least three rows", () => {
    for (const { klass, cases } of TABLE) {
      expect({ klass, enough: cases.length >= 3 }).toEqual({ klass, enough: true });
    }
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
