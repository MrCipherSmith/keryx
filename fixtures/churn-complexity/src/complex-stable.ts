// Fixture: HIGH complexity but LOW churn ⇒ ranks low despite complexity.
// Cyclomatic complexity = 1 + 5 decision points = 6.
export function grade(score: number): string {
  if (score >= 90) {
    return "A";
  }
  if (score >= 80) {
    return "B";
  }
  if (score >= 70) {
    return "C";
  }
  if (score >= 60) {
    return "D";
  }
  if (score >= 50) {
    return "E";
  }
  return "F";
}
