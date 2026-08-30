// Flow 206 — the loop, run end to end rather than described.
//
// WHY THIS SUITE EXISTS AND A UNIT TEST DOES NOT REPLACE IT
//
// The subject of this flow is a JOIN. Both halves already worked: `review
// comments collect` wrote a durable record, and `skills learn` / `skills learn
// apply` turned a file into a proposal and a proposal into a lesson. What did not
// exist was anything connecting "comments by these people" to "teach this skill",
// and a unit test over a hand-built proposal cannot see a missing join — it
// builds, by hand, the very artifact whose production is in question.
//
// So every test here starts from GitHub fixtures and ends at the project's
// `SKILL.md` on disk:
//
//   collect (from fixtures) → filter by configured author → propose → apply
//
// Break any link — drop the body from the record, stop reading the config, stop
// filtering, stop forwarding the skill — and a named test below goes red.

import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { reviewCommand } from "./review";
import { skillsCommand } from "./skills";

const ORIGINAL_CWD = process.cwd();
const realLog = console.log;
const realError = console.error;

const SHA = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

/** The configured author. Their text must reach the skill. */
const TEACHER = "reviewer-we-named";
/** The unconfigured author. Their text must reach nothing. */
const STRANGER = "someone-else-entirely";

/**
 * Two sentences, so the split that keeps long comments usable is exercised, and
 * a phrase unique enough that finding it anywhere is proof it travelled.
 */
const TEACHER_COMMENT =
  "This must never swallow the error, because a caller that cannot tell failure " +
  "from an empty result will branch on the wrong one. Use a typed result and check it at the call site.";

const STRANGER_COMMENT =
  "You should rename this variable to quokka, because the current name is far too long for my taste.";

let ROOT = "";
let logs: string[] = [];

function output(): string {
  return logs.join("\n");
}

type FixtureOptions = {
  /** Written only when defined — an absent config is the "does not learn" case. */
  config?: Record<string, unknown> | undefined;
  /** Both authors comment by default. */
  comments?: Array<{ author: string; body: string }> | undefined;
};

async function project(options: FixtureOptions = {}): Promise<void> {
  ROOT = await mkdtemp(path.join(tmpdir(), "keryx-review-learn-"));
  const comments = options.comments ?? [
    { author: TEACHER, body: TEACHER_COMMENT },
    { author: STRANGER, body: STRANGER_COMMENT },
  ];

  // --- the GitHub fixtures `collect` reads instead of the network ---
  await writeFile(
    path.join(ROOT, "pull-comments.json"),
    JSON.stringify(
      comments.map((comment, index) => ({
        id: index + 1,
        user: { login: comment.author },
        body: comment.body,
        html_url: `https://github.com/o/r/pull/7#discussion_r${index + 1}`,
        path: "src/a.ts",
        line: 3 + index,
        created_at: "2026-08-30T00:00:00Z",
      })),
    ),
    "utf8",
  );
  await writeFile(path.join(ROOT, "pull-reviews.json"), "[]", "utf8");
  await writeFile(path.join(ROOT, "issue-comments.json"), "[]", "utf8");

  // --- the project ---
  //
  // TWO registered project skills, not one, and that is load-bearing.
  // `learnProjectSkill` falls back to `registry[0]` when a registry holds exactly
  // one entry, so with a single skill the configured `skill` could be dropped on
  // the floor and every assertion here would still pass — the fallback would
  // land on the same target by luck. With two, only the config can choose.
  for (const [module, name] of [
    ["alpha", "module"],
    ["beta", "other"],
  ]) {
    const skillRoot = path.join(ROOT, ".metaproject", "project-skills", module as string, name as string);
    await mkdir(skillRoot, { recursive: true });
    await writeFile(
      path.join(skillRoot, "SKILL.md"),
      [`# ${module} ${name}`, "", "Version: 0.1.0", `Module: ${module}`, `Target: src/${module}`, "", "## Review Lessons", "", "- No review lessons recorded yet.", ""].join("\n"),
      "utf8",
    );
    await writeFile(path.join(skillRoot, "skill-changelog.md"), "# Changelog\n", "utf8");
  }
  await writeFile(
    path.join(ROOT, ".metaproject", "metaproject.json"),
    JSON.stringify({
      modules: {
        gdskills: {
          projectSkillRegistry: [
            {
              module: "alpha",
              name: "module",
              target: "src/alpha",
              path: ".metaproject/project-skills/alpha/module",
              version: "0.1.0",
              status: "active",
              updatedAt: "2026-08-30T00:00:00.000Z",
            },
            {
              module: "beta",
              name: "other",
              target: "src/beta",
              path: ".metaproject/project-skills/beta/other",
              version: "0.1.0",
              status: "active",
              updatedAt: "2026-08-30T00:00:00.000Z",
            },
          ],
        },
      },
    }),
    "utf8",
  );

  if (options.config !== undefined) {
    await writeFile(
      path.join(ROOT, ".metaproject", "review-learning.config.json"),
      JSON.stringify(options.config, null, 2),
      "utf8",
    );
  }

  process.chdir(ROOT);
  logs = [];
  console.log = (...args: unknown[]) => void logs.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => void logs.push(args.map(String).join(" "));
}

