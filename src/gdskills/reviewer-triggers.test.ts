import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  descriptionFlags,
  descriptionPathTriggers,
  metadataList,
  reviewerFlagReport,
  reviewerFlags,
  reviewerPathGate,
} from "./reviewer-triggers";
import { globToRegExp, requiredReviewers } from "../review/coverage";
import * as viaReview from "../review/reviewers";
import * as here from "./reviewer-triggers";

// The reviewer-level behaviour of these helpers — what `keryx review reviewers`
// reports and what `keryx skills import` warns — is driven through those two
// in `src/review/reviewers.test.ts` and `./import-skills.test.ts`. This file
// holds what is only visible at the text level.

const skill = (frontmatter: string): string => `---\nname: review-x\n${frontmatter}---\n\n# body\n`;

describe("metadataList", () => {
  test("reads a scalar, a quoted scalar, a flow list and a block list as the same list", () => {
    for (const value of [
      "  paths: src/a/**, src/b/**\n",
      '  paths: "src/a/**, src/b/**"\n',
      "  paths: [src/a/**, 'src/b/**']\n",
      '  paths:\n    - src/a/**\n    - "src/b/**"\n',
      // YAML also allows the items at the key's own indentation.
      "  paths:\n  - src/a/**\n\n  - src/b/**\n",
    ]) {
      expect({ value, list: metadataList(skill(`metadata:\n${value}`), "paths") }).toEqual({
        value,
        list: ["src/a/**", "src/b/**"],
      });
    }
  });

  test("a block list ends at the next key, and at an item indented less than its key", () => {
    expect(metadataList(skill("metadata:\n  paths:\n    - src/a/**\n  flags: --x\n    - src/not-a-path/**\n"), "paths")).toEqual([
      "src/a/**",
    ]);
    expect(metadataList(skill("metadata:\n    paths:\n    - src/a/**\n  - src/outdented/**\n"), "paths")).toEqual(["src/a/**"]);
  });

  test("only a key under metadata counts, and only inside the frontmatter", () => {
    expect(metadataList(skill("paths: src/top/**\nmetadata:\n  category: review\n"), "paths")).toEqual([]);
    expect(metadataList(skill("metadata:\n  category: review\nother:\n  paths: src/other/**\n"), "paths")).toEqual([]);
    expect(metadataList(`${skill("metadata:\n  category: review\n")}metadata:\n  paths: src/body/**\n`, "paths")).toEqual([]);
    expect(metadataList("metadata:\n  paths: src/no-frontmatter/**\n", "paths")).toEqual([]);
  });

  test("the key is matched literally", () => {
    // Unescaped, `p.ths` would be a pattern and take the `paths` line above it.
    expect(metadataList(skill("metadata:\n  paths: src/a/**\n  p.ths: src/b/**\n"), "p.ths")).toEqual(["src/b/**"]);
  });
});

describe("reviewerFlagReport", () => {
  test("normalises each entry: split, trimmed, lower-cased, `--` added when it has no leading dash", () => {
    expect(reviewerFlagReport(skill('metadata:\n  flags: " Acme,--HOUSE-ui   core2 "\n'))).toEqual({
      flags: ["--acme", "--house-ui", "--core2"],
      warnings: [],
    });
  });

  test("an entry with a single dash, or one that is not a flag name, is dropped and named as written", () => {
    const report = reviewerFlagReport(skill('metadata:\n  flags: "-v, --, --9, a_b, --ok, --Trailing-"\n'));
    // A trailing dash is within the shape; the rest are not.
    expect(report.flags).toEqual(["--ok", "--trailing-"]);
    expect(report.warnings.map((warning) => /^metadata\.flags: ("[^"]*") dropped — /.exec(warning)?.[1])).toEqual([
      '"-v"',
      '"--"',
      '"--9"',
      '"a_b"',
    ]);
  });

  test("`--all` is never a selection flag, and dropping it is not a warning", () => {
    expect(reviewerFlagReport(skill('metadata:\n  flags: "--all, ALL, --x"\n'))).toEqual({ flags: ["--x"], warnings: [] });
    expect(reviewerFlagReport(skill("description: Dispatched for --all or --y.\n"))).toEqual({ flags: ["--y"], warnings: [] });
  });

  test("a declared list replaces the description's flags, even when it leaves none", () => {
    const described = "description: Dispatched for --house or src/a/** changes.\n";
    expect(reviewerFlags(skill(described))).toEqual(["--house"]);
    expect(reviewerFlags(skill(`${described}metadata:\n  flags: --ui\n`))).toEqual(["--ui"]);
    // Only `--all`: declared, nothing dropped, so nothing to warn about.
    expect(reviewerFlagReport(skill(`${described}metadata:\n  flags: --all\n`))).toEqual({ flags: [], warnings: [] });
    const invalid = reviewerFlagReport(skill(`${described}metadata:\n  flags: "_, -x"\n`));
    expect(invalid.flags).toEqual([]);
    expect(invalid.warnings).toHaveLength(3);
    expect(invalid.warnings[2]).toStartWith("metadata.flags: no entry is a flag — this reviewer has no selection flags");
  });

  test("an empty metadata.flags is not a declaration", () => {
    const described = "description: Dispatched for --house.\n";
    for (const value of ["  flags:\n", '  flags: ""\n', "  flags: []\n", "  flags: ,\n"]) {
      expect({ value, report: reviewerFlagReport(skill(`${described}metadata:\n${value}`)) }).toEqual({
        value,
        report: { flags: ["--house"], warnings: [] },
      });
    }
  });
});

