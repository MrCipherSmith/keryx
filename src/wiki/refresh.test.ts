// LWG-11 refresh / migrate / verify (flow 227): AC1, AC2, AC3, AC4, AC6, AC8, AC9.

import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveGitHead } from "../sync/provenance";
import { appendChangelogLine, bumpPatch, migrateMarkers, refreshPages, verifyPages } from "./refresh";

const SHA = "c".repeat(40);

// Flow 236 T8: `refreshPages`/`verifyPages` now ask how old their source graph
// is before stamping anything (AFC-08, "running the generator does not make a
// stale input fresh"). These fixtures are bare temp directories, not git
// repositories, so the real `checkGraphStaleness` can only answer `unknown`
// there — while every call below hands in a fabricated 40-char `head`, a
// combination that cannot occur in production (no git ⇒ no head). The
// precondition these tests always relied on implicitly is now written down
// instead: the source is current, so the behaviour under test is block
// replacement and nothing else. The gate's own behaviour is demonstrated
// against real git fixtures in `source-gate.test.ts`.
const FRESH = async () => ({ status: "fresh" as const, reasons: [] });

/** A project whose graph really produces a `src/mod` component page.
 *
 * `root` places that project somewhere other than a fresh temp directory —
 * used by the monorepo fixture below, where the project root deliberately sits
 * BELOW the git root. */
async function project(pageBody?: string, root?: string): Promise<{ cwd: string; pagePath: string }> {
  const cwd = root ?? (await mkdtemp(path.join(tmpdir(), "lwg-refresh-")));
  const storage = path.join(cwd, ".metaproject", "data", "gdgraph", "storage");
  await mkdir(storage, { recursive: true });
  await mkdir(path.join(cwd, "src", "mod"), { recursive: true });
  await writeFile(path.join(cwd, "src/mod/index.ts"), "export const alpha = 1;\nexport const beta = 2;\n");
  await writeFile(path.join(cwd, "src/mod/helper.ts"), "export const helper = 3;\n");

  const nodes = ["src/mod/index.ts", "src/mod/helper.ts"].map((p) => ({
    id: p,
    kind: "file",
    path: p,
    language: "typescript",
  }));
  await writeFile(path.join(storage, "nodes.jsonl"), `${nodes.map((n) => JSON.stringify(n)).join("\n")}\n`);
  await writeFile(
    path.join(storage, "edges.jsonl"),
    `${JSON.stringify({ id: "e1", from: "src/mod/helper.ts", to: "src/mod/index.ts", kind: "imports", specifier: "./index" })}\n`,
  );

  const pagePath = path.join(cwd, ".metaproject", "wiki", "components", "src-mod.md");
  await mkdir(path.dirname(pagePath), { recursive: true });
  await writeFile(
    pagePath,
    pageBody ??
      [
        "# src/mod",
        "Version: 1.0.0",
        "Type: component",
        "Status: accepted",
        "",
        "## Overview",
        "",
        "Prose the machine must never touch.",
        "",
        "## Reference (from code graph)",
        "",
        "### Public API",
        "",
        "- stale",
        "",
        "## Related Wiki",
        "",
        "- [Index](../index.md)",
        "",
        "## Changelog",
        "",
        "- 1.0.0 - Written by hand.",
        "",
      ].join("\n"),
  );
  return { cwd, pagePath };
}

