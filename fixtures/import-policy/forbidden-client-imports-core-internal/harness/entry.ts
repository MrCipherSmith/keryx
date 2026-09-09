// Fixture (flow 239, AC-20): a client module reaching a core owner's
// INTERNAL module directly, bypassing its `service.ts` facade — "клиент не
// импортирует private core" (AFC-19), violated on purpose.
import { internal } from "../gdgraph/internal";
// Genuinely consumed — see forbidden-owner-imports-client/gdgraph/entry.ts
// for why a pure re-export does not survive the bundler's tree-shaking.
export const usesInternal = `entry:${internal}`;
