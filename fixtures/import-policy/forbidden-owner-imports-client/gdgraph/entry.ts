// Fixture (flow 239, AC-20): a core-owner module statically reaching into a
// client zone. "Владельцы не импортируют CLI/MCP/Shell" (specification.md
// §2) — this file exists to violate exactly that, so the check under test
// has something real to catch.
import { leaf } from "../harness/leaf";
// Genuinely consumed, not just re-exported — a pure re-export of an unused
// binding is tree-shaken out of the built graph, which would make this
// fixture prove nothing (measured while writing this check: `scanned` stayed
// at 1, the entry alone, until this line existed).
export const usesLeaf = `entry:${leaf}`;
