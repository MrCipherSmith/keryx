// The lines a mutation sweep found nothing constrained.
//
// `scripts/mutation-sweep.ts` inverts every line the branch added and asks
// whether any test fails. It is the criterion a reviewer recommended
// freezing, because it is the one that converges: "does the reported
// reproduction now pass" is satisfied by a fix that only knows about the
// reproduction, which is what produced four rounds of the same defect.
//
// The first run over this branch: 102 mutants, 39 survived. Most of the
// survivors were `?? -> ||` on an object or boolean default, where the two
// operators genuinely cannot differ — an equivalent mutant, not a gap. The
// rest are here. Each test is named for what the surviving mutant proved
// nobody was watching.
//
// Not one of these is exotic. They are the SURFACE around decisions that
// were themselves carefully made and carefully tested: the boundary of a
// status range, the second half of an `||`, the case where a lookup finds
// the wrong entry. That is the shape of every defect this package has
// produced, which is the argument for the criterion.

import { describe, expect, test } from "bun:test";
import { explainConnectFailure, httpStatusOf } from "./doctor";
import { displayUrl, resolveHttpHeaders } from "./http-headers";
import { describeForApproval } from "./trust";
import { connectHttpMcpServer } from "../mcp-client/client";
import { createMcpRuntime } from "./runtime";
import { startMockHttpMcpServer } from "../../fixtures/mcp-servers/http-server";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { McpServerEntry, ResolvedMcpServer } from "./config";

function server(raw: McpServerEntry): ResolvedMcpServer {
  return { name: "s", source: "user", file: "/x", enabled: true, raw, ...raw } as ResolvedMcpServer;
}

function httpError(code: number): Error {
  return Object.assign(new Error("Error POSTing to endpoint"), { code });
}

function syscallError(code: string): Error {
  return Object.assign(new Error("fetch failed"), { code });
}

describe("a credential in a url, with no password", () => {
  // MUTANT: `username !== "" || password !== ""` -> `&&`, survived.
  //
  // Both places that enforce this were tested with `alice:hunter2@`, so
  // the `||` was never load-bearing. `https://token@api.example/mcp` is
  // the form people actually write — a bare token as the username — and
  // under `&&` it would sail through, be silently dropped by Bun's fetch,
  // and connect anonymously with the token printed in every report.

  test("the transport refuses it", async () => {
    await expect(connectHttpMcpServer("https://sk-live-token@api.example/mcp")).rejects.toThrow(
      /username\/password/,
    );
  });

  test("and a password with no username, which is the same mistake typed differently", async () => {
    await expect(connectHttpMcpServer("https://:hunter2@api.example/mcp")).rejects.toThrow(
      /username\/password/,
    );
  });

  test("BOUNDARY — a url with neither is dialled", async () => {
    // Not a connection test: port 1 refuses. The point is that it got
    // past the refusal and reached the socket, which a different message
    // proves.
    await expect(connectHttpMcpServer("http://127.0.0.1:1/mcp")).rejects.toThrow(
      /^(?!.*username\/password).*$/s,
    );
  }, 30_000);
});

describe("the HTTP status ranges, at their edges", () => {
  // MUTANT: `status >= 500` -> `> 500`, survived — 503 was tested and 500
  // was not, so the boundary of the range was never on the wire.
  test("exactly 500 is a server failure, not an unclassified status", () => {
    const message = explainConnectFailure("http", server({ url: "https://x/mcp" }), httpError(500));
    expect(message).toContain("the server is failing, not the config");
  });

  test("BOUNDARY — 499 is not", () => {
    const message = explainConnectFailure("http", server({ url: "https://x/mcp" }), httpError(499));
    expect(message).not.toContain("the server is failing");
    expect(message).toContain("answered HTTP 499");
  });

  // MUTANT: `code >= 100` -> `> 100` and `code <= 599` -> `< 599`, both
  // survived. `httpStatusOf` decides whether ANY status branch runs, so
  // its range is the gate on the whole classification.
  test("httpStatusOf accepts the first and last real status codes", () => {
    expect(httpStatusOf({ code: 100 })).toBe(100);
    expect(httpStatusOf({ code: 599 })).toBe(599);
  });

  test("BOUNDARY — and rejects the numbers just outside, which are syscall-ish", () => {
    expect(httpStatusOf({ code: 99 })).toBeUndefined();
    expect(httpStatusOf({ code: 600 })).toBeUndefined();
  });
});

