// Public surface of `keryx shell`'s lifecycle hook runtime (flow 306, W6, T5).
//
// See `workstreams/W6-shell-hooks.md` for the full design; this module is
// intentionally NOT wired into `run.ts`/`agent.ts`/the CLI yet (later tasks
// do that) — it is usable standalone for tests and for those integrations to
// import against.
export * from "./types";
export * from "./config";
export * from "./builtins";
export * from "./codec";
export * from "./semantics";
export * from "./compose";
export * from "./runner";
export * from "./runtime";
export * from "./trust";
export * from "./notices";
