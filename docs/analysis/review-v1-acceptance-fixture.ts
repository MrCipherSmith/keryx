export function passingChecks(checks: readonly boolean[]): number {
  return checks.filter(Boolean).length;
}
