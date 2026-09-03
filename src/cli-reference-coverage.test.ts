import { readFile } from "node:fs/promises";
import { expect, test } from "bun:test";
import { CLI_ROUTES } from "./cli";

// Documentation drift is invisible to every check this repository already
// runs. `check:doc-links` proves a relative link resolves; `mkdocs build
// --strict` proves the nav is complete and no internal link is dead. Both are
// green on a page that documents a flag the CLI does not have, and both are
// green on a CLI verb no page mentions at all.
//
// The 2026-09-03 documentation review (docs/requirements/keryx-docs-remediation/)
// found `job` and `sandbox` shipping with no section in a file titled "Every
// command, subcommand, flag, and exit code". These tests close that by deriving
// the expectation from the code — `CLI_ROUTES` and the mkdocs nav — so the next
// verb added without a section fails here rather than shipping.

const CLI_REFERENCE = new URL("../docs/docs/cli-reference.md", import.meta.url);
const DOCS_INDEX = new URL("../docs/docs/index.md", import.meta.url);
const MKDOCS = new URL("../mkdocs.yml", import.meta.url);

// Verbs that are deliberately not their own section, each with the reason.
// This list is the place to argue about coverage; silence is not.
const DOCUMENTED_ELSEWHERE = new Map<string, string>([
  // Aliases of a verb that does have a section.
  ["dash", "covered by `## dashboard (and `dash`)`"],
  ["session", "alias of `sessions`"],
]);

async function sectionHeadings(): Promise<Set<string>> {
  const source = await readFile(CLI_REFERENCE, "utf8");
  const headings = new Set<string>();
  for (const match of source.matchAll(/^## +(.+)$/gm)) {
    const title = match[1];
    if (title === undefined) continue;
    // `## dashboard (and `dash`)` and `## shell behavior` both start with the
    // verb; take the first word and strip any backticks around it.
    const first = title.trim().split(/\s+/)[0];
    if (first !== undefined) headings.add(first.replace(/`/g, ""));
  }
  return headings;
}

test("every top-level CLI verb has a section in the CLI reference", async () => {
  const headings = await sectionHeadings();

  // Guards the scrape: a heading-format change that matches nothing would make
  // the assertion below compare an empty set and pass while checking nothing.
  expect(headings.size).toBeGreaterThan(20);

  const undocumented = Object.keys(CLI_ROUTES)
    .filter((verb) => !headings.has(verb))
    .filter((verb) => !DOCUMENTED_ELSEWHERE.has(verb));

  expect(undocumented).toEqual([]);
});

// The reference documented `orient` at length while `keryx` with no arguments
// listed it nowhere — neither in the usage block nor in the Commands
// descriptions — so a user could only find it by already knowing it existed.
// The banner is a separate surface from the reference and needs its own check;
// `printHelp` is a template literal, so this reads the source rather than
// capturing stdout.
test("the top-level usage banner names every verb the CLI reference documents", async () => {
  const [source, reference] = await Promise.all([
    readFile(new URL("./cli.ts", import.meta.url), "utf8"),
    readFile(CLI_REFERENCE, "utf8"),
  ]);

  const banner = source.slice(source.indexOf("function printHelp"));
  expect(banner.length).toBeGreaterThan(1000);

  const documented = Object.keys(CLI_ROUTES).filter(
    (verb) => !DOCUMENTED_ELSEWHERE.has(verb) && reference.includes(`\n## ${verb}`),
  );
  expect(documented.length).toBeGreaterThan(20);

  expect(documented.filter((verb) => !banner.includes(`keryx ${verb}`)).sort()).toEqual([]);
});

test("the documented-elsewhere allowance never hides a verb that has no section", async () => {
  // An allow-list is only honest while each entry is still true. `dash` and
  // `session` are excused because another section covers them — if that
  // section disappears, the excuse has to disappear with it.
  const source = await readFile(CLI_REFERENCE, "utf8");
  expect(source).toMatch(/^## dashboard/m);
  expect(source).toMatch(/^## sessions/m);
});

// A blank line between two rows ENDS a Markdown table. The module map in
// architecture.md had one between its `sac` and `harness` rows, so eight rows
// rendered on the site as a second, headerless table — visible to a reader,
// invisible to `mkdocs build --strict`, which validates links and nav, and
// invisible to `check:doc-links`, which validates links only.
//
// Asserting contiguity here is stronger than the one-time visual check this
// replaces: a rendered-output inspection confirms today's build, and this
// fails on the next stray blank line instead.
test("the architecture module map is one contiguous table", async () => {
  const lines = (await readFile(new URL("../docs/docs/architecture.md", import.meta.url), "utf8")).split("\n");

  const start = lines.findIndex((line) => line.startsWith("| Module | Directory | CLI verb | Role |"));
  expect(start).toBeGreaterThan(-1);

  // Span to the LAST row before the next section heading, not to the end of the
  // first unbroken run. Walking the unbroken run is what a split table looks
  // like from the inside — it simply stops early and every line it did see
  // starts with `|`, so the assertion passes on exactly the defect it is meant
  // to catch. (Written that way first; the mutation caught it.)
  const nextHeading = lines.findIndex((line, i) => i > start && line.startsWith("## "));
  const region = lines.slice(start, nextHeading);
  let last = 0;
  region.forEach((line, i) => {
    if (line.startsWith("|")) last = i;
  });

  // The map is long; a table that "ends" after two rows means the scrape found
  // the header of something else.
  expect(last).toBeGreaterThan(20);

  expect(region.slice(0, last + 1).filter((line) => !line.startsWith("|"))).toEqual([]);
});

// `workspace` is the verb whose reference section drifted furthest: five of its
// seventeen subcommands were undocumented, including `confirm-review`'s
// `--acknowledge-security` — the human acknowledgement gate for a
// security-flagged proposal, so an operator hitting that refusal had no
// documented way forward. Deriving from the router means the next subcommand
// added is documented or the suite says so.
test("the CLI reference documents every keryx workspace subcommand", async () => {
  const [router, reference] = await Promise.all([
    readFile(new URL("./commands/workspace.ts", import.meta.url), "utf8"),
    readFile(CLI_REFERENCE, "utf8"),
  ]);

  const dispatched = new Set<string>();
  for (const match of router.matchAll(/subcommand === "([a-z][a-z-]*)"/g)) {
    const name = match[1];
    if (name !== undefined && name !== "help") dispatched.add(name);
  }
  expect(dispatched.size).toBeGreaterThan(10);

  const section = reference.slice(reference.indexOf("\n## workspace\n"));
  expect(section.length).toBeGreaterThan(500);

  expect([...dispatched].filter((name) => !section.includes(`workspace ${name}`)).sort()).toEqual([]);

  // The flag, specifically: it is the one whose absence left a refusal with no
  // documented exit, so it gets its own assertion rather than riding along.
  expect(section).toContain("--acknowledge-security");
});

test("the docs index lists exactly the guides the mkdocs nav publishes", async () => {
  const [index, mkdocs] = await Promise.all([readFile(DOCS_INDEX, "utf8"), readFile(MKDOCS, "utf8")]);

  const navGuides = new Set(Array.from(mkdocs.matchAll(/guides\/([a-z0-9-]+\.md)/g), (m) => m[1]));
  const indexGuides = new Set(Array.from(index.matchAll(/guides\/([a-z0-9-]+\.md)/g), (m) => m[1]));

  // Same scrape guard as above.
  expect(navGuides.size).toBeGreaterThan(5);

  expect([...indexGuides].sort()).toEqual([...navGuides].sort());
});
