// Flow 308 (W8, Lane B, T6): the shared builder behind `keryx test related
// <file> --json`. Read-only — computes the testing context and the
// relatedness lookup the same way `runRelated` (src/commands/test.ts) already
// does, and returns exactly what that command's `--json` flag prints.
//
// Core zone (`src/lib/import-zones.ts`): no import from `src/commands` or any
// other adapter.

import { computeTestingContext, relatedTestsInContext } from "./service";

export interface RelatedTestsReport {
  schemaVersion: 1;
  target: string;
  context: {
    status: "complete" | "incomplete";
    incompleteReasons: string[];
  };
  related: string[];
}

export async function buildRelatedTestsReport(root: string, target: string): Promise<RelatedTestsReport> {
  const context = await computeTestingContext(root);
  const related = await relatedTestsInContext(root, context, target);
  return {
    schemaVersion: 1,
    target,
    context: {
      status: context.status,
      incompleteReasons: context.incompleteReasons,
    },
    related,
  };
}
