// Flow 209, AC1 — `keryx skills verify --bundled` from an INSTALLED copy.
//
// WHY A SECOND GUARD RATHER THAN A STRONGER FIRST ONE
//
// `skills.bundled-verify.test.ts` runs the CLI as `bun src/cli.ts`. In that
// shape `import.meta.dir` is `<repo>/src/gdskills`, so `defaultBundledRoot()`
// resolves `<repo>/src/gdskills/bundled` and the sweep finds 65 skills. That
// assertion is true, it is worth keeping, and it is STRUCTURALLY unable to
// notice the defect measured on 2026-08-31: run from the published 0.2.72
// global install, the same command printed `skills_evaluated: 0`.
//
// The reason is the layout, not the logic. `bun build` collapses every module
// into `dist/cli.js`, so in an installed copy `import.meta.dir` is
// `<package>/dist` — while `package.json`'s `files` ships the skills at
// `<package>/src/gdskills/bundled`. The old resolver looked only at
// `import.meta.dir/bundled`, i.e. `dist/bundled`, which has never existed in
// any release. No assertion made from the repo tree can see that, because the
// repo tree is the layout that works.
//
// So this file builds the package the way `npm pack` would, lays the shipped
// files out the way `npm install` would, and runs the CLI from there. The
// denominator is asserted non-zero, which is the whole point: the empty sweep
// already refuses to call itself clean (`NOTHING WAS EVALUATED`, exit 1), and
// that refusal is why the regression was a visible defect rather than a silent
// false pass. Both properties are pinned below.

import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");

const MANIFEST = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
  bin: Record<string, string>;
  files: string[];
};

/**
 * What ships, read from `package.json` rather than restated.
 *
 * This is the load-bearing detail. If `files` ever stops listing
 * `src/gdskills/bundled`, an installed copy has no skills at all — and a fixture
 * with a hard-coded copy list would keep passing while shipping nothing. Taking
 * the list from the manifest means the packaging decision and the assertion are
 * the same fact.
 */
const SHIPPED_PATHS: readonly string[] = MANIFEST.files;

/** Where `npm` puts the executable — again from the manifest, not assumed. */
const BIN_PATH = MANIFEST.bin.keryx as string;

/** `./dist/cli.js` -> `dist`, in the spelling `files` uses. */
const BUILD_DIR = path.normalize(path.dirname(BIN_PATH));

/**
 * Build and lay out a package the way a user receives it.
 *
 * `bun build` is invoked with the same flags `package.json`'s `build` script
 * uses; `--outdir` is redirected into the fixture so `import.meta.dir` inside
 * the bundle is `<fixture>/dist`, which is the whole point.
 */
