// One rubric, one set of laws — and a guard that a reviewer added later cannot
// ship without them.
//
// WHAT "PRESENT" MEANS HERE, AND WHY IT WILL NOT ROT
//
// The obvious test is a literal string match against the three laws. It rots on
// the first edit: the day someone improves a word, fourteen files and one test
// have to move together, and the cheapest way to make a red test green is to
// weaken the test. A test that rots is worse than no test, because it is still
// counted as coverage while it is being routed around.
//
// So this test hardcodes none of the law text. It derives the three laws from
// the canonical block in `review-orchestrator/SKILL.md` and asserts every
// reviewer carries them, whitespace-normalised. Consequences:
//
//   - Rewording the laws is free — reword the canonical block, propagate, done.
//     The test has no opinion about the words.
//   - Rewording ONE reviewer fails. That is the defect this flow removed: two
//     wordings of one rule in one tree.
//   - A new reviewer with no laws fails, because the denominator comes from the
//     filesystem (`readdirSync`) and the complement must be empty — the same
//     construction as `review-skills-class-scope.test.ts` next door.
//
// The derived check has one hole: it cannot tell whether the canonical block
// still says the three things AC3 named, only that everyone agrees with it.
// Delete law 2 and duplicate law 1 and the derived check stays green. So there is
// a second, deliberately small layer — a semantic floor applied to the CANONICAL
// TEXT ONLY, one file, matching each law by the concept it cannot lose without
// changing meaning. Brittleness is confined to one place instead of spread across
// fourteen, which is the trade this whole flow is about.

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const REVIEW_ROOT = path.join(import.meta.dir, "bundled", "skills", "review");
const CANONICAL = "review-orchestrator";
const SHARED_HEADING = "### Shared laws (every reviewer)";

/**
 * Reviewers that must NOT carry the laws, each with the reason. Same set and
 * same reasons as `review-skills-class-scope.test.ts`: a reviewer that has no
 * findings of its own has nothing for these laws to govern.
 */
const EXEMPT: Record<string, string> = {
  "code-ai-review":
    "legacy opt-in profile (--legacy-profiles); emits a free-prose Russian report with no per-finding severity field, and carries four per-editor SKILL variants that would all have to be kept in step",
  "code-learned-review": "legacy opt-in profile; same free-prose shape as code-ai-review",
  "code-mobx-store-review":
    "legacy opt-in profile; does not use the blocker/major vocabulary at all",
  "code-style-review": "legacy opt-in profile; does not use the blocker/major vocabulary at all",
  "review-pr-feedback":
    "classifies INCOMING human PR comments by severity; it reports on other people's findings and produces none of its own, so it has no finding for these laws to govern",
  "review-verifier":
    "checks findings raised by other reviewers and can only DELETE — it cannot add a finding, raise a severity, or change a finding's text, enforced in src/review/verification.ts — so there is no finding of its own to hold to the laws",
};

function read(name: string): string {
  return readFileSync(path.join(REVIEW_ROOT, name, "SKILL.md"), "utf8");
}

function reviewerSkills(): string[] {
  return readdirSync(REVIEW_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => existsSync(path.join(REVIEW_ROOT, name, "SKILL.md")))
    .sort();
}

