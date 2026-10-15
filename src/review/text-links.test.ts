// Flow 457 AC3: implicit consumers through string keys the diff changed.

import { describe, expect, test } from "bun:test";
import { extractTextKeys, findTextLinks, gitGrepSearcher, keysFromLine, ripgrepSearcher, type TextSearchRunner } from "./text-links";

const DIFF = [
  "diff --git a/src/panel.tsx b/src/panel.tsx",
  "--- a/src/panel.tsx",
  "+++ b/src/panel.tsx",
  "@@ -3,0 +4,5 @@",
  '+import { x } from "./not.a.key";',
  '+  const label = t("panel.title.save");',
  '+  bus.emit("order:created", order);',
  '+  return <div className="order-card is-active">{label}</div>;',
  '+  const depth = config.get("review.max_depth");',
  "-  const old = process.env.KERYX_OLD_FLAG;",
  "diff --git a/settings.json b/settings.json",
  "--- a/settings.json",
  "+++ b/settings.json",
  "@@ -1 +1 @@",
  '+  "blast_radius_max_files": 40,',
  '+  "name": "x",',
].join("\n");

describe("key extraction", () => {
  test("pulls i18n keys, events, CSS classes and config keys from changed lines, never from import specifiers", () => {
    const keys = extractTextKeys(DIFF);
    const byKind = (kind: string): string[] => keys.filter((key) => key.kind === kind).map((key) => key.key);
    expect(byKind("i18n-key")).toEqual(["panel.title.save"]);
    expect(byKind("event")).toEqual(["order:created"]);
    expect(byKind("css-class")).toEqual(["order-card", "is-active"]);
    expect(byKind("config-key")).toEqual(["review.max_depth", "KERYX_OLD_FLAG", "blast_radius_max_files"]);
    expect(keys.map((key) => key.key)).not.toContain("not.a.key");
    expect(keys.map((key) => key.key)).not.toContain("name");
    expect(keys.find((key) => key.key === "blast_radius_max_files")?.file).toBe("settings.json");
  });

  test("file names, versions and template interpolations are not keys", () => {
    expect(keysFromLine('const f = "blast-radius.json"; const v = "1.2.3"; t(`a.${b}`);', "src/a.ts")).toEqual([]);
  });
});

describe("consumers by text search", () => {
  test("links files that mention a key, excludes the changed files, and turns a key over the hit limit into a hub", async () => {
    const hits: Record<string, string[]> = {
      "panel.title.save": ["src/panel.tsx", "src/locales/en.json", "src/locales/de.json"],
      "order-card": Array.from({ length: 30 }, (_, index) => `src/c${index}.tsx`),
      "order:created": ["src/billing/listener.ts"],
    };
    const result = await findTextLinks({
      diff: DIFF,
      changedFiles: ["src/panel.tsx", "settings.json"],
      search: async (key) => hits[key] ?? [],
      maxHits: 20,
    });
    expect(result.links.map((link) => [link.file, link.key, link.kind])).toEqual([
      ["src/billing/listener.ts", "order:created", "event"],
      ["src/locales/de.json", "panel.title.save", "i18n-key"],
      ["src/locales/en.json", "panel.title.save", "i18n-key"],
    ]);
    expect(result.hubs).toHaveLength(1);
    expect(result.hubs[0]).toMatchObject({ key: "order-card", kind: "css-class", hits: 30, via: "src/panel.tsx" });
    expect(result.hubs[0]?.detail).toContain("over the 20-file hub limit");
  });

  test("a failed search and keys over the key cap are reported as skipped, not as no consumers", async () => {
    const result = await findTextLinks({ diff: DIFF, changedFiles: [], search: async () => undefined, maxKeys: 2 });
    expect(result.links).toEqual([]);
    expect(result.skipped.filter((item) => item.detail.includes("could not run"))).toHaveLength(2);
    expect(result.skipped.filter((item) => item.detail.includes("key cap")).length).toBeGreaterThan(0);
  });

  test("the searchers run a fixed argv with the key after -e and the operands after --", async () => {
    const calls: string[][] = [];
    const run: TextSearchRunner = async (argv) => {
      calls.push(argv);
      return { stdout: argv[0] === "git" ? "abc123:src/a.ts\n" : "./src/a.ts\n", stderr: "", exitCode: 0 };
    };
    expect(await ripgrepSearcher("/repo", run)("--files")).toEqual(["src/a.ts"]);
    expect(await gitGrepSearcher("/repo", "abc123", run)("--files")).toEqual(["src/a.ts"]);
    expect(calls[0]).toEqual(["rg", "--fixed-strings", "--files-with-matches", "--no-messages", "-e", "--files", "--", "."]);
    expect(calls[1]).toEqual(["git", "grep", "--fixed-strings", "--files-with-matches", "-e", "--files", "abc123", "--", "."]);
    const none: TextSearchRunner = async () => ({ stdout: "", stderr: "", exitCode: 1 });
    expect(await ripgrepSearcher("/repo", none)("k")).toEqual([]);
    const broken: TextSearchRunner = async () => ({ stdout: "", stderr: "boom", exitCode: 2 });
    expect(await ripgrepSearcher("/repo", broken)("k")).toBeUndefined();
  });
});
