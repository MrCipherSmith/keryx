/** Default native owners construct these read drivers for every real session.
 * Configured MCP/bus/provider execution capabilities are reported separately by their actual owner. */
export const NATIVE_DEFAULT_SERVICE_READINESS = Object.freeze({
  settings: Object.freeze({snapshot:true,permissions:true,search:true}),
  /** The production assembly always attaches the provider driver (list/probe; selection is the host's config transaction) and the supervised review owner. */
  integrations: Object.freeze({channels:true,remotePolicy:true,providers:true,autoreview:true}),
  /** Every native runtime builds its owned fixed-argv read port; the host attaches it to each inspection. */
  analysis: Object.freeze({readInspection:true}),
});
