// Fixture: HIGH churn × HIGH complexity ⇒ top hotspot.
// Cyclomatic complexity = 1 + 5 decision points = 6.
export function classify(value: number): string {
  if (value < 0) {
    return "negative";
  }
  if (value === 0) {
    return "zero";
  }
  if (value < 10) {
    return "small";
  }
  if (value < 100) {
    return "medium";
  }
  if (value < 1000) {
    return "large";
  }
  return "huge";
}