describe("socket errors that are not the first one in the list", () => {
  // MUTANT: `syscall === "ENOTFOUND" || syscall === "EAI_AGAIN"` -> `&&`,
  // survived. `&&` can never be true, so NEITHER branch fired — and the
  // DNS test passed anyway because it accepted the fallback wording too.
  // A test written to tolerate two answers cannot tell you which it got.
  test("ECONNREFUSED says nothing is listening, in those words", () => {
    // Caught by a reviewer, and it is the same criticism this file makes
    // of the DNS test one line down — applied to a test I wrote in this
    // very file's spirit and then failed to apply here. The live test in
    // `doctor.failures.test.ts` asserts
    // `/nothing is listening|could not be reached/`, and the second
    // alternative is the GENERIC fallback: delete the ECONNREFUSED branch
    // entirely and that regex still matches. Verified — 41 tests stayed
    // green with the branch removed.
    //
    // The mutation sweep missed it too, and the reason is worth keeping:
    // inverting `===` to `!==` makes the branch fire for every OTHER
    // syscall, which a sibling's exact test catches. Only DELETING the
    // branch is invisible, and deletion was not one of the sweep's
    // operators. It is now.
    expect(
      explainConnectFailure("http", server({ url: "https://x/mcp" }), syscallError("ECONNREFUSED")),
    ).toContain("nothing is listening");
  });

  test("ETIMEDOUT says it did not answer in time", () => {
    // Found by the sweep's new deletion operator, immediately after the
    // ECONNREFUSED fix — and it is the recurring defect one more time.
    // A reviewer reported ECONNREFUSED, I fixed ECONNREFUSED, and I did
    // not walk the other arms of the same `if`/`else` chain. Deleting
    // this branch was invisible for exactly the reason deleting that one
    // was: control falls through to the generic fallback and no test
    // distinguishes them.
    expect(
      explainConnectFailure("http", server({ url: "https://x/mcp" }), syscallError("ETIMEDOUT")),
    ).toContain("did not answer in time");
  });

  test("BOUNDARY — an unrecognised code gets the generic wording, and only it", () => {
    // The fallback the branches above must NOT be mistaken for. Without
    // this, every branch could return the generic sentence and the whole
    // chain would read as covered.
    const message = explainConnectFailure("http", server({ url: "https://x/mcp" }), syscallError("EHOSTDOWN"));
    expect(message).toContain("could not be reached");
    expect(message).toContain("EHOSTDOWN");
    expect(message).not.toContain("nothing is listening");
    expect(message).not.toContain("did not answer in time");
    expect(message).not.toContain("does not resolve");
  });

  test("ENOTFOUND says the host does not resolve", () => {
    expect(explainConnectFailure("http", server({ url: "https://x/mcp" }), syscallError("ENOTFOUND"))).toContain(
      "does not resolve",
    );
  });

  test("EAI_AGAIN says the same, and it is the SECOND term of the ||", () => {
    expect(explainConnectFailure("http", server({ url: "https://x/mcp" }), syscallError("EAI_AGAIN"))).toContain(
      "does not resolve",
    );
  });

  // MUTANT: the three TLS terms `||` -> `&&`, survived. There was no TLS
  // test at all — the branch was written from knowledge of Node's error
  // codes and never executed.
  test.each([
    ["CERT_HAS_EXPIRED"],
    // The one the substring heuristic missed, and the one a corporate
    // TLS-intercepting proxy actually produces. Reported as "could not be
    // reached", which sends the operator to debug the server.
    ["UNABLE_TO_VERIFY_LEAF_SIGNATURE"],
    ["SELF_SIGNED_CERT_IN_CHAIN"],
    ["HOSTNAME_MISMATCH"],
    ["ERR_SSL_WRONG_VERSION_NUMBER"],
    ["ERR_TLS_CERT_ALTNAME_INVALID"],
  ])("%s is reported as a certificate problem", (code) => {
    expect(explainConnectFailure("http", server({ url: "https://x/mcp" }), syscallError(code))).toContain(
      "TLS certificate",
    );
  });

  test("BOUNDARY — an unrelated syscall is not called a certificate problem", () => {
    const message = explainConnectFailure("http", server({ url: "https://x/mcp" }), syscallError("EPIPE"));
    expect(message).not.toContain("TLS certificate");
    expect(message).toContain("EPIPE");
  });
});

