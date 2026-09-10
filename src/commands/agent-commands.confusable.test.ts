// Slash commands that differ only by a trailing `s` have no disambiguator.
//
// A slash command is typed fast, from memory, with no flags and no arguments
// to reveal which one you meant. `/mcp` and `/mcps` would be one character
// apart and — as proposed in docs/requirements/keryx-mcp-servers/ — opposite
// roles: one for keryx acting as an MCP server, one for the third-party servers
// keryx consumes. Nothing tells the operator which one ran until after it has.
//
// This is not hypothetical. `/model` and `/models` already ship in exactly that
// shape. They are harmless because they share a subject — both lead to picking
// a model, so a mistype costs a keystroke. That is the distinction the rule has
// to encode: near-identical names are fine when they mean nearly the same
// thing, and dangerous when they mean opposite things.
//
// "Opposite things" is not machine-checkable, so the rule is: a confusable pair
// must be declared, with the reason it is safe. An undeclared pair fails, which
// forces the argument to happen in a pull request rather than after release.

import { expect, test } from "bun:test";
import { AGENT_SLASH_COMMANDS } from "./agent-commands";

/**
 * Confusable pairs that are deliberate, each with why a mistype is harmless.
 *
 * Adding an entry here is the decision. It should be hard to write a sentence
 * for a pair that genuinely confuses, which is the point.
 */
const ALLOWED_CONFUSABLE: ReadonlyArray<{ pair: readonly [string, string]; because: string }> = [
  {
    pair: ["/model", "/models"],
    because:
      "Same subject: /model switches the model, /models opens the numbered menu " +
      "for the current provider. Both land the operator in model selection, so " +
      "reaching the other one costs a keystroke and nothing else.",
  },
];

function names(): string[] {
  return AGENT_SLASH_COMMANDS.map((command) => command.name);
}

/** Two names collide when only a trailing plural, or a separator, tells them apart. */
function confusableKey(name: string): string {
  const withoutPlural = name.endsWith("s") ? name.slice(0, -1) : name;
  return withoutPlural.replace(/[-_]/g, "");
}

test("the registry is actually populated, so a clean result cannot mean an empty read", () => {
  // The guard below reports "no collisions" for an empty list just as cheerfully
  // as for a clean one. A check that cannot fail is worse than no check: while
  // writing this file, a first attempt to scrape command literals out of
  // src/tui returned zero matches and looked like a pass.
  expect(names().length).toBeGreaterThan(20);
  expect(names()).toContain("/help");
});

test("no two slash commands differ only by a trailing 's' unless declared safe", () => {
  const all = names();
  const declared = new Set(
    ALLOWED_CONFUSABLE.map(({ pair }) => [...pair].sort().join(" vs ")),
  );

  const found: string[] = [];
  for (let i = 0; i < all.length; i += 1) {
    for (let j = i + 1; j < all.length; j += 1) {
      const a = all[i] as string;
      const b = all[j] as string;
      if (confusableKey(a) !== confusableKey(b)) continue;
      const key = [a, b].sort().join(" vs ");
      if (!declared.has(key)) found.push(key);
    }
  }

  // Named in the failure so the reader gets the rule, not just a diff.
  expect(found, "add an ALLOWED_CONFUSABLE entry with why a mistype is harmless, or rename one").toEqual([]);
});

test("every declared exception names commands that exist", () => {
  // A stale entry would silently license a collision that no longer looks like
  // one — and would keep licensing it if a future command took the freed name.
  const all = new Set(names());
  for (const { pair, because } of ALLOWED_CONFUSABLE) {
    for (const name of pair) expect(all.has(name), `${name} is declared but not registered`).toBe(true);
    expect(because.length).toBeGreaterThan(40);
  }
});

test("the rule would reject /mcps against /mcp", () => {
  // The case this exists for, checked directly rather than trusted to the loop
  // above: /mcp is registered today, so adding /mcps must collide.
  expect(names()).toContain("/mcp");
  expect(confusableKey("/mcps")).toBe(confusableKey("/mcp"));
  expect(
    ALLOWED_CONFUSABLE.some(({ pair }) => pair.includes("/mcps")),
  ).toBe(false);
});
