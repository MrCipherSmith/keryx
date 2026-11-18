import { expect, test } from "bun:test";
import { buildEnrichArgs, commandLine, DEFAULT_ENRICH, previewGroupsArgs, PROJECT_COMMANDS, type EnrichSettings } from "./projectCommands";

const s = (over: Partial<EnrichSettings> = {}): EnrichSettings => ({ ...DEFAULT_ENRICH, ...over });

test("the default settings run waves of 10-20 related pages, provider and model from auth.json", () => {
  expect(buildEnrichArgs(DEFAULT_ENRICH)).toEqual({
    ok: true,
    args: ["wiki", "enrich", "--all", "--group", "related", "--group-size", "10-20", "--concurrency", "4"],
  });
});

test("one job runs the whole batch in one worker, with no grouping flags", () => {
  expect(buildEnrichArgs(s({ mode: "one", concurrency: 12, groupMin: 3 }))).toEqual({ ok: true, args: ["wiki", "enrich", "--all"] });
});

test("force, provider and model are passed through", () => {
  const r = buildEnrichArgs(s({ scope: "force", provider: "anthropic", model: "claude-haiku-5-5", groupMin: 5, groupMax: 8, concurrency: 16 }));
  expect(r).toEqual({
    ok: true,
    args: [
      "wiki", "enrich", "--all", "--force",
      "--group", "related", "--group-size", "5-8", "--concurrency", "16",
      "--provider", "anthropic", "--model", "claude-haiku-5-5",
    ],
  });
});

test("blank provider and model are left to the CLI", () => {
  const r = buildEnrichArgs(s({ mode: "one", provider: "  ", model: "" }));
  expect(r).toEqual({ ok: true, args: ["wiki", "enrich", "--all"] });
});

test("ollama-style model names with a colon or slash are accepted", () => {
  const r = buildEnrichArgs(s({ mode: "one", provider: "ollama", model: "qwen3:8b" }));
  expect(r.ok && r.args.slice(-4)).toEqual(["--provider", "ollama", "--model", "qwen3:8b"]);
  expect(buildEnrichArgs(s({ mode: "one", model: "org/model-v1" })).ok).toBe(true);
});

test("invalid settings are refused with a reason", () => {
  const bad: Array<[Partial<EnrichSettings>, RegExp]> = [
    [{ workers: "external" }, /External agents/],
    [{ groupMin: 21, groupMax: 20 }, /smallest group/],
    [{ groupMin: 0 }, /1 or more/],
    [{ groupMax: 2.5 }, /whole numbers/],
    [{ concurrency: 17 }, /At most 16/],
    [{ concurrency: 0 }, /1 or more/],
    [{ provider: "--force" }, /provider/],
    [{ model: "a b" }, /model/],
    [{ model: "x;rm -rf ~" }, /model/],
  ];
  for (const [over, why] of bad) {
    const r = buildEnrichArgs(s(over));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(why);
  }
});

test("group sizes and concurrency do not matter in one-job mode", () => {
  expect(buildEnrichArgs(s({ mode: "one", groupMin: 50, groupMax: 2, concurrency: 99 })).ok).toBe(true);
});

test("the groups preview lists the same selection and runs nothing", () => {
  expect(previewGroupsArgs(s({ mode: "one", scope: "force", groupMin: 4, groupMax: 6 }))).toEqual({
    ok: true,
    args: ["wiki", "enrich", "--list", "--force", "--group", "related", "--group-size", "4-6"],
  });
  expect(previewGroupsArgs(s({ groupMin: 9, groupMax: 3 })).ok).toBe(false);
});

test("commandLine shows the argv as a shell would read it", () => {
  expect(commandLine(["wiki", "enrich", "--all", "--group-size", "10-20"])).toBe("keryx wiki enrich --all --group-size 10-20");
  expect(commandLine(["a b", "it's"])).toBe(`keryx 'a b' 'it'\\''s'`);
});

test("the menu covers init, update and the wiki commands, each with unique ids", () => {
  const ids = PROJECT_COMMANDS.map((c) => c.id);
  expect(new Set(ids).size).toBe(ids.length);
  const lines = PROJECT_COMMANDS.map((c) => c.args.join(" "));
  for (const want of ["init", "update", "wiki status", "wiki validate", "wiki index"]) expect(lines.includes(want)).toBe(true);
  // Enrich has its own dialog, not a bare menu entry.
  expect(PROJECT_COMMANDS.some((c) => c.args.includes("enrich"))).toBe(false);
});
