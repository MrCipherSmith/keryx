import { describe, expect, test } from "bun:test";
import { matchIntent, suggestIntent } from "./command-registry";

// Matching was a contiguous substring test in both directions, so a single
// filler word defeated it: `rebuild graph` is a declared intent and "rebuild the
// graph" matched NOTHING, because neither string contains the other.
//
// The corpus below is the measurement, and it was written BEFORE the change —
// including the five phrasings that returned nothing — because that is the
// lesson #436 paid for: a corpus of only-successes lets every round see its
// improvements and none of its losses. Result of the change over these 22
// phrasings: 2 gained, 0 lost, 20 unchanged, plus 2 more from intent phrases
// added as data.

const EXPECTED: ReadonlyArray<readonly [string, string]> = [
  // Phrasings that worked before and must keep working. If the matcher is ever
  // rewritten again, this is the losing side written down in advance.
  ["обнови граф", "gdgraph build"],
  ["обнови граф и вики", "gdgraph build"],
  ["rebuild graph", "gdgraph build"],
  ["build the code graph", "gdgraph build"],
  ["wiki freshness", "wiki freshness"],
  ["refresh wiki reference", "wiki refresh"],
  ["обнови reference вики", "wiki refresh"],
  ["wiki refresh", "wiki refresh"],
  ["check wiki links", "wiki check-links"],
  ["проверь ссылки вики", "wiki check-links"],
  ["enrich wiki", "wiki enrich"],
  ["обогати вики", "wiki enrich"],
  ["collect wiki", "wiki collect"],
  ["собери вики", "wiki collect"],
  ["wiki verify", "wiki verify"],
  ["подтверди страницу вики", "wiki verify"],
  ["stamp wiki provenance", "wiki verify"],

  // The five that returned nothing. Four are fixed; the fifth is deliberately
  // still unmatched and is asserted separately below.
  ["rebuild the graph", "gdgraph build"], // filler word defeated the substring test
  ["refresh the wiki", "wiki refresh"], // same
  ["перестрой граф", "gdgraph build"], // intent phrase was simply absent
  ["update the code graph", "gdgraph build"], // same
];

describe("intent matching", () => {
  test("every recorded phrasing resolves to the command it names", () => {
    const wrong: string[] = [];
    for (const [query, command] of EXPECTED) {
      const hits = matchIntent(query);
      const top = hits[0]?.command ?? "NONE";
      if (top !== command) wrong.push(`${query}: expected ${command}, got ${top}`);
    }
    expect(wrong).toEqual([]);
  });

  test("a filler word does not defeat a phrase", () => {
    // The defect itself, stated as one assertion so a regression names itself.
    expect(matchIntent("rebuild the graph")[0]?.command).toBe("gdgraph build");
    expect(matchIntent("rebuild graph")[0]?.command).toBe("gdgraph build");
  });

  test("word order does not matter once the words are all present", () => {
    expect(matchIntent("refresh the wiki")[0]?.command).toBe("wiki refresh");
    expect(matchIntent("wiki refresh")[0]?.command).toBe("wiki refresh");
  });

  test("an exact substring outranks the same words scattered through a query", () => {
    // Both rules can fire for one query; the verbatim phrase is the stronger
    // evidence and must win, or a longer loosely-matched phrase could displace
    // the command the user actually named.
    const hits = matchIntent("wiki freshness");
    expect(hits[0]?.command).toBe("wiki freshness");
  });

  test("an ambiguous query stays unmatched and is answered with candidates", () => {
    // "обнови вики" names four commands at once — index, enrich, refresh,
    // collect. Attaching it to one would be picking a winner the query does not
    // name, so it deliberately matches nothing.
    expect(matchIntent("обнови вики")).toEqual([]);

    const suggestions = suggestIntent("обнови вики").map((entry) => entry.command);
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions).toContain("wiki refresh");
  });

  test("suggestions are empty for a query sharing no words with any intent", () => {
    // Otherwise "closest commands" would be noise attached to every failure.
    expect(suggestIntent("zzzz qqqq")).toEqual([]);
  });
});
