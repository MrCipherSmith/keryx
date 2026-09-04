// Flow 223 AC11: nothing phase 0 adds may depend on git.
//
// Different projects treat `.metaproject/` differently, and
// `src/commands/init.no-git.test.ts` already pins "no git at all" as a
// supported state. The describe edge, the wiki layer, the build manifest and
// page provenance must therefore all work on a bare directory — this suite is
// the guard that keeps a future `git` call from creeping into that path.

import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { computeVerifiedScope, parseProvenance, writeProvenance } from "../wiki/provenance";
import { buildGraph } from "./build";
import { getFilesDescribedBy, loadGraph } from "./query";

async function bareProject(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "lwg-nogit-"));
  await mkdir(path.join(root, "src", "ctx"), { recursive: true });
  await writeFile(path.join(root, "src", "ctx", "index.ts"), 'export * from "./run";\n');
  await writeFile(path.join(root, "src", "ctx", "run.ts"), "export const run = () => 1;\n");
  await mkdir(path.join(root, ".metaproject", "wiki", "components"), { recursive: true });
  await writeFile(
    path.join(root, ".metaproject", "wiki", "components", "src-ctx.md"),
    "# src/ctx\nVersion: 1.0.0\nType: component\nStatus: accepted\nDescribes:\n  - src/ctx/**\n",
  );
  return root;
}

test("the whole phase-0 path works with no .git directory anywhere", async () => {
  const root = await bareProject();

  // Two builds: the first writes nodes.jsonl, the second sees a module set.
  await buildGraph(root);
  await buildGraph(root);

  const graph = await loadGraph(root);
  expect(graph.wikiPages?.[0]?.id).toBe("wiki:components/src-ctx.md");
  expect(getFilesDescribedBy(graph, "wiki:components/src-ctx.md")).toEqual([
    "src/ctx/index.ts",
    "src/ctx/run.ts",
  ]);

  // VerifiedScope is the git-free freshness path; it must compute here.
  const scope = await computeVerifiedScope(root, ["src/ctx/index.ts", "src/ctx/run.ts"], graph);
  expect(scope).toMatch(/^sha256:[0-9a-f]{64}$/);

  const pagePath = path.join(root, ".metaproject", "wiki", "components", "src-ctx.md");
  const stamped = writeProvenance(await readFile(pagePath, "utf8"), { verifiedScope: scope });
  await writeFile(pagePath, stamped);
  expect(parseProvenance(await readFile(pagePath, "utf8")).verifiedScope).toBe(scope);

  // And no `.git` was created along the way.
  expect(await readdir(root)).not.toContain(".git");
});

test("a page carrying VerifiedAt but no reachable git history still resolves", async () => {
  const root = await bareProject();
  const pagePath = path.join(root, ".metaproject", "wiki", "components", "src-ctx.md");
  await writeFile(
    pagePath,
    writeProvenance(await readFile(pagePath, "utf8"), { verifiedAt: "a".repeat(40) }),
  );

  await buildGraph(root);
  await buildGraph(root);

  // The sha is parsed and kept; deciding it is unreachable is phase 1's job,
  // and must not become a build-time failure here (specification §4.1 path 2).
  expect(parseProvenance(await readFile(pagePath, "utf8")).verifiedAt).toBe("a".repeat(40));
  const graph = await loadGraph(root);
  expect(graph.wikiPages?.[0]?.undecidable).toBe(false);
});
