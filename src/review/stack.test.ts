import { expect, test } from "bun:test";
import {
  detectProjectStack,
  extractStackRequiresField,
  parseStackRequires,
  renderStackScopingMarkdown,
  scopeReviewerByStack,
  STACK_TAGS,
  type DetectedStack,
} from "./stack";

function readFileFrom(files: Record<string, string>): (path: string) => Promise<string> {
  return async (path: string) => {
    const content = files[path];
    if (content === undefined) {
      throw new Error(`ENOENT: ${path}`);
    }
    return content;
  };
}

// ---------------------------------------------------------------------------
// AC13 — deterministic detection, and the fail-open direction
// ---------------------------------------------------------------------------

test("AC13: detects nestjs from an @nestjs/ scoped dependency", async () => {
  const detected = await detectProjectStack("/proj", {
    readFile: readFileFrom({
      "/proj/package.json": JSON.stringify({ dependencies: { "@nestjs/core": "^10.0.0", "@nestjs/common": "^10.0.0" } }),
    }),
  });
  expect(detected.uncertain).toBe(false);
  expect(detected.tags.nestjs).toBe(true);
  expect(detected.tags.react).toBe(false);
  expect(detected.tags.mobx).toBe(false);
  expect(detected.tags.prisma).toBe(false);
  expect(detected.matched).toContain("@nestjs/core");
});

test("AC13: detects react, mobx, and prisma from exact dependency names", async () => {
  const detected = await detectProjectStack("/proj", {
    readFile: readFileFrom({
      "/proj/package.json": JSON.stringify({
        dependencies: { react: "^18", "react-dom": "^18", mobx: "^6", "mobx-react-lite": "^4" },
        devDependencies: { prisma: "^5" },
      }),
    }),
  });
  expect(detected.tags.react).toBe(true);
  expect(detected.tags.mobx).toBe(true);
  expect(detected.tags.prisma).toBe(true);
  expect(detected.tags.nestjs).toBe(false);
});

test("AC13: a clean package.json naming none of the tags reports all false, not uncertain", async () => {
  const detected = await detectProjectStack("/proj", {
    readFile: readFileFrom({ "/proj/package.json": JSON.stringify({ dependencies: { zod: "^3" } }) }),
  });
  expect(detected.uncertain).toBe(false);
  for (const tag of STACK_TAGS) {
    expect(detected.tags[tag]).toBe(false);
  }
});

/**
 * The monorepo shape, which is where the fail-open direction inverted.
 *
 * `{"name":"x","workspaces":["packages/*"]}` parses cleanly, so detection
 * reported `uncertain: false` and every stack tag `false` — and excluded
 * `review-frontend`, `review-frontend-conventions`, `review-backend` and
 * `code-mobx-store-review` from a React monorepo. A root manifest that declares
 * no dependency has not told us the repository has none; it has told us nothing.
 */
test("AC13: a package.json with no dependency block anywhere is uncertain, not `no stack`", async () => {
  const detected = await detectProjectStack("/proj", {
    readFile: readFileFrom({ "/proj/package.json": JSON.stringify({ name: "workspace-root", private: true }) }),
  });
  expect(detected.uncertain).toBe(true);
  for (const tag of STACK_TAGS) {
    expect(detected.tags[tag]).toBe(true);
  }
  expect(detected.reason).toMatch(/declares no dependencies/);
});

test("AC13: an explicitly empty dependency block is uncertain for the same reason", async () => {
  const detected = await detectProjectStack("/proj", {
    readFile: readFileFrom({ "/proj/package.json": JSON.stringify({ dependencies: {}, devDependencies: {} }) }),
  });
  expect(detected.uncertain).toBe(true);
});

test("AC13: a workspace root is uncertain even when it declares its own dependencies", async () => {
  // The common React monorepo: tooling at the root, `react` in `packages/web`.
  // The root manifest is a complete and accurate statement about the root, and
  // says nothing at all about the code the reviewers will read.
  const detected = await detectProjectStack("/proj", {
    readFile: readFileFrom({
      "/proj/package.json": JSON.stringify({
        workspaces: ["packages/*", "apps/*"],
        devDependencies: { typescript: "^5", eslint: "^9" },
      }),
    }),
  });
  expect(detected.uncertain).toBe(true);
  expect(detected.tags.react).toBe(true);
  expect(detected.reason).toMatch(/workspaces/);
  expect(detected.reason).toContain("packages/*");
});

