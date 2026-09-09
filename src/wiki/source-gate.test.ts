// AFC-08 / flow 236 AC1, last clause: "запуск генератора не делает устаревшие
// входы fresh" — running the generator does not make a stale input fresh.
//
// Before this task neither `refreshPages` nor `verifyPages` asked how old the
// code graph was. Both took the CLI's `currentHead(cwd)` and stamped it as
// `VerifiedAt`, so a corpus regenerated from a graph built at an older commit
// came out asserting a verification against the CURRENT head — measured live
// in this checkout, where `.metaproject/data/gdgraph/.provenance.json` recorded
// `60848c77` while `git rev-parse HEAD` was `886400e8`.
//
// These tests build real git fixtures (never the project repo) for the
// commit-moved case, and inject a probe for the two cases a fixture cannot
// produce deterministically (a partially failing git).

import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { migrateMarkers, refreshPages, verifyPages } from "./refresh";
import type { StalenessCheck } from "../gdgraph/staleness";
import type { WikiHeadInput } from "./staleness";

const PAGE = "components/src-mod.md";

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
  }
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/**
 * A real git repo carrying a built graph and one markered wiki page.
 *
 * `graphBuiltAt: "head"` is the state right after a clean `keryx gdgraph
 * build`; `"older"` records a different commit as the build provenance, which
 * is exactly the live state this task was dispatched against.
 */
async function fixture(graphBuiltAt: "head" | "older"): Promise<{ cwd: string; pagePath: string; head: string }> {
  const cwd = await mkdtemp(path.join(tmpdir(), "afc08-source-gate-"));
  roots.push(cwd);
  git(cwd, ["init", "-q"]);
  git(cwd, ["config", "user.email", "test@example.invalid"]);
  git(cwd, ["config", "user.name", "test"]);

  await mkdir(path.join(cwd, "src", "mod"), { recursive: true });
  await writeFile(path.join(cwd, "src/mod/index.ts"), "export const alpha = 1;\nexport const beta = 2;\n");
  await writeFile(path.join(cwd, "src/mod/helper.ts"), "export const helper = 3;\n");
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-q", "-m", "sources"]);
  const first = git(cwd, ["rev-parse", "HEAD"]);

  // A second commit so `head` and the older build provenance really differ.
  await writeFile(path.join(cwd, "src/mod/index.ts"), "export const alpha = 1;\nexport const beta = 2;\nexport const gamma = 3;\n");
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-q", "-m", "move head"]);
  const head = git(cwd, ["rev-parse", "HEAD"]);

  // Graph storage + build provenance. Everything under `.metaproject/` is
  // deliberately left untracked: `checkGraphStaleness` skips that tree as
  // normal build residue, so it does not itself trigger staleness.
  const storage = path.join(cwd, ".metaproject", "data", "gdgraph", "storage");
  await mkdir(storage, { recursive: true });
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
  await writeFile(
    path.join(cwd, ".metaproject", "data", "gdgraph", ".provenance.json"),
    `${JSON.stringify({ commit: graphBuiltAt === "head" ? head : first, branch: "main", builtAt: new Date().toISOString() }, null, 2)}\n`,
  );

  const pagePath = path.join(cwd, ".metaproject", "wiki", "components", "src-mod.md");
  await mkdir(path.dirname(pagePath), { recursive: true });
  await writeFile(
    pagePath,
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
      "## Changelog",
      "",
      "- 1.0.0 - Written by hand.",
      "",
    ].join("\n"),
  );
  await migrateMarkers(cwd);
  return { cwd, pagePath, head };
}

/** A resolved head, said explicitly (AFC-22, T13): `WikiHeadInput`, not a bare sha. */
const at = (commit: string): WikiHeadInput => ({ kind: "resolved", commit });

const probe = (status: StalenessCheck["status"], reason: string) => async (): Promise<StalenessCheck> => ({
  status,
  reasons: status === "fresh" ? [] : [reason],
});

