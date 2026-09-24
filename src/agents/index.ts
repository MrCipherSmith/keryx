// Compatibility door: the facade is ./service.ts (import-policy facade rule —
// `src/lib/import-policy.ts`'s `client-imports-core-internal` check only
// recognizes a module literally named `service.ts`, the same convention
// `src/integrations/index.ts` follows). Kept so an importer of `src/agents`
// as a bare directory import keeps resolving.
export * from "./service";
