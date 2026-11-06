import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describeConnectionFailure, RATE_LIMITED_SEARCH_ERROR } from "./connection-message";
import { connectedMessage } from "./connect-message";

describe("search connection failure wording", () => {
  test("names each failure kind distinctly instead of printing one generic message", () => {
    expect(describeConnectionFailure("missing-credential")).toBe("missing credential");
    expect(describeConnectionFailure("transport-failed")).toBe("connection validation failed");
    expect(describeConnectionFailure(undefined)).toBe("connection validation failed");
    expect(describeConnectionFailure("incompatible-response")).toContain("not with search results");
    expect(describeConnectionFailure("rate-limited")).toContain("rate limited");
    // A paid provider can accept the key and still refuse every request; that
    // must not read like a network fault an operator can retry away.
    expect(describeConnectionFailure("insufficient-balance")).toContain("insufficient balance");
    // A rejected key is not a missing one: the operator fixes a different thing.
    expect(describeConnectionFailure("invalid-credential")).toContain("rejected");
  });

  test("a rate limit never reads as a generic connection failure", () => {
    // The regression this wording exists against: DuckDuckGo answers a flagged
    // egress address with its anomaly page, forever. Reported as "connection
    // validation failed" that looks like a network fault worth retrying — the
    // one response that cannot possibly help.
    const rateLimited = describeConnectionFailure("rate-limited");
    expect(rateLimited).not.toContain("connection validation failed");
    expect(rateLimited).toContain("will not help");
  });

  test("the search wording tells the model not to retry or rephrase, and to wait", () => {
    // The guidance the one other agent scraping this same endpoint gives its
    // own model: a search that already spent its retry ladder must not
    // invite another attempt, because each one extends the limiter's window.
    expect(RATE_LIMITED_SEARCH_ERROR).toContain("Do not retry or rephrase");
    expect(RATE_LIMITED_SEARCH_ERROR).toContain("wait a few minutes");
  });
});

describe("the connect sentence", () => {
  test("names the tool that changed hands only when the provider serves pages", () => {
    expect(connectedMessage("deepseek", { active: true, servesPages: true }))
      .toBe("Connected 'deepseek' and made it the active search provider (web_search and web_fetch). /search-connect duckduckgo switches back.");
    expect(connectedMessage("brave", { active: true, servesPages: false }))
      .toBe("Connected 'brave' and made it the active search provider. /search-connect duckduckgo switches back.");
    // A connect that did not activate must not claim it did.
    expect(connectedMessage("deepseek", { active: false, servesPages: true }))
      .toBe("Configured and tested 'deepseek' successfully. Use /search-connect deepseek to make it active.");
  });
});

describe("both operator surfaces print the distinct wording", () => {
  // `/search-provider`'s TUI wizard is additionally driven for real (flow 179
  // in tui-shell.test.ts) to prove this wording reaches the screen. The agent
  // readline REPL has no headless seam — shell.ts's own note says so — so for
  // that surface the call site is the only thing there is to assert.
  const tuiSource = readFileSync(join(import.meta.dir, "../../tui/tui-shell.ts"), "utf8");
  const shellSource = readFileSync(join(import.meta.dir, "../../commands/shell.ts"), "utf8");

  test("every failure line routes through describeConnectionFailure", () => {
    // tui-shell.ts has two such lines (the `/search-provider` wizard, which
    // still tests directly, and the args-given branch, which now goes through
    // the controller's `connect`); shell.ts has the agent REPL's one.
    // Both TUI paths now go through connect(); the shell has its own one.
    expect(tuiSource.split("describeConnectionFailure(tested.reason)").length - 1).toBe(0);
    expect(tuiSource.split("describeConnectionFailure(connected.reason").length - 1).toBe(2);
    expect(shellSource.split("describeConnectionFailure(connected.reason").length - 1).toBe(1);
  });

  test("no surface still hardcodes the old two-way reason ternary", () => {
    for (const source of [tuiSource, shellSource]) {
      expect(source).not.toContain('tested.reason === "missing-credential" ? "missing credential"');
    }
  });
});
