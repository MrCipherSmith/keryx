// Flow 389, AC9: the docs describe the digest.
//
// The guide and the CLI reference under docs/docs/ must say what a digest is, how to configure it
// (repositories, schedule, topic), that it is read-only, and what its limits are. The numbers the
// docs state are checked against the constants in the code, so the docs cannot drift from it.

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { DELIVERY_MAX_ATTEMPTS } from "../scheduler/digest-delivery";
import { DIGEST_STUCK_DAYS } from "../scheduler/digest-content";
import { DIGEST_DEFAULT_MEMORY_MB, DIGEST_DEFAULT_REPOS, DIGEST_DEFAULT_TOPIC } from "../trigger/digest-config";
import { DIGEST_TOOL_IDS } from "../trigger/granted-tools";

const REPO = path.resolve(import.meta.dir, "..", "..");
const read = (relative: string): Promise<string> => readFile(path.join(REPO, relative), "utf8");

const NUMBER_WORDS: Record<number, string> = { 7: "seven", 12: "twelve" };

/** The part of the CLI reference that is about `keryx schedule`'s digest. */
async function cliDigestSection(): Promise<string> {
  const text = await read("docs/docs/cli-reference.md");
  const start = text.indexOf("**Digest (`add --digest`).**");
  expect(start).toBeGreaterThan(0);
  const next = text.indexOf("\n## ", start);
  return text.slice(start, next > 0 ? next : start + 6000);
}

describe("AC9: the guide", () => {
  test("it exists, is titled for the task, and says what a digest is and who runs it", async () => {
    const guide = await read("docs/docs/guides/scheduled-digest.md");
    expect(guide.startsWith("# Get a GitHub and board digest on a schedule")).toBe(true);
    expect(guide).toContain("A **digest** is a scheduled task");
    expect(guide).toContain("`keryx serve` runs it");
    expect(guide).toContain("no OS timer");
    expect(guide).toContain("Telegram");
  });

  test("configuration: the repositories, the schedule and the topic, each with its flag and default", async () => {
    const guide = await read("docs/docs/guides/scheduled-digest.md");
    expect(guide).toContain("keryx schedule add --digest --name morning --every");
    expect(guide).toContain("--repo owner/name");
    expect(guide).toContain("--every");
    expect(guide).toContain("--topic");
    expect(guide).toContain("--ceiling");
    expect(guide).toContain("--max-seconds");
    expect(guide).toContain("--memory-mb");
    // the defaults the docs state are the defaults the code uses
    expect(guide).toContain(`| Repositories | \`--repo owner/name\`, repeatable | \`${DIGEST_DEFAULT_REPOS.join(", ")}\` |`);
    expect(guide).toContain(`| Topic | \`--topic <name>\` | \`${DIGEST_DEFAULT_TOPIC}\` |`);
    expect(guide).toContain(`| Memory limit | \`--memory-mb\` | ${DIGEST_DEFAULT_MEMORY_MB} |`);
    expect(guide).toContain("Only the repositories you list are ever read");
  });

  test("it says what the digest contains, including the first-run baseline and the merged-but-unchecked chains", async () => {
    const guide = await read("docs/docs/guides/scheduled-digest.md");
    for (const part of ["what changed", "what is stuck", "what needs your decision", "PR merged, flow closed, effect not checked"]) {
      expect(guide).toContain(part);
    }
    expect(guide).toContain("### The first run is a baseline");
    expect(guide).toContain("nothing changed since the last digest");
    expect(guide).toContain(`no update for ${NUMBER_WORDS[DIGEST_STUCK_DAYS]} days`);
  });

  test("delivery: the session topic, the Digest topic, the retry and the status line", async () => {
    // the guide wraps lines, so a phrase can break across a newline
    const guide = (await read("docs/docs/guides/scheduled-digest.md")).replace(/\s+/g, " ");
    expect(guide).toContain("that session's topic");
    expect(guide).toContain("service topic **Digest**");
    expect(guide).toContain(`up to ${NUMBER_WORDS[DELIVERY_MAX_ATTEMPTS]} attempts`);
    expect(guide).toContain("a status line in the topic");
    expect(guide).toContain("never opens a second");
  });

  test("the read-only guarantee names every granted tool, the allow-list, the account rule and the two commands it never runs", async () => {
    const guide = await read("docs/docs/guides/scheduled-digest.md");
    expect(guide).toContain("## The read-only guarantee");
    expect(guide).toContain("A digest cannot change anything on GitHub.");
    for (const id of DIGEST_TOOL_IDS) expect(guide).toContain(`\`${id}\``);
    expect(guide).toContain("None is `gh api`");
    expect(guide).toContain("read-only allow-list");
    expect(guide).toContain("no tools at all");
    expect(guide).toContain("`~/work/**` uses the work");
    expect(guide).toContain("everything else the personal one");
    expect(guide).toContain("A digest never runs `gh auth switch` or `gh auth login`.");
  });

  test("the limits: dollars, time and memory, and that going over one stops the run and reports it", async () => {
    const guide = await read("docs/docs/guides/scheduled-digest.md");
    const limits = guide.slice(guide.indexOf("## Limits"), guide.indexOf("## See it, pause it, run it now"));
    expect(limits).toContain("stopped and reported");
    expect(limits).toContain("**Dollars.**");
    expect(limits).toContain("--ceiling");
    expect(limits).toContain("**Time.**");
    expect(limits).toContain("--max-seconds");
    expect(limits).toContain("**Memory.**");
    expect(limits).toContain("--memory-mb");
  });

  test("how to see it, pause it, resume it and run it, in the CLI and in the shell", async () => {
    const guide = await read("docs/docs/guides/scheduled-digest.md");
    for (const command of ["keryx schedule list", "keryx schedule show morning", "keryx schedule pause morning", "keryx schedule resume morning", "keryx schedule run morning"]) {
      expect(guide).toContain(command);
    }
    expect(guide).toContain("`/schedules`");
    expect(guide).toContain("When serve was not running");
  });
});

