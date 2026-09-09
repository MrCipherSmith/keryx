// Fixture stand-in for a core owner's private internal module, sitting BEHIND
// the facade. The client entry never imports this file; it imports
// `service.ts`, which does. Under direct edges that is the allowed shape.
export const detail = "core-internal-behind-the-facade";