describe("AC1: a generator run does not make an old source fresh", () => {
  test("control — a graph built at HEAD still stamps VerifiedAt at HEAD", async () => {
    const { cwd, pagePath, head } = await fixture("head");

    const result = await refreshPages({ cwd, head: at(head) });

    expect(result.refreshed).toBe(1);
    expect(result.source.status).toBe("fresh");
    expect(await readFile(pagePath, "utf8")).toContain(`VerifiedAt: ${head}`);
  });

  test("a graph built at an older commit never stamps the current HEAD", async () => {
    const { cwd, pagePath, head } = await fixture("older");

    const result = await refreshPages({ cwd, head: at(head) });

    // The block is still repaired — the content genuinely is what that graph
    // says — but nothing claims the page was verified at a revision the source
    // never saw.
    expect(result.refreshed).toBe(1);
    expect(result.source.status).toBe("stale");
    expect(result.source.reasons.join(" ")).toContain("HEAD moved");

    const after = await readFile(pagePath, "utf8");
    expect(after).not.toContain(head);
    expect(after).not.toMatch(/^VerifiedAt:/m);
    // ...and the refresh says so on the page itself rather than silently.
    expect(after).toContain("VerifiedAt was not advanced");
    // Prose is still byte-identical.
    expect(after).toContain("Prose the machine must never touch.");
  });

  test("a stale source does not advance an EXISTING stamp either", async () => {
    const { cwd, pagePath, head } = await fixture("older");
    const older = "a".repeat(40);
    const seeded = (await readFile(pagePath, "utf8")).replace(
      "Status: accepted",
      `Status: accepted\nVerifiedAt: ${older}`,
    );
    await writeFile(pagePath, seeded);

    await refreshPages({ cwd, head: at(head) });

    const after = await readFile(pagePath, "utf8");
    expect(after).toContain(`VerifiedAt: ${older}`);
    expect(after).not.toContain(head);
  });

  test("a source error preserves the generated block instead of rewriting it", async () => {
    const { cwd, pagePath, head } = await fixture("head");
    const before = await readFile(pagePath, "utf8");

    const result = await refreshPages({
      cwd,
      head: at(head),
      checkStaleness: probe("unknown", "git status failed"),
    });

    expect(result.refreshed).toBe(0);
    expect(result.staleSource).toBe(1);
    expect(result.pages[0]?.action).toBe("stale-source");
    expect(result.source.status).toBe("unknown");
    // "Ошибка source сохраняет старый block и видимый stale/unknown result"
    // (wiki-specification.md §7): the old block survives byte for byte.
    expect(await readFile(pagePath, "utf8")).toBe(before);
  });

  test("a repeated refresh over a stale source still produces no diff", async () => {
    const { cwd, pagePath, head } = await fixture("older");
    await refreshPages({ cwd, head: at(head) });
    const afterFirst = await readFile(pagePath, "utf8");

    const second = await refreshPages({ cwd, head: at(head) });

    expect(second.unchanged).toBe(1);
    expect(second.refreshed).toBe(0);
    expect(await readFile(pagePath, "utf8")).toBe(afterFirst);
  });
});

describe("AC1: verify does not record a verification its source cannot support", () => {
  test("a stale graph refuses the stamp and names the reason", async () => {
    const { cwd, pagePath, head } = await fixture("older");
    const before = await readFile(pagePath, "utf8");

    await expect(verifyPages({ cwd, page: PAGE, head: at(head) })).rejects.toThrow(/stale|gdgraph build/i);
    expect(await readFile(pagePath, "utf8")).toBe(before);
  });

  test("a git failure refuses the stamp too", async () => {
    const { cwd, pagePath, head } = await fixture("head");
    const before = await readFile(pagePath, "utf8");

    await expect(
      verifyPages({ cwd, page: PAGE, head: at(head), checkStaleness: probe("unknown", "git status failed") }),
    ).rejects.toThrow(/could not be determined|unknown/i);
    expect(await readFile(pagePath, "utf8")).toBe(before);
  });

  test("a fresh graph still stamps", async () => {
    const { cwd, pagePath, head } = await fixture("head");

    const stamped = await verifyPages({ cwd, page: PAGE, head: at(head) });

    expect(stamped).toHaveLength(1);
    expect(await readFile(pagePath, "utf8")).toContain(`VerifiedAt: ${head}`);
  });
});