async function installedPackage(): Promise<string> {
  const root = mkdtempSync(path.join(tmpdir(), "keryx-installed-pkg-"));

  const build = Bun.spawn(
    [
      "bun",
      "build",
      path.join(REPO_ROOT, "src", "cli.ts"),
      "--outdir",
      path.join(root, BUILD_DIR),
      "--target",
      "bun",
      "--external",
      "@modelcontextprotocol/sdk",
      "--external",
      "web-tree-sitter",
      "--external",
      "@opentui/core",
    ],
    { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" },
  );
  const buildErr = await new Response(build.stderr).text();
  const buildCode = await build.exited;
  if (buildCode !== 0) throw new Error(`bun build failed (${buildCode}):\n${buildErr}`);

  for (const relative of SHIPPED_PATHS) {
    // `dist` is produced by the build above, never copied from the repo — a
    // stale `dist/cli.js` from a previous `bun run build` would make this test
    // report on code that is not the code under test.
    if (path.normalize(relative) === BUILD_DIR) continue;
    const source = path.join(REPO_ROOT, relative);
    if (!existsSync(source)) continue;
    const target = path.join(root, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    cpSync(source, target, { recursive: true });
  }

  return root;
}

async function runInstalled(root: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
  // A temp HOME and a temp CWD: nothing here may read the repository it came
  // from, or the fixture would silently prove the repo layout all over again.
  const home = mkdtempSync(path.join(tmpdir(), "keryx-installed-home-"));
  const cwd = mkdtempSync(path.join(tmpdir(), "keryx-installed-cwd-"));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.HOME = home;
  env.XDG_DATA_HOME = home;

  const proc = Bun.spawn(["bun", path.join(root, "dist", "cli.js"), ...args], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, out, err };
}

describe("keryx skills verify --bundled, from an installed copy", () => {
  test("the package still ships the skills at all", async () => {
    // Before asserting anything about resolution: `files` has to list the tree.
    // Drop that entry and every user gets a CLI with no skills, which no amount
    // of correct resolution recovers from.
    expect(SHIPPED_PATHS).toContain("src/gdskills/bundled");
    expect(BIN_PATH).toBe("./dist/cli.js");
  });

  test("the packaged layout is the one this asserts against", async () => {
    // The guard on the guard. If `dist/bundled` ever DID exist, the run below
    // would pass through the first resolution rung and prove nothing about the
    // second — so state the shape the fixture depends on before depending on it.
    const root = await installedPackage();
    try {
      expect(existsSync(path.join(root, "dist", "cli.js"))).toBe(true);
      expect(existsSync(path.join(root, "dist", "bundled"))).toBe(false);
      expect(existsSync(path.join(root, "src", "gdskills", "bundled", "skills"))).toBe(true);
      // The binary under test is the one built here, not a `dist/` copied out
      // of the repository — which would silently test whatever was last built.
      expect(readFileSync(path.join(root, "dist", "cli.js"), "utf8")).toContain(
        "documents_evaluated",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("it evaluates the shipped skills over a non-zero denominator and exits 0", async () => {
    const root = await installedPackage();
    try {
      const result = await runInstalled(root, ["skills", "verify", "--bundled"]);

      // The regression, stated as the assertion that catches it.
      expect(result.out).not.toContain("skills_evaluated: 0");
      expect(result.out).not.toContain("NOTHING WAS EVALUATED");
      expect(result.out).toContain("skills_evaluated: 67");
      expect(result.out).toContain("findings: 0");
      expect(result.code).toBe(0);

      // …and it read the copy inside the package, not the repository it was
      // built from. Without this, a resolver that walked up to the git root
      // would satisfy every line above while still being broken for users.
      expect(result.out).toContain(path.join(root, "src", "gdskills", "bundled"));
      expect(result.out).not.toContain(path.join(REPO_ROOT, "src", "gdskills", "bundled"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  test("harness builds are read from the installed copy too", async () => {
    // AC5 at the same seam: the count of documents must exceed the count of
    // skills in the shape users actually have, not only in the repo.
    const root = await installedPackage();
    try {
      const result = await runInstalled(root, ["skills", "verify", "--bundled", "--json"]);
      expect(result.code).toBe(0);
      const parsed = JSON.parse(result.out) as { skills: number; documents: number };
      expect(parsed.skills).toBe(67);
      expect(parsed.documents).toBeGreaterThan(parsed.skills);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  test("an installed copy with no skills still refuses to read as a pass", async () => {
    // The property that saved this from being a silent false pass, pinned at the
    // installed layout: an empty sweep says so and exits 1. Keep it — a resolver
    // fix that also made an empty tree exit 0 would trade one defect for a worse
    // one.
    const root = await installedPackage();
    try {
      rmSync(path.join(root, "src", "gdskills", "bundled"), { recursive: true, force: true });
      // Nothing to fall back to: neither rung resolves now.
      writeFileSync(path.join(root, "MARKER"), "no skills shipped\n", "utf8");

      const result = await runInstalled(root, ["skills", "verify", "--bundled"]);
      expect(result.out).toContain("skills_evaluated: 0");
      expect(result.out).toContain("NOTHING WAS EVALUATED");
      expect(result.err).toContain("Nothing was evaluated, so nothing was verified");
      expect(result.code).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