describe("reviewerPathGate", () => {
  test("metadata.paths, then the description's triggers, then nothing", () => {
    const described = "description: Dispatched for src/d/** changes.\n";
    expect(reviewerPathGate(skill(`${described}metadata:\n  paths:\n    - src/m/**\n`))).toEqual({
      paths: ["src/m/**"],
      pathsSource: "metadata",
    });
    expect(reviewerPathGate(skill(`${described}metadata:\n  paths:\n  category: review\n`))).toEqual({
      paths: ["src/d/**"],
      pathsSource: "description",
    });
    expect(reviewerPathGate(skill("description: React/Next.js conventions reviewer.\n"))).toEqual({
      paths: [],
      pathsSource: "none",
    });
    expect(reviewerPathGate("no frontmatter")).toEqual({ paths: [], pathsSource: "none" });
  });
});

describe("round-2 frontmatter shapes (G-002, G-003, G-011)", () => {
  test("a YAML trailing comment is neither a flag nor part of a path (G-003)", () => {
    for (const flags of ["  flags:\n    - --a # family flag\n", "  flags: --a # family flag\n", '  flags: "--a" # family flag\n']) {
      expect({ flags, report: reviewerFlagReport(skill(`metadata:\n${flags}`)) }).toEqual({
        flags,
        report: { flags: ["--a"], warnings: [] },
      });
    }
    for (const paths of ["  paths:\n    - src/x/** # the x tree\n", "  paths: [src/x/**] # the x tree\n"]) {
      expect({ paths, gate: reviewerPathGate(skill(`metadata:\n${paths}`)) }).toEqual({
        paths,
        gate: { paths: ["src/x/**"], pathsSource: "metadata" },
      });
    }
  });

  test("a bare `-` item does not end a block list (G-011)", () => {
    expect(reviewerFlags(skill("metadata:\n  flags:\n    - --a\n    -\n    - --b\n"))).toEqual(["--a", "--b"]);
  });

  test("a key nested under another mapping in metadata is not a metadata field (G-011)", () => {
    const nested = skill("description: Dispatched for --house.\nmetadata:\n  other:\n    flags: --x\n    paths: src/x/**\n");
    expect(reviewerFlags(nested)).toEqual(["--house"]);
    expect(reviewerPathGate(nested)).toEqual({ paths: [], pathsSource: "none" });
  });

  test("CRLF line endings and a BOM read the same as LF (G-002)", () => {
    const lf = skill("metadata:\n  flags:\n    - --a\n  paths: [src/x/**]\n");
    for (const content of [lf.replace(/\n/g, "\r\n"), `\uFEFF${lf}`, `\uFEFF${lf.replace(/\n/g, "\r\n")}`]) {
      expect(reviewerFlags(content)).toEqual(["--a"]);
      expect(reviewerPathGate(content)).toEqual({ paths: ["src/x/**"], pathsSource: "metadata" });
    }
  });
});

