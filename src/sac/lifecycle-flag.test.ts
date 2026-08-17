import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { computeLifecycleFlags } from "./lifecycle-flag";
import { localWorkspaceAuthorizationServer, WorkspaceService } from "./workspace-service";

async function tempCwd(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "keryx-lifecycle-flag-"));
}

/** Minimal `nodes.jsonl` fixture — only `path`/`kind` are read by
 * `validModuleNames` (src/wiki/service.ts). */
async function writeGraphNodes(cwd: string, filePaths: string[]): Promise<void> {
  const dir = path.join(cwd, ".metaproject", "data", "gdgraph", "storage");
  await mkdir(dir, { recursive: true });
  const nodes = filePaths.map((p) => ({ path: p, kind: "file" }));
  await writeFile(path.join(dir, "nodes.jsonl"), `${nodes.map((n) => JSON.stringify(n)).join("\n")}\n`, "utf8");
  await writeFile(path.join(dir, "edges.jsonl"), "", "utf8");
}

async function createWorkspace(cwd: string, id: string, component?: string): Promise<void> {
  const service = new WorkspaceService({
    workspaceRoot: cwd,
    authorizationServer: localWorkspaceAuthorizationServer(),
    strictGuard: { mode: "strict", availability: "available", decision: "pass", policyRevision: "local-offline-v1" },
  });
  await service.create({
    request: undefined,
    requestCorrelationId: randomUUID(),
    id,
    title: "test workspace",
    ...(component ? { component: { kind: "component" as const, uri: component } } : {}),
  });
}

async function writeMemoryEntry(cwd: string, relativePath: string, module: string): Promise<void> {
  const dir = path.join(cwd, ".metaproject", "memory", path.dirname(relativePath));
  await mkdir(dir, { recursive: true });
  const content = `# Test entry

Version: 0.1.0
Type: task-note
Status: accepted
Confidence: medium

## Summary

A test entry.

## Related Scopes

- Module: ${module}
- Entity:
- Files:
- Skills:
`;
  await writeFile(path.join(cwd, ".metaproject", "memory", relativePath), content, "utf8");
}

async function writeWikiDecisionPage(cwd: string, filename: string, module: string): Promise<void> {
  const dir = path.join(cwd, ".metaproject", "wiki", "decisions");
  await mkdir(dir, { recursive: true });
  const content = `# Test decision

Version: 0.1.0
Type: decision
Status: accepted
Module: ${module}

## Summary

A test decision.
`;
  await writeFile(path.join(dir, filename), content, "utf8");
}

/**
 * Creates a real workspace bound to a real, on-disk component. The file is
 * kept ON disk deliberately: `WorkspaceService.readManifest` (used by
 * `list()`/`enumerateVisible`) re-validates every resource on every read and
 * silently drops a workspace from discovery altogether if its component no
 * longer resolves on disk (`workspace-service.ts`'s own "corrupt or
 * inaccessible workspaces are never disclosed" behavior) — so a genuinely
 * deleted file is already invisible before this module ever sees it. The
 * realistic case this flag exists for is a component that is still a real
 * file but has fallen out of the GRAPH's index (a stale/not-yet-rebuilt
 * graph, or a path outside the graph's scan roots) — graph knowledge, not
 * disk existence, is what `isStillPresent` checks.
 */
async function createWorkspaceWithGoneComponent(cwd: string, id: string, componentPath: string): Promise<string> {
  const abs = path.join(cwd, componentPath);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, "export {};\n", "utf8");
  await createWorkspace(cwd, id, `./${componentPath}`);
  return componentPath;
}

test("no graph built yet -> [] (never floods, never treats an empty valid-set as everything-invalid)", async () => {
  const cwd = await tempCwd();
  await createWorkspaceWithGoneComponent(cwd, "workspace-a", "src/alpha/gone.ts");
  const flags = await computeLifecycleFlags(cwd);
  expect(flags).toEqual([]);
});

test("a workspace whose bound component is no longer in the graph is flagged", async () => {
  const cwd = await tempCwd();
  await createWorkspaceWithGoneComponent(cwd, "workspace-a", "src/alpha/gone.ts");
  await writeGraphNodes(cwd, ["src/beta/still-here.ts"]);
  const flags = await computeLifecycleFlags(cwd);
  expect(flags).toEqual([{ kind: "workspace", ref: "workspace-a", missingComponent: "src/alpha/gone.ts", flaggedAt: flags[0]!.flaggedAt }]);
});

test("a workspace whose bound component IS still in the graph is never flagged", async () => {
  const cwd = await tempCwd();
  await mkdir(path.join(cwd, "src", "alpha"), { recursive: true });
  await writeFile(path.join(cwd, "src", "alpha", "still-here.ts"), "export {};\n", "utf8");
  await writeGraphNodes(cwd, ["src/alpha/still-here.ts", "src/beta/other.ts"]);
  await createWorkspace(cwd, "workspace-a", "./src/alpha/still-here.ts");
  const flags = await computeLifecycleFlags(cwd);
  expect(flags).toEqual([]);
});

test("a workspace with no bound component at all is never flagged", async () => {
  const cwd = await tempCwd();
  await writeGraphNodes(cwd, ["src/beta/whatever.ts"]);
  await createWorkspace(cwd, "workspace-a");
  const flags = await computeLifecycleFlags(cwd);
  expect(flags).toEqual([]);
});

test("a memory entry whose module is no longer in the graph is flagged", async () => {
  const cwd = await tempCwd();
  await writeGraphNodes(cwd, ["src/beta/still-here.ts"]);
  await writeMemoryEntry(cwd, "task-notes/e1.md", "src/alpha");
  const flags = await computeLifecycleFlags(cwd);
  expect(flags).toHaveLength(1);
  expect(flags[0]).toMatchObject({ kind: "memory-entry", ref: "task-notes/e1.md", missingComponent: "src/alpha" });
});

test("a wiki decision page whose module is no longer in the graph is flagged", async () => {
  const cwd = await tempCwd();
  await writeGraphNodes(cwd, ["src/beta/still-here.ts"]);
  await writeWikiDecisionPage(cwd, "sac-x.md", "src/alpha");
  const flags = await computeLifecycleFlags(cwd);
  expect(flags).toHaveLength(1);
  expect(flags[0]).toMatchObject({ kind: "wiki-decision", ref: "decisions/sac-x.md", missingComponent: "src/alpha" });
});

test("AC5: computeLifecycleFlags performs zero writes — pure read/report", async () => {
  const cwd = await tempCwd();
  await createWorkspaceWithGoneComponent(cwd, "workspace-a", "src/alpha/gone.ts");
  await writeGraphNodes(cwd, ["src/beta/still-here.ts"]);
  await writeMemoryEntry(cwd, "task-notes/e1.md", "src/alpha");
  await writeWikiDecisionPage(cwd, "sac-x.md", "src/alpha");

  const before = await snapshotFiles(cwd);
  await computeLifecycleFlags(cwd);
  const after = await snapshotFiles(cwd);
  expect(after).toEqual(before);
});

async function snapshotFiles(cwd: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out.push(path.relative(cwd, full));
    }
  }
  await walk(path.join(cwd, ".metaproject"));
  return out.sort();
}
