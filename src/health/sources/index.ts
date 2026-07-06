import { eslintAdapter } from "./eslint";
import { typescriptAdapter } from "./typescript";
import { testsAdapter } from "./tests";
import { dependencyAuditAdapter } from "./dependency-audit";
import type { SourceAdapter } from "../types";

// Finding-producing adapters (Core-5 minus coverage, which is a metric source).
export const FINDING_ADAPTERS: SourceAdapter[] = [
  eslintAdapter,
  typescriptAdapter,
  testsAdapter,
  dependencyAuditAdapter,
];

export { NoImportError } from "./helpers";
