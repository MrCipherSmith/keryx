// Fixture (flow 239, AC-20): a core-owner module reaching only a shared
// primitive — the allowed counterpart to forbidden-owner-imports-client/.
import { shared } from "../lib/shared";
// Genuinely consumed — see forbidden-owner-imports-client/gdgraph/entry.ts
// for why a pure re-export does not survive the bundler's tree-shaking.
export const usesShared = `entry:${shared}`;
