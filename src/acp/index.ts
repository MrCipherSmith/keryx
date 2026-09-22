// The ACP adapter (flow 285): keryx as an Agent Client Protocol agent.
//
// Four files, one job each, and the split is the point (AC7):
//
//   protocol.ts  the ACP v1 surface — version, method names, wire types,
//                capabilities, version negotiation. THE file a version bump
//                touches.
//   jsonrpc.ts   JSON-RPC 2.0 envelopes, error codes, classification.
//   framing.ts   newline-delimited framing over stdio, in both directions.
//   dispatch.ts  method -> handler routing and error shape.
//
// Nothing here touches the keryx harness. This module can be driven end to end
// by tests alone, and the handlers that bridge it to sessions, the policy ask
// path and the turn loop are registered from outside by later dispatches of
// this flow.

export * from "./protocol";
export * from "./jsonrpc";
export * from "./framing";
export * from "./dispatch";
