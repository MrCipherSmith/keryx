import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  hasIndexArtifacts,
  metaprojectIncompleteNotice,
  offersIndexTools,
  readMetaprojectState,
} from "./metaproject-state";

/**
 * Materialise a project from a `path -> contents` map, then run against it. No manifest is
 * written unless the map asks for one — which is the whole point of most of these cases.
 */
async function withProject(
  files: Record<string, string>,
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-metaproject-state-"));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const file = path.join(root, rel);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content, "utf8");
    }
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const READY = '{"schemaVersion":1}';

test("no .metaproject at all is absent, and offers nothing", async () => {
  await withProject({}, async (root) => {
    expect(readMetaprojectState(root)).toEqual({ state: "absent" });
    expect(offersIndexTools(root)).toBe(false);
    expect(metaprojectIncompleteNotice(root)).toBeUndefined();
  });
});

test("a bare .metaproject directory is incomplete, not an initialized project", async () => {
  // The `vantage-specs` shape: `.metaproject/workspaces/` and nothing else. This is the
  // state the old `existsSync(".metaproject")` gate mistook for an initialized project, so
  // eighteen index tools were offered to a session where every call answered
  // `index-incomplete` — and an empty answer read like an empty project.
  await withProject({ ".metaproject/workspaces/.keep": "" }, async (root) => {
    const state = readMetaprojectState(root);
    expect(state.state).toBe("incomplete");
    expect(offersIndexTools(root)).toBe(false);
    expect(hasIndexArtifacts(root)).toBe(false);
    const notice = metaprojectIncompleteNotice(root);
    expect(notice).toContain("incomplete");
    expect(notice).toContain("keryx update");
  });
});

test("a manifest that does not parse is incomplete, and is reported as invalid", async () => {
  await withProject({ ".metaproject/metaproject.json": "{ not json" }, async (root) => {
    const state = readMetaprojectState(root);
    expect(state).toEqual({ state: "incomplete", reason: "unreadable-manifest", detail: expect.any(String) });
    expect(offersIndexTools(root)).toBe(false);
  });
});

test("a manifest that parses is ready, and nothing is reported", async () => {
  await withProject({ ".metaproject/metaproject.json": READY }, async (root) => {
    expect(readMetaprojectState(root)).toEqual({ state: "ready" });
    expect(offersIndexTools(root)).toBe(true);
    expect(metaprojectIncompleteNotice(root)).toBeUndefined();
  });
});

test("index artifacts without a manifest keep the tools — keryx update recovers the manifest", async () => {
  // A metaproject created before `metaproject.json` existed still has a readable graph.
  // Stripping its tools until `keryx update` runs would be a silent capability removal.
  await withProject({ ".metaproject/data/gdgraph/artifacts/summary.md": "# Summary" }, async (root) => {
    expect(hasIndexArtifacts(root)).toBe(true);
    expect(offersIndexTools(root)).toBe(true);
    expect(metaprojectIncompleteNotice(root)).toContain("keryx update");
  });
});

test("the wiki index and the memory store are artifacts too", async () => {
  await withProject({ ".metaproject/wiki/index.md": "# Wiki" }, async (root) => {
    expect(offersIndexTools(root)).toBe(true);
  });
  await withProject({ ".metaproject/memory/decisions/one.md": "# One" }, async (root) => {
    expect(offersIndexTools(root)).toBe(true);
  });
});

test("a routing document and an empty workspace are NOT artifacts", async () => {
  // `index.md` is routing instructions, not an index: injecting it is what told a model to
  // run `keryx gdgraph build` in a workspace that had no graph to build from. And an empty
  // SAC `workspaces/` directory is the exact shape of the reported project.
  await withProject({ ".metaproject/index.md": "# Metaproject Index" }, async (root) => {
    expect(hasIndexArtifacts(root)).toBe(false);
    expect(offersIndexTools(root)).toBe(false);
  });
  await withProject({ ".metaproject/workspaces/.keep": "" }, async (root) => {
    expect(hasIndexArtifacts(root)).toBe(false);
  });
});
