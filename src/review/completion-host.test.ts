import { expect, test } from "bun:test";
import { reviewCompletionQuestion, validateCompletionHost } from "./completion-host";
import type { HostQuestion } from "./types";
const context = {
  reviewId: "review-469", head: "a".repeat(40),
  report: "Evidence level: static only — did not run: network tests",
  manifest: { readiness_waivers: [{ item: "files-covered", operator_quote: "known files" }] },
  research: '{"coverageWaiver":{"operatorQuote":"known gap"}}', findings: "[]", decisions: "[]",
  dispositions: [{ finding: "F-1", state: "acted-on", evidence: "commit abcdef0" }],
  waiveReadiness: [{ items: ["quotes-located"], quote: "known imported quote" }],
  waiveCoverage: "known coverage",
};
function host(questionText = reviewCompletionQuestion(context)): HostQuestion {
  return { source: "codex", ref: "question-469", questionText, answerText: "yes", time: "2026-10-20T12:00:00Z" };
}
test("review completion question displays head, evidence, dispositions and every waiver", () => {
  const question = reviewCompletionQuestion(context);
  for (const text of [context.head, "static-only", "network tests", "F-1", "acted-on", "abcdef0", "known files", "known gap", "known imported quote", "known coverage"]) expect(question).toContain(text);
  expect(validateCompletionHost(context, host(), [])).toEqual({ ok: true });
});
test("review completion refuses stale head, evidence, disposition, waiver or package content", () => {
  const answer = host();
  for (const changed of [{ head: "b".repeat(40) }, { report: context.report + "; integration tests" }, { dispositions: [] }, { waiveCoverage: "changed reason" }, { research: "{}" }, { findings: '[{"id":"F-2"}]' }, { decisions: '["changed"]' }]) expect(validateCompletionHost({ ...context, ...changed }, answer, []).ok).toBe(false);
});
test("review completion refuses decline, hidden text, unbound question and replay", () => {
  for (const answer of [{ ...host(), answerText: "no" }, { ...host(), answerText: "yes but no" }, { ...host(), answerText: "yes\u200b" }, host("Close review-469?")]) expect(validateCompletionHost(context, answer, []).ok).toBe(false);
  expect(validateCompletionHost(context, host(), [host()]).ok).toBe(false);
});

test("host completion binds coverage decision inputs", () => {
  const current = { ...context, coverage: { "scope-files.json": "first scope", "coverage.md": "reviewed" } };
  const answer = host(reviewCompletionQuestion(current));
  expect(validateCompletionHost(current, answer, []).ok).toBe(true);
  expect(validateCompletionHost({ ...current, coverage: { ...current.coverage, "scope-files.json": "different scope" } }, answer, []).ok).toBe(false);
});