/** Whitespace is layout, not meaning: line wrapping must not be part of the contract. */
function normalise(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** The three laws, taken from the canonical block. No literal lives in this file. */
function canonicalLaws(): string[] {
  const text = read(CANONICAL);
  const start = text.indexOf(SHARED_HEADING);
  if (start === -1) return [];
  const section = text.slice(start + SHARED_HEADING.length);
  // The contiguous ordered list that opens the section, up to the first blank line.
  const list = section.match(/^\d+\. [\s\S]*?(?=\n\n)/m);
  if (list === null) return [];
  return list[0]
    .split(/\n(?=\d+\. )/)
    .map((item) => normalise(item.replace(/^\d+\.\s*/, "")))
    .filter((item) => item.length > 0);
}

describe("the canonical severity rubric exists and is the only one", () => {
  const orchestrator = read(CANONICAL);

  test("the rubric lives in review-orchestrator", () => {
    expect(orchestrator).toContain("## Severity (canonical)");
    expect(orchestrator).toMatch(/only severity rubric in the review domain/i);
  });

  test("`blocker` is enumerated as merge-blocking only", () => {
    // AC1 fixes the four shapes; each has to be findable, or "merge-blocking"
    // becomes whatever the reader already believed.
    const section = orchestrator.slice(orchestrator.indexOf("## Severity (canonical)"));
    expect(section).toMatch(/crash/i);
    expect(section).toMatch(/data loss or corruption/i);
    expect(section).toMatch(/exploitable vulnerability/i);
    expect(section).toMatch(/unimplemented acceptance criterion/i);
    expect(section).toMatch(/everything else is at most `major`/i);
  });

  test("the major/minor boundary is stated as a test someone else can apply", () => {
    const section = orchestrator.slice(orchestrator.indexOf("## Severity (canonical)"));
    expect(section).toMatch(/trigger/i);
    expect(section).toMatch(/observable outcome/i);
    // The boundary is decidable only because it is asked of the FINDING — a test
    // that required reading the code would be a test only the author can run.
    expect(section).toMatch(/of the \*\*finding\*\*, not of the code/i);
  });

  test("no reviewer keeps a severity-definition table of its own", () => {
    // AC1: deleted, not left alongside. Two rubrics in a tree is the same defect
    // as one rubric nobody follows.
    const rival = /\|\s*Severity\s*\|\s*(When to use|Meaning)\s*\|/;
    const offenders = reviewerSkills().filter((name) => rival.test(read(name)));
    expect(offenders).toEqual([]);
  });
});

describe("the three shared laws are derived from the canonical block", () => {
  const laws = canonicalLaws();

  test("the canonical block yields exactly three laws", () => {
    // If this ever reads 0, every assertion below passes vacuously.
    expect(laws.length).toBe(3);
  });

  test("the canonical laws still say the three things AC3 named", () => {
    // The semantic floor. One file, so rewording costs one edit here — not
    // fourteen. Each concept is matched by the term it cannot lose without
    // becoming a different rule, with the plausible synonyms allowed.
    const concepts: { name: string; matches: (law: string) => boolean }[] = [
      {
        name: "no reproducible path → info",
        matches: (l) => /reproduc\w*/i.test(l) && /\binfo\b/i.test(l),
      },
      {
        name: "never flag the theoretical",
        matches: (l) => /theoretic\w*|hypothetic\w*|speculat\w*/i.test(l),
      },
      {
        name: "group repeats into one finding",
        matches: (l) => /(one finding|once)/i.test(l) && /(site|occurrence|repeat|class)/i.test(l),
      },
    ];
    // Every concept is covered, and no two concepts collapse onto the same law —
    // which is what deleting one law and duplicating another would look like.
    const claimed = concepts.map((c) => laws.findIndex(c.matches));
    expect(claimed).not.toContain(-1);
    expect(new Set(claimed).size).toBe(concepts.length);
  });

  test("the security-only law is not among the shared three", () => {
    // AC3: the attack-vector law does not generalise. A style reviewer has no
    // attacker, and a preamble that reads as noise is a preamble that gets skipped.
    for (const law of laws) expect(law).not.toMatch(/attack vector/i);
  });
});

describe("every reviewer carries the shared laws", () => {
  const all = reviewerSkills();
  const laws = canonicalLaws();

  test("the denominator comes from the filesystem and is not empty", () => {
    expect(all.length).toBeGreaterThan(15);
  });

  test("every exemption names a real skill", () => {
    // A stale exemption silently covers nothing — or, after a rename, the wrong thing.
    for (const name of Object.keys(EXEMPT)) expect(all).toContain(name);
  });

  test("no reviewer is missing a law", () => {
    const missing: string[] = [];
    for (const name of all) {
      if (EXEMPT[name] !== undefined) continue;
      const text = normalise(read(name));
      for (const [index, law] of laws.entries()) {
        if (!text.includes(law)) missing.push(`${name}: law ${index + 1}`);
      }
    }
    expect(missing).toEqual([]);
  });

  test("each reviewer states the laws under a heading, not buried in prose", () => {
    const unheaded = all
      .filter((name) => EXEMPT[name] === undefined)
      .filter((name) => !read(name).includes(SHARED_HEADING));
    expect(unheaded).toEqual([]);
  });

  test("the fourth law stays in review-security-code and only there", () => {
    const carriers = reviewerSkills().filter((name) =>
      read(name).includes("### Security-specific law"),
    );
    expect(carriers).toEqual(["review-security-code"]);
    expect(read("review-security-code")).toMatch(/does not generalise/i);
  });
});

describe("one condition, one severity, across the reviewer set (AC2)", () => {
  const all = reviewerSkills();

  test("`@ts-ignore` carries exactly one severity, and it is `minor`", () => {
    // The known contradiction: `minor` in review-backend, `major` in the deleted
    // review-strict. Verified by search over the set rather than asserted.
    const assignments: { skill: string; severity: string }[] = [];
    for (const name of all) {
      for (const line of read(name).split("\n")) {
        if (!line.includes("@ts-ignore")) continue;
        const severity = line.match(/`(blocker|major|minor|info)`|\*\*(blocker|major|minor|info)\*\*/);
        if (severity !== null) {
          assignments.push({ skill: name, severity: severity[1] ?? severity[2] ?? "" });
        }
      }
    }
    expect(assignments.length).toBeGreaterThan(0);
    expect([...new Set(assignments.map((a) => a.severity))]).toEqual(["minor"]);
  });

  test("the `@ts-ignore` reasoning is recorded where the rule lives", () => {
    const backend = read("review-backend");
    expect(backend).toMatch(/one severity for this condition, repo-wide/i);
    expect(backend).toContain("review-strict");
  });

  test("conditions two reviewers both name carry identical wording", () => {
    // Where two reviewers rate the same condition, they share the clause
    // verbatim. Paraphrase is how the severities drifted apart the first time,
    // so the clause — not the severity word — is what is pinned.
    const shared: { clause: string; skills: string[] }[] = [
      {
        clause:
          "`blocker` **if** the interleaving can corrupt or lose data; otherwise `major`",
        skills: ["review-logic", "review-highload"],
      },
      {
        clause:
          "`major` — `blocker` only if the caller then persists or returns wrong data",
        skills: ["review-logic", "review-clean-code"],
      },
    ];
    const drifted: string[] = [];
    for (const { clause, skills } of shared) {
      for (const name of skills) {
        if (!normalise(read(name)).includes(normalise(clause))) {
          drifted.push(`${name}: ${clause.slice(0, 40)}…`);
        }
      }
    }
    expect(drifted).toEqual([]);
  });

  test("a layer violation is `major` in both reviewers that rate it", () => {
    // review-frontend called an API call in a component `blocker`;
    // review-architecture called the same condition `major`.
    expect(read("review-frontend")).toContain(
      "- API call in a component (hook, handler, useEffect) — **major**",
    );
    expect(read("review-frontend")).not.toMatch(/API call in a component[^\n]*\*\*blocker\*\*/);
    expect(read("review-architecture")).toMatch(
      /API\/IO call in a component[\s\S]{0,200}\| `major` \|/,
    );
  });

  test("no reviewer exempts itself from a law it also carries", () => {
    // The presence check is `includes(law)`, so a reviewer can carry all three
    // laws verbatim and then negate one in the next paragraph. A review proved
    // it: appending "Exception for this reviewer: law 1 does not apply to style
    // findings" to `review-style` left the whole suite green. That reintroduces
    // exactly the defect these laws removed — two rulings on one rule in one
    // tree — so an override is refused by shape rather than by wording.
    // The first version of this guard matched the bare word "exception" and fired
    // on three lines in `review-frontend` that AFFIRM the laws — "No exception for
    // small stores", "unless it violates an Iron Law. It never overrides…". A check
    // that fires on the text it exists to protect is worse than no check, so the
    // negation must be tied to a law by name, and the window ends at the next
    // heading rather than running 2000 characters into unrelated prose.
    const OVERRIDE =
      /\b(law\s*\d|these laws|this law|the shared laws)\b[^.]{0,120}\b(do(?:es)? not apply|is waived|are waived|may be ignored|exempt)\b|\b(exception|exempt)\b[^.]{0,120}\b(law\s*\d|these laws|this law|the shared laws)\b/i;
    const offenders: string[] = [];
    for (const name of reviewerSkills()) {
      if (name in EXEMPT) continue;
      const text = read(name);
      const at = text.indexOf(SHARED_HEADING);
      if (at === -1) continue;
      const rest = text.slice(at + SHARED_HEADING.length);
      const nextHeading = rest.search(/\n#{2,3} /);
      const window = nextHeading === -1 ? rest : rest.slice(0, nextHeading);
      if (OVERRIDE.test(window)) {
        offenders.push(`${name}: a law is exempted inside the shared-laws block`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the installed mirror carries the same laws as the bundled source", () => {
    // REVIEW_ROOT is the bundled tree only. `.metaproject/skills/gdskills/review/`
    // is what an agent actually reads, and nothing tested it — so the laws could
    // be correct at the source and absent where they are used. No live
    // divergence today; this makes that a build failure rather than a discovery.
    const mirrorRoot = path.join(import.meta.dir, "..", "..", ".metaproject", "skills", "gdskills", "review");
    if (!existsSync(mirrorRoot)) {
      return; // a checkout without an installed metaproject is not a failure
    }
    const drifted: string[] = [];
    for (const name of reviewerSkills()) {
      const mirrored = path.join(mirrorRoot, name, "SKILL.md");
      if (!existsSync(mirrored)) continue; // profile-only skills are not installed
      if (normalise(readFileSync(mirrored, "utf8")) !== normalise(read(name))) {
        drifted.push(`${name}: installed copy differs from the bundled source`);
      }
    }
    expect(drifted).toEqual([]);
  });
});
