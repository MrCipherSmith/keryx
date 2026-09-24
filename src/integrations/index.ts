// Compatibility door: the facade is ./service.ts (import-policy facade rule);
// kept so importers of `src/integrations` from before flow 307 keep resolving.
export * from "./service";
