// One review stop gate evaluation, timed, against a fixture repo. Usage: bun measure-gate.ts <src-root> <fixture-root> <label>
const [srcRoot, fixture, label] = process.argv.slice(2);
const gate = await import(`${srcRoot}/src/review/completion-gate.ts`);
const named = { reviewIds: ["2026-11-04-review-flow-fixture"], roots: [fixture] };
for (const pass of [1, 2]) {
  const before = gate.hashedFileCount();
  const started = performance.now();
  const state = await gate.findReviewGateState(fixture, 0, named);
  const ms = Math.round(performance.now() - started);
  console.log(
    `${label} pass ${pass}: ${ms} ms, hashed-cache ${before} -> ${gate.hashedFileCount()}, package ${state?.reviewId}, signature ${state?.signature.length} chars`,
  );
}