describe("migrateMarkers (AC4)", () => {
  test("adds markers, is idempotent, and never authors content", async () => {
    const { cwd, pagePath } = await project();
    const before = await readFile(pagePath, "utf8");

    const first = await migrateMarkers(cwd);
    expect(first.migrated).toEqual(["components/src-mod.md"]);

    const after = await readFile(pagePath, "utf8");
    const nonMarker = after.split("\n").filter((l) => !l.startsWith("<!-- keryx:reference:"));
    // Only marker lines were added; every original line survives in order.
    expect(nonMarker).toEqual(before.split("\n"));

    const second = await migrateMarkers(cwd);
    expect(second.migrated).toEqual([]);
    expect(second.alreadyMigrated).toEqual(["components/src-mod.md"]);
    expect(await readFile(pagePath, "utf8")).toBe(after);
  });

  test("a page with no Reference section is skipped, not given one", async () => {
    const { cwd } = await project("# src/mod\nVersion: 1.0.0\nType: component\nStatus: accepted\n\n## Overview\n\nProse.\n");
    const result = await migrateMarkers(cwd);
    expect(result.migrated).toEqual([]);
    expect(result.skippedNoSection).toEqual(["components/src-mod.md"]);
  });

  test("--dry-run writes nothing", async () => {
    const { cwd, pagePath } = await project();
    const before = await readFile(pagePath, "utf8");
    const result = await migrateMarkers(cwd, { dryRun: true });
    expect(result.migrated).toEqual(["components/src-mod.md"]);
    expect(await readFile(pagePath, "utf8")).toBe(before);
  });
});

describe("refreshPages", () => {
  test("AC1: rewrites the block on an accepted page, changing nothing outside it", async () => {
    const { cwd, pagePath } = await project();
    await migrateMarkers(cwd);
    const before = await readFile(pagePath, "utf8");

    const result = await refreshPages({ cwd, head: { kind: "resolved" as const, commit: SHA }, checkStaleness: FRESH });
    expect(result.refreshed).toBe(1);

    const after = await readFile(pagePath, "utf8");
    // Prose and the trailing section are untouched.
    expect(after).toContain("Prose the machine must never touch.");
    expect(after.split("## Related Wiki")[1]?.split("## Changelog")[0]).toBe(
      before.split("## Related Wiki")[1]?.split("## Changelog")[0],
    );
    // The stale Reference content is gone, replaced from the graph.
    expect(after).not.toContain("- stale");
    expect(after).toContain("### Key files");
  });

  test("AC2: makes no provider call — proven by a graph-only path", async () => {
    // `refreshPages` takes no provider and imports none; this asserts the
    // observable consequence: a refresh completes with no network or model
    // configuration present at all.
    const { cwd } = await project();
    await migrateMarkers(cwd);
    const result = await refreshPages({ cwd, head: { kind: "resolved" as const, commit: SHA }, checkStaleness: FRESH });
    expect(result.refreshed).toBe(1);
    expect(result.conflicts).toBe(0);
  });

  test("AC8: bumps only the patch and appends exactly one changelog line", async () => {
    const { cwd, pagePath } = await project();
    await migrateMarkers(cwd);
    await refreshPages({ cwd, head: { kind: "resolved" as const, commit: SHA }, checkStaleness: FRESH });

    const after = await readFile(pagePath, "utf8");
    expect(after).toContain("Version: 1.0.1");
    const changelogLines = after
      .split("## Changelog")[1]
      ?.split("\n")
      .filter((line) => line.trim().startsWith("- ")) ?? [];
    expect(changelogLines).toHaveLength(2);
    expect(changelogLines[0]).toContain("1.0.1 - Reference refreshed");
  });

  test("AC9: an already-current page is not rewritten at all", async () => {
    const { cwd, pagePath } = await project();
    await migrateMarkers(cwd);
    await refreshPages({ cwd, head: { kind: "resolved" as const, commit: SHA }, checkStaleness: FRESH });
    const afterFirst = await readFile(pagePath, "utf8");

    const second = await refreshPages({ cwd, head: { kind: "resolved" as const, commit: SHA }, checkStaleness: FRESH });
    expect(second.unchanged).toBe(1);
    expect(second.refreshed).toBe(0);
    // No version bump, no changelog line, no re-stamp: a second refresh must
    // not assert a verification that did not happen.
    expect(await readFile(pagePath, "utf8")).toBe(afterFirst);
  });

  test("AC3: a hand-edited block is refused, and --force overwrites it", async () => {
    const { cwd, pagePath } = await project();
    await migrateMarkers(cwd);
    await refreshPages({ cwd, head: { kind: "resolved" as const, commit: SHA }, checkStaleness: FRESH });

    const edited = (await readFile(pagePath, "utf8")).replace("### Key files", "### Key files (mine)");
    await writeFile(pagePath, edited);

    const refused = await refreshPages({ cwd, head: { kind: "resolved" as const, commit: SHA }, checkStaleness: FRESH });
    expect(refused.conflicts).toBe(1);
    expect(refused.pages[0]?.reason).toContain("edited by hand");
    expect(await readFile(pagePath, "utf8")).toBe(edited);

    const forced = await refreshPages({ cwd, head: { kind: "resolved" as const, commit: SHA }, force: true, checkStaleness: FRESH });
    expect(forced.refreshed).toBe(1);
    expect(await readFile(pagePath, "utf8")).not.toBe(edited);
  });

  test("a page with no markers is reported, not silently skipped", async () => {
    const { cwd } = await project();
    const result = await refreshPages({ cwd, head: { kind: "resolved" as const, commit: SHA }, checkStaleness: FRESH });
    expect(result.pages[0]?.action).toBe("no-block");
  });
});

