// Facade for the whole `src/agents` core zone (flow 310, plus the
// pre-existing `bootstrap.ts`). `src/lib/import-policy.ts`'s
// `client-imports-core-internal` check only clears an adapter/client import
// that resolves to a module literally named `service.ts`, so this file is
// the zone's one public door — re-exporting `bootstrap.ts` (the unrelated
// `keryx agents bootstrap` global-routing-block installer) alongside the W2
// agent-definitions catalog rather than leaving it as a second, unguarded
// entry point into the zone.
export * from "./types";
export * from "./schema";
export * from "./frontmatter";
export * from "./baseline";
export * from "./tools";
export * from "./policy";
export * from "./compile";
export * from "./catalog";
export * from "./bootstrap";
