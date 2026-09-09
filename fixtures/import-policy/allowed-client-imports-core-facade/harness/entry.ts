// Fixture (flow 239, AC-20): a client module reaching a core owner strictly
// through its declared public facade, `service.ts` — the allowed counterpart
// to forbidden-client-imports-core-internal/.
import { serve } from "../gdgraph/service";
// Genuinely consumed — see forbidden-owner-imports-client/gdgraph/entry.ts
// for why a pure re-export does not survive the bundler's tree-shaking.
export const usesServe = `entry:${serve}`;
