// The shape a class table has to have, as code rather than as a sentence.
//
// The class-table pattern is this package's answer to a defect that four
// review rounds could not converge on: every fix was correct at the site it
// was reported and wrong one step to the side, because the acceptance
// criterion in use — "does the reported reproduction now pass" — is
// satisfied by a fix that only knows about the reproduction. Testing the
// CLASS instead of the example is the criterion that does converge.
//
// A class table only converges if it has a shape, and the shape was being
// enforced two ways that both turned out to enforce nothing:
//
//   - the boundary check inside the table read
//     `refused > 0 || allowed > 0`, which is true of any class with at
//     least one row. With the intended `&&`, two of four classes failed;
//   - `invariants.test.ts` "enforced" the pattern across tables by
//     asserting the STRING `"every class carries a BOUNDARY"` appeared in
//     the file. Renaming the test would have satisfied it; deleting the
//     assertion inside the test would not have broken it.
//
// Both are the same mistake as the one the pattern exists to prevent, one
// level up. So the rule lives here, once, as a function with a return
// value — and `invariants.test.ts` proves the function has teeth by
// feeding it a table that violates each rule, which is a thing a string
// match cannot do.

export type ClassGroup<Row> = {
  readonly klass: string;
  readonly rows: readonly Row[];
};

export type ClassTableRules = {
  /** Fewest rows a class may have and still be a class. */
  readonly minRows?: number;
};

/**
 * Every way the table falls short, as sentences. Empty means it holds.
 *
 * `outcomeOf` labels a row with what it asserts — "refused"/"allowed",
 * "stripped"/"kept". A class whose rows all carry the same label has no
 * boundary, and a rule that only ever says yes could be `() => true`.
 */
export function classTableProblems<Row>(
  table: readonly ClassGroup<Row>[],
  outcomeOf: (row: Row) => string,
  rules: ClassTableRules = {},
): string[] {
  const minRows = rules.minRows ?? 3;
  const problems: string[] = [];

  if (table.length === 0) problems.push("the table has no classes");

  for (const { klass, rows } of table) {
    if (rows.length < minRows) {
      problems.push(`${klass}: ${rows.length} row(s), fewer than the ${minRows} a class needs`);
    }
    const outcomes = new Set(rows.map(outcomeOf));
    if (outcomes.size < 2) {
      problems.push(
        `${klass}: every row comes out "${[...outcomes][0] ?? "—"}" — no BOUNDARY, so the rule could be a constant`,
      );
    }
  }

  const names = table.map((g) => g.klass);
  const duplicated = names.filter((n, i) => names.indexOf(n) !== i);
  for (const name of new Set(duplicated)) {
    problems.push(`${name}: two classes share this name, so one of them is not a class`);
  }

  return problems;
}
