/**
 * The external-agent capability gates, for client surfaces (the ACP shell's
 * delegate tool) that sit outside the commands layer. One named seam, so those
 * surfaces do not import `capability/` internals themselves.
 */
export { agentConfig, checkExternalAgentVendorGates, resolveExternalAgentsCapability } from "../capability/external-agents";
