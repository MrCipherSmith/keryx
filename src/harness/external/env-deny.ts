// Environment names an external agent child never inherits. A leaf module:
// `env.ts` and `mcp-servers/spawn-env.ts` both read these lists.
//
// MOVED (flow 355, AC7 R-MIN1): the lists themselves now live in
// `src/security/credential-shape.ts`, alongside `isDeniedForMcpChild` which
// depends on them — a core module cannot import this one (`import-zones.ts`'s
// zero-tolerance rule against a core owner importing client), so the data
// moved instead of the rule bending. Re-exported here so every existing
// importer of THIS module (`env.ts`, `spawn-env.ts`, both packages' tests) is
// unaffected. Reached through the `security/service.ts` FACADE (F-ARCH-F1,
// flow 355 review round) rather than `security/credential-shape.ts`
// directly — the direct import was an avoidable bypass `import-policy.
// live.test.ts` had to raise its ratchet for; the facade needs none.
export { EXTERNAL_ENV_DENY, EXTERNAL_ENV_PREFIX_SWEEPS } from "../../security/service";