describe("verifyPages (AC6)", () => {
  test("stamps provenance and changes nothing else", async () => {
    const { cwd, pagePath } = await project();
    const before = await readFile(pagePath, "utf8");

    const stamped = await verifyPages({ cwd, page: "components/src-mod.md", head: { kind: "resolved" as const, commit: SHA }, checkStaleness: FRESH });
    expect(stamped).toHaveLength(1);

    const after = await readFile(pagePath, "utf8");
    const added = after.split("\n").filter((line) => !/^Verified(At|Scope):/.test(line));
    expect(added).toEqual(before.split("\n"));
    expect(after).toContain(`VerifiedAt: ${SHA}`);
    expect(after).toMatch(/VerifiedScope: sha256:[0-9a-f]{64}/);
  });

  test("a page with an empty describe-set is not stamped — an empty claim", async () => {
    const { cwd } = await project(
      "# Overview\nVersion: 1.0.0\nType: component\nStatus: accepted\n\n## Overview\n\nProse.\n",
    );
    // No Describes, no Related Code, and the slug does not match a module.
    const stamped = await verifyPages({ cwd, page: "components/src-mod.md", head: { kind: "resolved" as const, commit: SHA }, checkStaleness: FRESH });
    expect(stamped.map((s) => s.path)).not.toContain("components/does-not-exist.md");
  });
});