describe("description triggers and flags (round 3, H-008)", () => {
  test("a bare `*.ext` is a glob trigger, not prose (T15)", () => {
    expect(descriptionPathTriggers("Reviews *.ts files and *.ts(x) components.")).toEqual(["*.ts", "*.tsx"]);
    expect(reviewerPathGate(skill("description: Reviews *.css changes.\n"))).toEqual({ paths: ["*.css"], pathsSource: "description" });
  });

  test("a literal beside a glob needs a `/` to be a file path (T05)", () => {
    // A slash-less token with a dot is already refused as a first segment
    // (`column-zone.ts`) unless it is a dotfile; the `/` rule is what refuses these.
    expect(descriptionPathTriggers("Reviews src/core/** and .eslintrc.json, .env.local")).toEqual(["src/core/**"]);
    expect(descriptionPathTriggers("Reviews src/core/** and src/utils/column-zone.ts")).toEqual([
      "src/core/**",
      "src/utils/column-zone.ts",
    ]);
  });

  test("a flag is found only at a word start, never inside a word (T18)", () => {
    expect(descriptionFlags("Dispatched by acme-review--acme, x=--house or a/--ui")).toEqual([]);
    expect(descriptionFlags("--lead, then (--paren), x,--comma and --spaced")).toEqual(["--lead", "--paren", "--comma", "--spaced"]);
  });
});

describe("a project reviewer's description gate selects the files it names (flow 428 AC2)", () => {
  const gateMatches = (description: string, file: string): boolean =>
    reviewerPathGate(skill(`description: ${description}\n`)).paths.some((glob) => globToRegExp(glob).test(file));

  test("a trailing `/**` reaches a file directly under the directory, not only a nested one", () => {
    const domains = "Use when reviewing analytics. Dispatched by vantage-review for --vantage-domains, src/analytics/** or src/pipelines/** changes.";
    const core = "Use when reviewing shared infrastructure. Dispatched by vantage-review for --vantage-core, src/core/** changes.";
    expect(reviewerPathGate(skill(`description: ${domains}\n`))).toEqual({ paths: ["src/analytics/**", "src/pipelines/**"], pathsSource: "description" });
    for (const file of ["src/pipelines/index.ts", "src/pipelines/a/b/c.ts", "src/analytics/store.ts"]) expect(gateMatches(domains, file)).toBe(true);
    for (const file of ["src/core/x.ts", "src/core/flow/graph.ts"]) expect(gateMatches(core, file)).toBe(true);
    for (const file of ["src/pipelinesx/a.ts", "src/other/pipelines/a.ts", "src/core.ts"]) {
      expect(gateMatches(domains, file)).toBe(false);
      expect(gateMatches(core, file)).toBe(false);
    }
  });

  describe("through requiredReviewers, which is what selects the roster", () => {
    let root: string;
    const install = async (name: string, description: string): Promise<void> => {
      const dir = path.join(root, ".metaproject", "project-skills", "review", name);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n`, "utf8");
    };

    beforeEach(async () => {
      root = await mkdtemp(path.join(tmpdir(), "keryx-triggers-"));
      await mkdir(path.join(root, ".metaproject"), { recursive: true });
      await writeFile(path.join(root, ".metaproject", "metaproject.json"), `${JSON.stringify({ modules: { gdskills: {} } })}\n`, "utf8");
      await install("review-vantage-domains", "Use when reviewing analytics. Dispatched by vantage-review for --vantage-domains, src/analytics/** or src/pipelines/** changes.");
      await install("review-vantage-core", "Use when reviewing shared infrastructure. Dispatched by vantage-review for --vantage-core, src/core/** changes.");
    });

    afterEach(async () => {
      await rm(root, { recursive: true, force: true });
    });

    test("a file directly under the directory keeps the reviewer in the roster, in diff and all mode", async () => {
      for (const mode of ["diff", "all"] as const) {
        const pipelines = await requiredReviewers(root, mode, ["src/pipelines/index.ts"]);
        expect(pipelines.required).toContain("review-vantage-domains");
        expect(pipelines.excluded.map((e) => e.reviewer)).toContain("review-vantage-core");
        const core = await requiredReviewers(root, mode, ["src/core/x.ts"]);
        expect(core.required).toContain("review-vantage-core");
        expect(core.excluded.filter((e) => e.reviewer === "review-vantage-core")).toEqual([]);
        expect(core.excluded.find((e) => e.reviewer === "review-vantage-domains")?.reason).toContain("no-matching-paths");
      }
    });
  });
});

test("src/review/reviewers re-exports these helpers rather than keeping its own", () => {
  for (const name of [
    "descriptionFlags",
    "descriptionPathTriggers",
    "escapeRegexLiteral",
    "reviewerFlagReport",
    "reviewerFlags",
    "reviewerPathGate",
  ] as const) {
    expect(viaReview[name]).toBe(here[name]);
  }
});
