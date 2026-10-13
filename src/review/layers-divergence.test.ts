import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { refreshLayers } from "./layers";
import { createLayersFixture, git, writeProjectFile, type LayersFixture } from "./layers.test-helpers";

let fixture: LayersFixture;
beforeEach(async () => {
  fixture = await createLayersFixture();
});
afterEach(async () => {
  await fixture.cleanup();
});

describe("wiki and memory are read from the working copy and marked against the PR head (AC4)", () => {
  test("equal commits are marked none", async () => {
    const layers = await refreshLayers({ projectRoot: fixture.root, packageDir: fixture.packageDir });
    for (const layer of [layers.wiki, layers.memory]) {
      expect(layer.divergence.state).toBe("none");
      expect(layer.divergence.workingCopyCommit).toBe(fixture.second);
      expect(layer.divergence.prHead).toBe(fixture.second);
      expect(layer.divergence.commitsBetween).toBe(0);
      expect(layer.divergence.changedPaths).toEqual([]);
      expect(layer.commit).toBe(fixture.second);
    }
  });

  test("a PR head ahead of the working copy lists the commits between and the changed wiki and memory paths", async () => {
    await writeProjectFile(fixture.root, ".metaproject/wiki/architecture/beta.md", "# Beta\n");
    await writeProjectFile(fixture.root, ".metaproject/memory/lessons/second-lesson.md", "---\ntype: lesson\nstatus: active\n---\n\n# Second\n");
    await writeProjectFile(fixture.root, "src/d.ts", "export const d = 1;\n");
    git(fixture.root, ["add", "-A"]);
    git(fixture.root, ["commit", "-q", "-m", "third"]);
    const third = git(fixture.root, ["rev-parse", "HEAD"]);
    git(fixture.root, ["checkout", "-q", "--detach", fixture.second]);

    const layers = await refreshLayers({ projectRoot: fixture.root, packageDir: fixture.packageDir, prHead: third });

    expect(layers.wiki.divergence).toMatchObject({
      state: "differs",
      workingCopyCommit: fixture.second,
      prHead: third,
      commitsBetween: 1,
      changedPaths: [".metaproject/wiki/architecture/beta.md"],
    });
    expect(layers.memory.divergence).toMatchObject({
      state: "differs",
      commitsBetween: 1,
      changedPaths: [".metaproject/memory/lessons/second-lesson.md"],
    });
    expect(layers.memory.entries).toBe(1);
  });

  test("a PR head git cannot see is marked unknown, never none", async () => {
    const layers = await refreshLayers({
      projectRoot: fixture.root,
      packageDir: fixture.packageDir,
      prHead: "0123456789abcdef0123456789abcdef01234567",
    });
    expect(layers.wiki.divergence.state).toBe("unknown");
    expect(layers.memory.divergence.state).toBe("unknown");
  });
});