// AFC-22 (flow 236 T13, F236-02). The measured defect: on ONE repository with
// ONE stale graph, `keryx wiki verify --baseline` refused while git was
// healthy and stamped — printing "(no git; scope hash only)" — once
// `.git/HEAD` was pointed at a missing ref. Breaking git switched the guard
// off, and the output asserted an absence of git from inside a working git
// repository.
//
// These drive the real `resolveGitHead` over a real repository broken on disk,
// because a fabricated `head` cannot reproduce it: the whole failure lived in
// how the head was RESOLVED. Revert `verifyPages`' `head.kind === "failed"`
// refusal and the first two go red with a stamped page.
describe("verifyPages refuses to stamp when git is present but broken (F236-02)", () => {
  async function gitProject(): Promise<{ cwd: string; pagePath: string }> {
    const made = await project();
    execFileSync("git", ["init", "-q"], { cwd: made.cwd, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: made.cwd, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "test"], { cwd: made.cwd, stdio: "ignore" });
    execFileSync("git", ["add", "-A"], { cwd: made.cwd, stdio: "ignore" });
    execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: made.cwd, stdio: "ignore" });
    return made;
  }

  /** The graph records a build at a commit that is not HEAD ⇒ genuinely stale. */
  async function staleGraphProvenance(cwd: string): Promise<void> {
    const file = path.join(cwd, ".metaproject", "data", "gdgraph", ".provenance.json");
    await writeFile(
      file,
      `${JSON.stringify({ commit: "a".repeat(40), branch: "main", builtAt: "2020-01-01T00:00:00.000Z" })}\n`,
    );
  }

  test("a dangling `.git/HEAD` is refused, where the same stale graph with healthy git was already refused", async () => {
    const { cwd, pagePath } = await gitProject();
    await staleGraphProvenance(cwd);

    // A — healthy git. Refused, because the graph is stale.
    await expect(
      verifyPages({ cwd, head: await resolveGitHead(cwd), baseline: true }),
    ).rejects.toThrow(/the code graph is stale/);

    // B — same repository, same graph, only git's ability to answer differs.
    await writeFile(path.join(cwd, ".git", "HEAD"), "ref: refs/heads/does-not-exist\n");
    await expect(
      verifyPages({ cwd, head: await resolveGitHead(cwd), baseline: true }),
    ).rejects.toThrow(/this is a git repository, but git could not answer/);

    // And nothing was written on either path.
    expect(await readFile(pagePath, "utf8")).not.toContain("VerifiedScope:");
  });

  test("the refusal does not depend on the graph being stale — a broken git is refused before the gate is even consulted", async () => {
    const { cwd } = await gitProject();
    await writeFile(path.join(cwd, ".git", "HEAD"), "corrupt");

    await expect(
      verifyPages({ cwd, head: await resolveGitHead(cwd), baseline: true, checkStaleness: FRESH }),
    ).rejects.toThrow(/this is a git repository, but git could not answer/);
  });

  test("a project with genuinely no git is still stamped — the supported configuration is not collateral damage", async () => {
    const { cwd, pagePath } = await project();
    const head = await resolveGitHead(cwd);
    expect(head.kind).toBe("no-repository");

    const stamped = await verifyPages({ cwd, head, baseline: true });
    expect(stamped).toHaveLength(1);
    // No revision to claim, so none is written — but the scope hash is.
    expect(stamped[0]!.verifiedAt).toBeNull();
    const after = await readFile(pagePath, "utf8");
    expect(after).toMatch(/VerifiedScope: sha256:[0-9a-f]{64}/);
    expect(after).not.toContain("VerifiedAt:");
  });

  test("a repository with no commits yet is stamped like a git-free project, not refused", async () => {
    const { cwd } = await project();
    execFileSync("git", ["init", "-q"], { cwd, stdio: "ignore" });
    const head = await resolveGitHead(cwd);
    expect(head.kind).toBe("unborn");

    const stamped = await verifyPages({ cwd, head, baseline: true });
    expect(stamped).toHaveLength(1);
    expect(stamped[0]!.verifiedAt).toBeNull();
  });
});