test("AC13: the npm object form of `workspaces` is recognised too", async () => {
  const detected = await detectProjectStack("/proj", {
    readFile: readFileFrom({
      "/proj/package.json": JSON.stringify({
        workspaces: { packages: ["libs/*"], nohoist: [] },
        dependencies: { zod: "^3" },
      }),
    }),
  });
  expect(detected.uncertain).toBe(true);
  expect(detected.reason).toContain("libs/*");
});

test("AC13: an empty `workspaces` list is not a workspace root", async () => {
  // `"workspaces": []` enumerates no sub-package, so there is nothing unread.
  const detected = await detectProjectStack("/proj", {
    readFile: readFileFrom({
      "/proj/package.json": JSON.stringify({ workspaces: [], dependencies: { zod: "^3" } }),
    }),
  });
  expect(detected.uncertain).toBe(false);
  expect(detected.tags.react).toBe(false);
});

test("AC13: a monorepo root that DOES declare the dependency is still uncertain, never excluded", async () => {
  // Belt and braces on the direction: even the case where the root happens to
  // name `react`, the sub-packages remain unread, so nothing is concluded
  // against them.
  const detected = await detectProjectStack("/proj", {
    readFile: readFileFrom({
      "/proj/package.json": JSON.stringify({ workspaces: ["packages/*"], dependencies: { react: "^18" } }),
    }),
  });
  expect(detected.uncertain).toBe(true);
  expect(scopeReviewerByStack("review-frontend", ["react", "mobx"], detected).include).toBe(true);
});

test("AC13: a missing package.json fails open — uncertain, every tag true", async () => {
  const detected = await detectProjectStack("/proj", { readFile: readFileFrom({}) });
  expect(detected.uncertain).toBe(true);
  for (const tag of STACK_TAGS) {
    expect(detected.tags[tag]).toBe(true);
  }
  expect(detected.reason.length).toBeGreaterThan(0);
});

test("AC13: unparsable JSON fails open", async () => {
  const detected = await detectProjectStack("/proj", {
    readFile: readFileFrom({ "/proj/package.json": "{ not json" }),
  });
  expect(detected.uncertain).toBe(true);
  expect(detected.tags.react).toBe(true);
});

test("AC13: a package.json that is not a JSON object fails open", async () => {
  const detected = await detectProjectStack("/proj", {
    readFile: readFileFrom({ "/proj/package.json": "[1,2,3]" }),
  });
  expect(detected.uncertain).toBe(true);
});

test("AC13: a trailing slash in cwd does not produce a doubled path", async () => {
  const detected = await detectProjectStack("/proj/", {
    readFile: readFileFrom({ "/proj/package.json": JSON.stringify({ dependencies: { react: "^18" } }) }),
  });
  expect(detected.uncertain).toBe(false);
  expect(detected.tags.react).toBe(true);
});

// ---------------------------------------------------------------------------
// Frontmatter extraction
// ---------------------------------------------------------------------------

test("extractStackRequiresField reads metadata.stack_requires", () => {
  const skillMd = [
    "---",
    "name: review-backend",
    "description: x",
    "metadata:",
    "  author: someone",
    "  version: \"1.0.0\"",
    "  stack_requires: \"nestjs,prisma\"",
    "license: MIT",
    "---",
    "",
    "# body",
  ].join("\n");
  expect(extractStackRequiresField(skillMd)).toBe("nestjs,prisma");
});

test("extractStackRequiresField returns undefined when the field is absent", () => {
  const skillMd = ["---", "name: review-logic", "description: x", "metadata:", "  version: \"1.0.0\"", "---", "", "# body"].join(
    "\n",
  );
  expect(extractStackRequiresField(skillMd)).toBeUndefined();
});