const CONFIG = { schemaVersion: 1, skill: "alpha/module", repo: "o/r", authors: [TEACHER] };

async function collect(): Promise<void> {
  await reviewCommand(["comments", "collect", "--repo", "o/r", "--pr", "7", "--self", "us", "--sha", SHA, "--fixtures", ROOT]);
}

async function learn(extra: string[] = []): Promise<void> {
  await reviewCommand(["learn", "--pr", "7", ...extra]);
}

function proposalPath(): string {
  const line = logs.find((entry) => entry.startsWith("Proposal: "));
  if (line === undefined) throw new Error(`no proposal in output:\n${output()}`);
  return line.slice("Proposal: ".length);
}

async function skillMd(): Promise<string> {
  return readFile(path.join(ROOT, ".metaproject", "project-skills", "alpha", "module", "SKILL.md"), "utf8");
}

afterEach(async () => {
  console.log = realLog;
  console.error = realError;
  process.chdir(ORIGINAL_CWD);
  process.exitCode = 0;
  if (ROOT) {
    await rm(ROOT, { recursive: true, force: true });
    ROOT = "";
  }
});

// --- AC9: the whole loop -----------------------------------------------------

test("AC9: collect → filter → propose → apply puts the configured author's lesson in the local SKILL.md and bumps the version", async () => {
  await project({ config: CONFIG });

  await collect();
  await learn();
  await skillsCommand(["learn", "apply", proposalPath()]);

  const skill = await skillMd();
  // The lesson travelled from a GitHub fixture, through the durable record, a
  // filter, a proposal and an apply, into the file an agent reads.
  expect(skill).toContain("must never swallow the error");
  expect(skill).toContain("Version: 0.1.1");
  expect(skill).not.toContain("- No review lessons recorded yet.");

  const changelog = await readFile(
    path.join(ROOT, ".metaproject", "project-skills", "alpha", "module", "skill-changelog.md"),
    "utf8",
  );
  expect(changelog).toContain("0.1.1");
  expect(changelog).toContain("review");

  // The OTHER registered skill is untouched. A lesson that landed in both, or in
  // the wrong one, would still satisfy every assertion above.
  const other = await readFile(
    path.join(ROOT, ".metaproject", "project-skills", "beta", "other", "SKILL.md"),
    "utf8",
  );
  expect(other).toContain("Version: 0.1.0");
  expect(other).not.toContain("must never swallow the error");
});

test("the target skill comes from the config, not from whichever skill happens to be first", async () => {
  // Guards the forwarding of `config.skill` into `learnProjectSkill`. Dropping it
  // is invisible in a one-skill project — the resolver falls back to the only
  // entry — so the config here names the SECOND registered skill, which no
  // fallback would reach.
  await project({ config: { ...CONFIG, skill: "beta/other" } });

  await collect();
  await learn();
  await skillsCommand(["learn", "apply", proposalPath()]);

  expect(
    await readFile(path.join(ROOT, ".metaproject", "project-skills", "beta", "other", "SKILL.md"), "utf8"),
  ).toContain("must never swallow the error");
  expect(await skillMd()).toContain("Version: 0.1.0");
});

// --- AC5: an unconfigured author contributes nothing -------------------------