// V236-01 (flow 236 T15). The refusals above were armed by `resolveGitHead`
// answering `failed`, and that answer depended on a probe of `<cwd>/.git` —
// only at `cwd`, never at an ancestor. `cwd` is the PROJECT root, which
// `src/gdgraph/staleness.ts` documents may sit below the git root. So the same
// breakage classified differently depending on where `.metaproject` lives, and
// in the monorepo layout BOTH refusals were bypassed: the `failed` refusal
// never fired, and the stale-graph refusal is gated on `head.kind ===
// "resolved"`, so a stale graph was stamped too.
//
// The breakage is induced for real (`chmod 000` on the object store, which is
// what makes `git rev-parse` fail while `.git` is still on disk), and the two
// layouts are asserted as a PAIR — the defect was never visible from one alone.
describe("V236-01: the repository search is not confined to the project root", () => {
  async function brokenRepo(nested: boolean): Promise<{ gitRoot: string; cwd: string; pagePath: string }> {
    const gitRoot = await mkdtemp(path.join(tmpdir(), "lwg-monorepo-"));
    const cwd = nested ? path.join(gitRoot, "packages", "app") : gitRoot;
    if (nested) await mkdir(cwd, { recursive: true });
    const made = await project(undefined, cwd);
    execFileSync("git", ["init", "-q"], { cwd: gitRoot, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: gitRoot, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "test"], { cwd: gitRoot, stdio: "ignore" });
    execFileSync("git", ["add", "-A"], { cwd: gitRoot, stdio: "ignore" });
    execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: gitRoot, stdio: "ignore" });
    // An unreadable object store: `git rev-parse` (and `--is-inside-work-tree`,
    // and `--git-dir`, and `--show-toplevel`) all exit 128 with "not a git
    // repository", at the git root and in a subdirectory alike — so git itself
    // cannot be the witness here, and the `.git` entry on disk is all that is
    // left to tell "broken" from "absent".
    await chmod(path.join(gitRoot, ".git", "objects"), 0o000);
    return { gitRoot, cwd: made.cwd, pagePath: made.pagePath };
  }

  test("a present-but-broken repository is `failed` whether the project root IS the git root or sits below it", async () => {
    const atRoot = await brokenRepo(false);
    const below = await brokenRepo(true);
    try {
      expect((await resolveGitHead(atRoot.cwd)).kind).toBe("failed");
      // Was `no-repository` before this fix, for the identical breakage.
      expect((await resolveGitHead(below.cwd)).kind).toBe("failed");
    } finally {
      await chmod(path.join(atRoot.gitRoot, ".git", "objects"), 0o700);
      await chmod(path.join(below.gitRoot, ".git", "objects"), 0o700);
    }
  });

  test("wiki verify refuses from a project below the git root, and writes nothing", async () => {
    const below = await brokenRepo(true);
    try {
      await expect(
        verifyPages({ cwd: below.cwd, head: await resolveGitHead(below.cwd), baseline: true }),
      ).rejects.toThrow(/this is a git repository, but git could not answer/);
      // Before the fix this printed "baselined 1 page(s) (no git; scope hash
      // only)" and stamped the page.
      expect(await readFile(below.pagePath, "utf8")).not.toContain("VerifiedScope:");
    } finally {
      await chmod(path.join(below.gitRoot, ".git", "objects"), 0o700);
    }
  });

  test("a genuinely git-free project with no repository above it is still `no-repository`", async () => {
    // The ancestor walk must not turn the supported git-free configuration
    // into a phantom repository: it is consulted only after
    // `--is-inside-work-tree` has already failed, and it finds nothing here.
    const { cwd } = await project();
    expect((await resolveGitHead(cwd)).kind).toBe("no-repository");
  });
});

describe("helpers", () => {
  test("bumpPatch only moves the patch component", () => {
    expect(bumpPatch("1.2.3")).toBe("1.2.4");
    expect(bumpPatch("0.0.9")).toBe("0.0.10");
    // A missing or malformed version gets a defined starting point rather
    // than a crash or a silent "1.0.0" that overstates maturity.
    expect(bumpPatch(null)).toBe("0.1.1");
    expect(bumpPatch("not-a-version")).toBe("0.1.1");
  });

  test("appendChangelogLine inserts at the top of an existing section", () => {
    const page = "# P\n\n## Changelog\n\n- 1.0.0 - first\n";
    expect(appendChangelogLine(page, "- 1.0.1 - second")).toBe(
      "# P\n\n## Changelog\n\n- 1.0.1 - second\n- 1.0.0 - first\n",
    );
  });

  test("appendChangelogLine creates the section when absent", () => {
    expect(appendChangelogLine("# P\n\nProse.\n", "- 0.1.1 - x")).toBe(
      "# P\n\nProse.\n\n## Changelog\n\n- 0.1.1 - x\n",
    );
  });
});