describe("finding a header by name", () => {
  // MUTANT: `key.toLowerCase() === wanted` -> `!==` in `findHeader`,
  // survived — and survived again after this test was written, which is
  // what identified the real problem. `findHeader` was DEAD: it existed
  // only as the `??` fallback on the raw lookup, and `config.ts` copies
  // header keys through expansion unchanged, so the exact key always hit
  // and the fallback could never fire. No test can kill a mutant in
  // unreachable code. The function is gone; this test now pins the
  // behaviour the lookup does have.
  test("with several headers, the raw value looked up is the RIGHT one", () => {
    // `X-Other` is literal and fine; `Authorization` names an unset
    // variable. If the lookup returns the wrong entry, the hollow check
    // reads `literal` for Authorization, finds no variable, and sends
    // `Bearer ` to the far end.
    const raw: McpServerEntry = {
      url: "https://x",
      headers: { "X-Other": "literal", Authorization: "Bearer ${TOKEN}" },
    };
    const expanded: McpServerEntry = {
      url: "https://x",
      headers: { "X-Other": "literal", Authorization: "Bearer " },
    };
    const result = resolveHttpHeaders(expanded, raw, {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.hollow.map((h) => h.variable)).toEqual(["TOKEN"]);
    }
  });

  // MUTANT: `raw.headers?.[name] ?? findHeader(...)` -> `||`, survived.
  // NOT an equivalent mutant, unlike the other `??` survivors: an exact
  // key whose raw value is the EMPTY STRING is falsy, so `||` discarded
  // it and fell through to the case-insensitive search. Empty header
  // values are the entire subject of this module. With the dead fallback
  // removed the `??` is gone too, and this pins the behaviour so it
  // cannot come back.
  test("an exact key holding an empty string is used, not skipped over", () => {
    const raw: McpServerEntry = { url: "https://x", headers: { "X-Api-Key": "" } };
    const result = resolveHttpHeaders(raw, raw, {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // No variable, because the operator literally wrote it empty — the
      // message that names a variable would be a fabrication.
      expect(result.hollow).toEqual([{ header: "X-Api-Key", variable: undefined }]);
    }
  });

  // MUTANT: `duplicates.some((d) => d.toLowerCase() === name.toLowerCase())`
  // -> `!==`, survived. Inverted, the loop skips every NON-duplicate and
  // processes the duplicates, so a good config produces no headers at all.
  test("with a duplicate present, the OTHER headers are still processed", () => {
    const raw: McpServerEntry = {
      url: "https://x",
      headers: { "X-Api-Key": "a", "x-api-key": "b", "X-Fine": "${GOOD}" },
    };
    const expanded: McpServerEntry = {
      url: "https://x",
      headers: { "X-Api-Key": "a", "x-api-key": "b", "X-Fine": "" },
    };
    const result = resolveHttpHeaders(expanded, raw, {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Both problems reported: the duplicate pair AND the hollow third
      // header. Skipping the non-duplicates would report only the pair.
      expect(result.hollow.some((h) => h.duplicate === true)).toBe(true);
      expect(result.hollow.some((h) => h.variable === "GOOD")).toBe(true);
    }
  });
});

describe("aborting a dial that is still in flight", () => {
  // MUTANT: `...(signal === undefined ? {} : { signal })` -> `!==`, in
  // BOTH copies of the connect path, survived. Inverted, the signal is
  // dropped exactly when there is one — so Ctrl-C during a dial to a
  // server that accepts and stalls would not cancel it. The stdio path
  // has this covered because a stranded child process is visible; the
  // HTTP path had nothing, because a stranded socket is not.

  test("closing the runtime while a slow server is being dialled does not wait for it", async () => {
    const slow = await startMockHttpMcpServer({ delayMs: 60_000 });
    const dir = mkdtempSync(path.join(tmpdir(), "keryx-abort-"));
    writeFileSync(
      path.join(dir, "mcp-servers.json"),
      JSON.stringify({ schemaVersion: 1, servers: { slow: { url: slow.url } } }),
    );

    const runtime = createMcpRuntime({ cwd: dir, gitRoot: dir, configDir: dir, env: {} });
    const started = Date.now();
    // Do NOT await ready() first: the dial has to be in flight for the
    // abort to be the thing that ends it.
    await runtime.close();
    await runtime.ready().catch(() => undefined);
    const elapsed = Date.now() - started;

    await slow.stop();
    // The margin is measured, not guessed. Cancelled, this takes ~200ms.
    // With the signal dropped it runs to the 15s handshake budget — I ran
    // the mutant by hand to check, because a threshold of 20s "passed"
    // for both and would have been a test that watched the right thing
    // and could not fail.
    expect(elapsed).toBeLessThan(5_000);
  }, 90_000);
});

describe("every surface that PRINTS a url elides the secret in it", () => {
  // Found by smoke-testing the released 0.2.91 binary — late, and the
  // sharpest instance of this package's recurring shape. `doctor`
  // REFUSES a url carrying userinfo, and the reason it gives the
  // operator is "it would be printed in every report". `keryx mcp list`
  // was that report, printing `raw.url` verbatim.
  //
  // The earlier fix to `describeTarget` was real and half the problem:
  // it switched from the EXPANDED url to the RAW one, so `${TOKEN}` no
  // longer printed its value. It did nothing for the case where the
  // operator writes the secret literally, which is the case `doctor`
  // refuses the config over.
  //
  // So the unit here is the CLASS — every surface that renders a url —
  // rather than the one that was reported.

  const SECRETS = [
    ["userinfo", "https://alice:hunter2@api.example/mcp", "hunter2"],
    ["a query string", "https://api.example/mcp?api_key=sk-live-abc", "sk-live-abc"],
  ] as const;

  for (const [kind, url, secret] of SECRETS) {
    test(`displayUrl removes ${kind}`, () => {
      expect(displayUrl(url)).not.toContain(secret);
    });

    test(`the approval prompt removes ${kind}`, () => {
      expect(describeForApproval(server({ url }))).not.toContain(secret);
    });
  }

  test("BOUNDARY — a url with no secret is printed in full, so this is elision and not blanking", () => {
    expect(displayUrl("https://api.example/v1/mcp")).toBe("https://api.example/v1/mcp");
    expect(describeForApproval(server({ url: "https://api.example/v1/mcp" }))).toContain(
      "https://api.example/v1/mcp",
    );
  });

  test("and the host is still identifiable, because that is the point of showing it", () => {
    // A redaction that hid the host would make the approval prompt
    // useless: the operator is deciding whether to trust THAT host.
    expect(displayUrl("https://alice:hunter2@api.example/mcp")).toContain("api.example");
  });
});

describe("what the approval prompt says a remote server will be handed", () => {
  // MUTANTS: four survived in `describeForApproval`/`credentialSummary`.
  // This is the text an operator reads before granting a third-party host
  // a credential, and the tests covered the stdio branch only.

  test("a url with no credentials is shown plain", () => {
    expect(describeForApproval(server({ url: "https://api.test/mcp" }))).toBe("https://api.test/mcp");
  });

  test("a bearer_token_env_var is NAMED, so the operator knows what they are sending", () => {
    const line = describeForApproval(server({ url: "https://api.test/mcp", bearer_token_env_var: "GITHUB_TOKEN" }));
    expect(line).toContain("https://api.test/mcp");
    expect(line).toContain("GITHUB_TOKEN");
  });

  // MUTANT: `bearer_token_env_var !== undefined && !== ""` -> `||`,
  // survived. An empty string would then be added as a named variable and
  // the prompt would read `[sends ]`.
  test("BOUNDARY — an empty bearer_token_env_var names nothing", () => {
    expect(describeForApproval(server({ url: "https://api.test/mcp", bearer_token_env_var: "" }))).toBe(
      "https://api.test/mcp",
    );
  });

  test("variables inside header values are named too", () => {
    const line = describeForApproval(
      server({ url: "https://api.test/mcp", headers: { Authorization: "Bearer ${LINEAR_TOKEN}" } }),
    );
    expect(line).toContain("LINEAR_TOKEN");
  });

  // MUTANT: `named.size === 0 && headerNames.length === 0` -> `||`,
  // survived. Under `||`, a server with a variable-bearing header and
  // nothing else returns undefined — the credential warning disappears
  // from the prompt entirely, which is the one thing this line exists to
  // prevent.
  test("a LITERAL header is disclosed as well, since a pasted token is still a token", () => {
    const line = describeForApproval(
      server({ url: "https://api.test/mcp", headers: { "X-Api-Key": "sk-live-pasted" } }),
    );
    expect(line).toContain("literal header(s) X-Api-Key");
    // And never the value.
    expect(line).not.toContain("sk-live-pasted");
  });

  test("a stdio server still describes its command", () => {
    expect(describeForApproval(server({ command: "npx", args: ["-y", "pkg"] }))).toBe("npx -y pkg");
  });
});
