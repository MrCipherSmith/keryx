/**
 * Public Shared Agent Context service facade.
 *
 * Transports import this module rather than the FWK implementation so the
 * MCP boundary stays coupled to one stable SAC service surface. Local-only
 * actor composition remains inside the implementation; callers cannot supply
 * identity or roles through this facade.
 */
export {
  createLocalFwkReadService,
  normalizeFwkResult,
  type FwkReadResult,
} from "./fwk-service";
