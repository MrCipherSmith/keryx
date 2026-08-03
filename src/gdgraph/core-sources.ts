// The `src/gdgraph/*.ts` files that `init` and `update` copy into
// `.metaproject/core/gdgraph/`, so a scaffolded project can run the graph
// builder without the full toolkit installed.
//
// This list used to live inline in BOTH `commands/init.ts` and
// `commands/update.ts`, which meant two hand-maintained copies of a fact that
// nothing checked. When `query.ts` gained an import of `./target`, neither copy
// learned about it and `keryx gdgraph build` broke on every fresh install —
// while the suite stayed green, because nothing ran the copied tree.
//
// It is one constant now, and `core-sources.test.ts` computes the transitive
// closure of local imports from the entry points and asserts this list equals
// it, in both directions. A new `import` in a copied file fails that test
// instead of a stranger's first five minutes.
export const GDGRAPH_CORE_SOURCES: readonly string[] = [
  "build.ts",
  "query.ts",
  "target.ts",
  "types.ts",
];
