import { expect, test } from "bun:test";
import { backlinksFor, buildBacklinkIndex, extractCodePaths, extractLinks, resolveLink } from "./backlinks";

test("extractCodePaths pulls file-like code spans (repo-relative), skips prose", () => {
  const md = "See `src/gdgraph/query.ts` and `src/a/b.tsx`. Not `foo` or `a-word` or `NAME`.";
  expect(extractCodePaths(md)).toEqual(["src/gdgraph/query.ts", "src/a/b.tsx"]);
});

test("buildBacklinkIndex inverts code-span refs (wiki -> code edges) as repo-relative", () => {
  const pages = [
    { repoPath: ".metaproject/wiki/components/src-gdgraph.md", content: "Key files: `src/gdgraph/query.ts`" },
  ];
  const index = buildBacklinkIndex(pages);
  // resolved repo-relative, NOT relative to the page's folder
  expect(backlinksFor(index, "src/gdgraph/query.ts")).toEqual([".metaproject/wiki/components/src-gdgraph.md"]);
});

test("extractLinks pulls local markdown targets, skips external/anchors", () => {
  const md = "See [A](../components/a.md) and [code](../../../src/x.ts). [ext](https://y.com) [top](#h)";
  expect(extractLinks(md)).toEqual(["../components/a.md", "../../../src/x.ts"]);
});

test("resolveLink resolves relative to the linking page, dropping anchors", () => {
  expect(resolveLink(".metaproject/wiki/architecture/map.md", "../components/a.md")).toBe(
    ".metaproject/wiki/components/a.md",
  );
  expect(resolveLink(".metaproject/wiki/architecture/map.md", "../../../src/x.ts#L10")).toBe("src/x.ts");
});

test("buildBacklinkIndex inverts wiki + code links", () => {
  const pages = [
    { repoPath: ".metaproject/wiki/architecture/map.md", content: "[to comp](../components/a.md) [code](../../../src/x.ts)" },
    { repoPath: ".metaproject/wiki/components/a.md", content: "[back](../architecture/map.md)" },
  ];
  const index = buildBacklinkIndex(pages);

  // comp page is linked from map
  expect(backlinksFor(index, ".metaproject/wiki/components/a.md")).toEqual([".metaproject/wiki/architecture/map.md"]);
  // map is linked from comp
  expect(backlinksFor(index, ".metaproject/wiki/architecture/map.md")).toEqual([".metaproject/wiki/components/a.md"]);
  // the code file is linked from the map page (wiki -> code edge inverted)
  expect(backlinksFor(index, "src/x.ts")).toEqual([".metaproject/wiki/architecture/map.md"]);
});

test("backlinksFor returns [] for an unreferenced target and dedupes sources", () => {
  const pages = [
    { repoPath: ".metaproject/wiki/a.md", content: "[x](../wiki/b.md) [x again](../wiki/b.md)" },
  ];
  const index = buildBacklinkIndex(pages);
  expect(backlinksFor(index, ".metaproject/wiki/b.md")).toEqual([".metaproject/wiki/a.md"]); // deduped
  expect(backlinksFor(index, "src/nope.ts")).toEqual([]);
});