test("extractStackRequiresField returns undefined for a missing/malformed frontmatter block, never throws", () => {
  expect(extractStackRequiresField("# just a heading, no frontmatter")).toBeUndefined();
  expect(extractStackRequiresField("---\nname: broken\n")).toBeUndefined(); // no closing ---
  expect(extractStackRequiresField("")).toBeUndefined();
});

test("parseStackRequires parses a CSV, lowercases, dedupes, and drops unknown tokens", () => {
  expect(parseStackRequires("nestjs,Prisma,nestjs, bogus-tag ")).toEqual(["nestjs", "prisma"]);
  expect(parseStackRequires(undefined)).toEqual([]);
  expect(parseStackRequires("")).toEqual([]);
});

// ---------------------------------------------------------------------------
// Scoping decisions — the asymmetry AC13 requires
// ---------------------------------------------------------------------------

const CERTAIN_NONE: DetectedStack = {
  tags: { nestjs: false, react: false, mobx: false, prisma: false },
  uncertain: false,
  reason: "detected from /proj/package.json (1 declared dependency)",
  matched: [],
};

const CERTAIN_REACT: DetectedStack = {
  tags: { nestjs: false, react: true, mobx: false, prisma: false },
  uncertain: false,
  reason: "detected from /proj/package.json (2 declared dependencies)",
  matched: ["react"],
};

const UNCERTAIN: DetectedStack = {
  tags: { nestjs: true, react: true, mobx: true, prisma: true },
  uncertain: true,
  reason: "package.json not found at /proj/package.json",
  matched: [],
};

test("AC13: a reviewer with no declared requirement is always included (generic reviewer)", () => {
  const decision = scopeReviewerByStack("review-logic", [], CERTAIN_NONE);
  expect(decision.include).toBe(true);
  expect(decision.reason).toMatch(/no stack requirement declared/);
});

test("AC13: uncertain detection always includes a stack-gated reviewer — the failure mode is to include, never to skip", () => {
  const decision = scopeReviewerByStack("review-backend", ["nestjs", "prisma"], UNCERTAIN);
  expect(decision.include).toBe(true);
  expect(decision.reason).toMatch(/uncertain/);
});

test("AC13: a declared requirement that is detected present is included", () => {
  const decision = scopeReviewerByStack("review-frontend", ["react", "mobx"], CERTAIN_REACT);
  expect(decision.include).toBe(true);
  expect(decision.reason).toMatch(/react/);
});

test("AC13: the ONLY case that excludes — clean detection, none of the declared tags present", () => {
  const decision = scopeReviewerByStack("review-frontend", ["react", "mobx"], CERTAIN_NONE);
  expect(decision.include).toBe(false);
  expect(decision.reason).toMatch(/none of \[react, mobx\] detected/);
});

test("renderStackScopingMarkdown lists every decision and names exclusions explicitly", () => {
  const markdown = renderStackScopingMarkdown(CERTAIN_NONE, [
    scopeReviewerByStack("review-logic", [], CERTAIN_NONE),
    scopeReviewerByStack("review-frontend", ["react", "mobx"], CERTAIN_NONE),
  ]);
  expect(markdown).toContain("## Stack scoping");
  expect(markdown).toContain("review-logic");
  expect(markdown).toContain("review-frontend");
  expect(markdown).toContain("Excluded (never run this round): review-frontend");
});

test("renderStackScopingMarkdown says explicitly when nothing was excluded", () => {
  const markdown = renderStackScopingMarkdown(CERTAIN_REACT, [scopeReviewerByStack("review-frontend", ["react"], CERTAIN_REACT)]);
  expect(markdown).toContain("No reviewer was excluded by stack scoping.");
});

test("renderStackScopingMarkdown on uncertain detection says so and never claims a tag list", () => {
  const markdown = renderStackScopingMarkdown(UNCERTAIN, [scopeReviewerByStack("review-backend", ["nestjs"], UNCERTAIN)]);
  expect(markdown).toContain("uncertain");
  expect(markdown).toContain("Every stack-gated reviewer is included");
});
