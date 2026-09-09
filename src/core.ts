/**
 * The package's public core entry point — `import … from "@mrciphersmith/keryx"`.
 *
 * WHY THIS FILE EXISTS
 *
 * Until it did, `package.json` declared no `main`, no `module`, no `types` and
 * no `exports`, so the only published entry was `bin.keryx`. Importing the
 * package as a library therefore failed outright (Node falls back to
 * `<pkg>/index.js`, which is not shipped) — and, because there was no `exports`
 * map, `files` had become the public surface by accident: every path under the
 * raw source trees it ships was deep-importable, test files included. AFC-19
 * asks for core-only packaging and AFC-20 asks for a bounded module boundary;
 * this module plus the `exports` map in `package.json` is the whole of that
 * boundary. AFC-20's last clause — "весь repo на пакеты не дробится без
 * пользы" — is why the repository stays ONE package: the boundary is DECLARED
 * here, not carved out into a second workspace.
 *
 * WHAT IS BEHIND THE DOOR
 *
 * The ten declared owner facades, each under its own namespace. Namespaces
 * rather than a flat `export *` for two reasons: ten facades re-exporting into
 * one flat scope silently drops any name two of them share, and a caller
 * reading `core.wiki.…` can see which owner it is talking to.
 *
 * Everything else in `src/` stays private. `src/ctx/` has no `service.ts` yet
 * and so has no door here; adding one belongs to whoever owns that directory.
 *
 * WHAT IS NOT BEHIND IT — AND WHAT PROVES IT
 *
 * No provider registry, no model selection, no credential read, no LLM call
 * (AFC-19, `specification.md` §30). That is not asserted by this comment: it is
 * measured in `src/core-package.test.ts`, which builds THIS module with the
 * release build's own flags and reads the emitted sourcemap, so a module that
 * only becomes reachable through a barrel or a re-spelled specifier is still
 * caught. The client supplies the model turn (see `src/sac/model-turn-port.ts`);
 * core refuses rather than reaching for one.
 *
 * TYPES, STATED RATHER THAN IMPLIED
 *
 * The package publishes no `.d.ts`: `bun build` does not emit declarations and
 * adding a declaration-emit step is a separate piece of work with its own
 * failure modes. A TypeScript consumer gets `any` from this entry today. That
 * is a real limitation and it is written here rather than left to be found.
 */

export * as flow from "./flow/service";
export * as gdgraph from "./gdgraph/service";
export * as health from "./health/service";
export * as job from "./job/service";
export * as memory from "./memory/service";
export * as sac from "./sac/service";
export * as security from "./security/service";
export * as standard from "./standard/service";
export * as testing from "./testing/service";
export * as wiki from "./wiki/service";
