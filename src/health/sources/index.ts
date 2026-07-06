import { eslintAdapter } from "./eslint";
import { typescriptAdapter } from "./typescript";
import { testsAdapter } from "./tests";
import { dependencyAuditAdapter } from "./dependency-audit";
import { sonarqubeAdapter } from "./sonarqube";
import type { SourceAdapter } from "../types";

// Finding-producing adapters. Core-5 (minus coverage, a metric source) plus the
// SonarQube adapter (import-oriented, disabled by default).
export const FINDING_ADAPTERS: SourceAdapter[] = [
  eslintAdapter,
  typescriptAdapter,
  testsAdapter,
  dependencyAuditAdapter,
  sonarqubeAdapter,
];

export { NoImportError } from "./helpers";
