// Flow 467: the review verbs that record an operator decision and so accept `--answered-by`. Owned here, not in
// `commands/review-operator.ts`, because the unattended floor (`trigger/unattended.ts`) needs it and a core owner must not
// import a command module. `OPERATOR_COMMANDS` is these verbs plus `verify-run`; `review-host-question.test.ts` fails when
// the two drift.

export const HOST_QUESTION_VERBS = ["waive-mutation", "override-reviewers", "confirm-plan", "decide-premise"] as const;