describe("AC9: the CLI reference", () => {
  test("the schedule section documents `add --digest` with every digest flag", async () => {
    const text = await read("docs/docs/cli-reference.md");
    expect(text).toContain('keryx schedule add --digest --name <name> --every "<cadence>"');
    const section = await cliDigestSection();
    for (const flag of ["--repo", "--topic", "--memory-mb", "--max-seconds", "--ceiling", "--prompt"]) expect(section + text).toContain(flag);
    expect(section).toContain("`keryx serve`");
    expect(section).toContain("no OS timer");
    expect(section).toContain("scheduled-digest.md");
  });

  test("it states the read-only rule and that the digest never switches the gh account", async () => {
    const section = await cliDigestSection();
    expect(section).toContain("read-only");
    expect(section).toContain("`issue list|view`, `run list`");
    expect(section).toMatch(/auth switch/);
  });

  test("it says where to see the digest and how it is paused", async () => {
    const section = await cliDigestSection();
    expect(section).toContain("**Seeing it.**");
    expect(section).toContain("the last run's status");
    expect(section).toMatch(/pause/);
  });
});

describe("AC9: the guide is reachable", () => {
  test("mkdocs.yml has it in the navigation, and the index and the command table link to it", async () => {
    expect(await read("mkdocs.yml")).toContain("Get a GitHub and board digest on a schedule: guides/scheduled-digest.md");
    expect(await read("docs/docs/index.md")).toContain("(guides/scheduled-digest.md)");
    const byTask = await read("docs/docs/commands-by-task.md");
    expect(byTask).toContain("`add --digest`");
    expect(byTask).toContain("keryx serve");
  });

  test("the limitations page names the one exception to 'keryx runs no daemon'", async () => {
    const limitations = await read("docs/docs/limitations.md");
    expect(limitations).toContain("The one exception is a digest (`keryx schedule add --digest`)");
    expect(limitations).toContain("keryx serve");
  });

  test("every relative link in the guide points at a file that exists", async () => {
    const guide = await read("docs/docs/guides/scheduled-digest.md");
    const links = [...guide.matchAll(/\]\(([^)#]+?\.md)(#[^)]*)?\)/g)].map((m) => m[1]!);
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      const target = path.join(REPO, "docs", "docs", "guides", link);
      expect({ link, exists: await Bun.file(target).exists() }).toEqual({ link, exists: true });
    }
  });
});