test("AC5: the unconfigured author's text appears in no proposal, no source, and no SKILL.md", async () => {
  await project({ config: CONFIG });

  await collect();
  await learn();
  await skillsCommand(["learn", "apply", proposalPath()]);

  const quokka = "quokka";
  const files = [
    path.join(ROOT, proposalPath()),
    path.join(ROOT, ".metaproject", "data", "gdskills", "learning-sources", "o__r__7.json"),
    path.join(ROOT, ".metaproject", "data", "gdskills", "learning-sources", "o__r__7.md"),
    path.join(ROOT, ".metaproject", "project-skills", "alpha", "module", "SKILL.md"),
  ];
  for (const file of files) {
    expect(await readFile(file, "utf8")).not.toContain(quokka);
  }

  // And the exclusion is REPORTED rather than silent: a filter nobody can see is
  // indistinguishable from a reviewer nobody read.
  expect(output()).toContain("1 excluded as unconfigured");

  // The record does hold the stranger's comment — the filter is in the learning
  // pass, not in the collection. Answering a comment and learning from it are
  // different questions and only the second one is configured.
  const state = await readFile(path.join(ROOT, ".metaproject", "reviews", "pr-comments", "o__r__7.json"), "utf8");
  expect(state).toContain(quokka);
});

test("AC5: with only the unconfigured author commenting, nothing is proposed at all", async () => {
  await project({ config: CONFIG, comments: [{ author: STRANGER, body: STRANGER_COMMENT }] });

  await collect();
  await learn();

  expect(output()).toContain("nothing to learn");
  expect(output()).not.toContain("Created learning proposal");
  expect(process.exitCode).toBe(0);
});

// --- AC3: absence is not an error --------------------------------------------

test("AC3: a project with no config does not learn, exits 0, and prints no warning", async () => {
  await project();

  await collect();
  await learn();

  expect(process.exitCode).toBe(0);
  expect(output()).toContain("does not learn from pull-request comments");
  // A supported state must not be announced as a problem, or the next real
  // warning is the one that gets skipped.
  expect(output().toLowerCase()).not.toContain("warning");
  expect(output().toLowerCase()).not.toContain("error");
});

test("AC3: a present-but-broken config is refused rather than defaulted past", async () => {
  await project({ config: { schemaVersion: 1, skill: "alpha/module", repo: "o/r", authors: [] } });

  await learn();

  expect(output()).toContain("must name at least one login");
  expect(process.exitCode).toBe(1);
});

// --- AC4: the record is the source; GitHub is not consulted ------------------

test("AC4: learning reads the collected record and never fetches — no fixtures, no port, no network", async () => {
  await project({ config: CONFIG });
  await collect();

  // `learn` takes no --fixtures and resolves no GitHub port. If it re-fetched, it
  // would need one of the two, and this call would fail rather than succeed.
  await learn();

  expect(output()).toContain("Created learning proposal");
  expect(output()).toContain("1 used");
});

test("AC4: learning a pull request nobody collected is refused, not reported as an empty pass", async () => {
  await project({ config: CONFIG });

  await reviewCommand(["learn", "--pr", "9"]);

  expect(output()).toContain("No collected comments for o/r#9");
  expect(output()).toContain("keryx review comments collect");
  expect(process.exitCode).toBe(1);
});

// --- AC6: proposing writes nothing into the skill ----------------------------

test("AC6: the proposal alone changes no skill — apply is still the only writer", async () => {
  await project({ config: CONFIG });

  await collect();
  await learn();

  const skill = await skillMd();
  expect(skill).toContain("Version: 0.1.0");
  expect(skill).not.toContain("must never swallow the error");
  expect(output()).toContain("Nothing was written to the skill.");
});

// --- the flag surface --------------------------------------------------------

test("--authors is refused: a flag would make the configured list a default", async () => {
  await project({ config: CONFIG });
  await collect();

  await reviewCommand(["learn", "--pr", "7", "--authors", STRANGER]);

  expect(output()).toContain("--authors");
  expect(process.exitCode).toBe(1);
  // And nothing of the stranger's leaked while the flag was being refused.
  const source = path.join(ROOT, ".metaproject", "data", "gdskills", "learning-sources", "o__r__7.json");
  await expect(readFile(source, "utf8")).rejects.toThrow();
});
