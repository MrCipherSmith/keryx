# Pinned source/history for premise judgment
Head: 5974c976823e1a7134723edf3a9140b991246d45
No runtime execution performed. Security-origin consent observation SEC-W2-001 merged into LOGIC-W3-001; do not lose the security-origin severity protection.

## CC-W2-001 — src/commands/review-operator.ts
Quote locator: 343
```
5974c97682 (MrCipherSmith 2026-10-19 19:44:51 +0000 339)     throw new Error(`keryx review ${command} --answered-by is refused in an unattended run: nobody is there to be asked, so nothing was recorded.`);
5974c97682 (MrCipherSmith 2026-10-19 19:44:51 +0000 340)   }
5974c97682 (MrCipherSmith 2026-10-19 19:44:51 +0000 341) }
5974c97682 (MrCipherSmith 2026-10-19 19:44:51 +0000 342) 
5974c97682 (MrCipherSmith 2026-10-19 19:44:51 +0000 343) async function recordHostQuestion(
5974c97682 (MrCipherSmith 2026-10-19 19:44:51 +0000 344)   command: HostVerb,
5974c97682 (MrCipherSmith 2026-10-19 19:44:51 +0000 345)   own: string[],
5974c97682 (MrCipherSmith 2026-10-19 19:44:51 +0000 346)   packageDir: string,
5974c97682 (MrCipherSmith 2026-10-19 19:44:51 +0000 347)   context: { cwd: string; log: (line: string) => void; env: Readonly<Record<string, string | undefined>> },
5974c97682 (MrCipherSmith 2026-10-19 19:44:51 +0000 348) ): Promise<number> {
5974c97682 (MrCipherSmith 2026-10-19 19:44:51 +0000 349)   const { cwd, log, env } = context;
5974c97682 (MrCipherSmith 2026-10-19 19:44:51 +0000 350)   refuseHostQuestionHere(command, packageDir, env);
5974c97682 (MrCipherSmith 2026-10-19 19:44:51 +0000 351)   const by = parseAnsweredBy(optionValue(own, "--answered-by"), command);

```
```
5974c9768 feat(review): record operator acts answered by the host's own question
cb32ce532 refactor: cardSafe lives in src/lib, not trigger/schedules (flow 459 round 2, owner decision)
3cb8ded48 fix(review): review round 2 findings (flow 459)
cc8f06319 fix(review): review round 1 findings on premise code (flow 459)

```

## CC-W3-001 — src/review/estimate.ts
Quote locator: 189
```
7a84e0dfaa (MrCipherSmith 2026-10-16 02:08:15 +0400 185) // Plan confirmation: `<package>/plan-confirmation.json`, written by the `review_confirm_plan` card (keryx shell) or by
7a84e0dfaa (MrCipherSmith 2026-10-16 02:08:15 +0400 186) // `keryx review estimate --confirm --quote` at a terminal. Nothing else may write it.
7a84e0dfaa (MrCipherSmith 2026-10-16 02:08:15 +0400 187) // ---------------------------------------------------------------------------
7a84e0dfaa (MrCipherSmith 2026-10-16 02:08:15 +0400 188) 
5974c97682 (MrCipherSmith 2026-10-19 19:44:51 +0000 189) export type PlanConfirmedVia = "tui-card" | "remote-card" | "terminal" | "host-question";
5974c97682 (MrCipherSmith 2026-10-19 19:44:51 +0000 190) const CONFIRMED_VIA: readonly PlanConfirmedVia[] = ["tui-card", "remote-card", "terminal", "host-question"];
7a84e0dfaa (MrCipherSmith 2026-10-16 02:08:15 +0400 191) 
7a84e0dfaa (MrCipherSmith 2026-10-16 02:08:15 +0400 192) export type PlanConfirmation = {
7a84e0dfaa (MrCipherSmith 2026-10-16 02:08:15 +0400 193)   planKey: string;
7a84e0dfaa (MrCipherSmith 2026-10-16 02:08:15 +0400 194)   dispatches: number;
7a84e0dfaa (MrCipherSmith 2026-10-16 02:08:15 +0400 195)   minutes: [number, number];
7a84e0dfaa (MrCipherSmith 2026-10-16 02:08:15 +0400 196)   quote: string;
7a84e0dfaa (MrCipherSmith 2026-10-16 02:08:15 +0400 197)   confirmedVia: PlanConfirmedVia;

```
```
5974c9768 feat(review): record operator acts answered by the host's own question
1735646be feat(operator-confirm): record who pressed a remote card and enforce the allowed list and 1-hour TTL
6b1e9321f fix(review): review round 3 findings (flow 460)
ddd2a91d7 fix(review): review round 2 — gates, routing, ingest, completion gate (flow 460)

```

## HL-W2-001 — src/commands/review-operator.ts
Quote locator: 430
```
5974c97682 (MrCipherSmith 2026-10-19 19:44:51 +0000 426)       options: choices.options,
5974c97682 (MrCipherSmith 2026-10-19 19:44:51 +0000 427)       stage: `review ${command}`,
5974c97682 (MrCipherSmith 2026-10-19 19:44:51 +0000 428)       channel: by.source,
5974c97682 (MrCipherSmith 2026-10-19 19:44:51 +0000 429)       source: DECISION_SOURCES.hostQuestion,
5974c97682 (MrCipherSmith 2026-10-19 19:44:51 +0000 430)       hostQuestion: { source: by.source, ref: by.ref, verb: command, answerText },
5974c97682 (MrCipherSmith 2026-10-19 19:44:51 +0000 431)       salt: "host-question",
5974c97682 (MrCipherSmith 2026-10-19 19:44:51 +0000 432)     });
5974c97682 (MrCipherSmith 2026-10-19 19:44:51 +0000 433)     await answerDecision({ cwd, id: opened.id, choice: premiseAnswer ?? choices.confirm });
5974c97682 (MrCipherSmith 2026-10-19 19:44:51 +0000 434)   } catch (error) {
5974c97682 (MrCipherSmith 2026-10-19 19:44:51 +0000 435)     log(`warning: the answer is recorded, but the keryx decisions journal was not updated (${error instanceof Error ? error.message : String(error)})`);
5974c97682 (MrCipherSmith 2026-10-19 19:44:51 +0000 436)   }
5974c97682 (MrCipherSmith 2026-10-19 19:44:51 +0000 437)   return 0;
5974c97682 (MrCipherSmith 2026-10-19 19:44:51 +0000 438) }

```
```
5974c9768 feat(review): record operator acts answered by the host's own question
cb32ce532 refactor: cardSafe lives in src/lib, not trigger/schedules (flow 459 round 2, owner decision)
3cb8ded48 fix(review): review round 2 findings (flow 459)
cc8f06319 fix(review): review round 1 findings on premise code (flow 459)

```

## LOGIC-W3-001 — src/commands/review-operator.ts
Quote locator: 304
```
5974c97682 (MrCipherSmith 2026-10-19 19:44:51 +0000 300) 
5974c97682 (MrCipherSmith 2026-10-19 19:44:51 +0000 301) /** The operator's words refuse when they decline (an empty answer, n, no, nope, ...). The message names the refusal. */
5974c97682 (MrCipherSmith 2026-10-19 19:44:51 +0000 302) function refuseDecline(answerText: string, verb: HostVerb): void {
5974c97682 (MrCipherSmith 2026-10-19 19:44:51 +0000 303)   const words = wordsOf(answerText);
5974c97682 (MrCipherSmith 2026-10-19 19:44:51 +0000 304)   if (words.length === 0 || LEAD_DECLINE.has(words[0] as string)) {
5974c97682 (MrCipherSmith 2026-10-19 19:44:51 +0000 305)     throw new Error(`--answer-text reads as a decline (${JSON.stringify(answerText.trim().slice(0, 80))}): a declined question records nothing. Ask again if the operator meant yes. See \`keryx review ${verb} --help\`.`);
5974c97682 (MrCipherSmith 2026-10-19 19:44:51 +0000 306)   }
5974c97682 (MrCipherSmith 2026-10-19 19:44:51 +0000 307) }
5974c97682 (MrCipherSmith 2026-10-19 19:44:51 +0000 308) 
5974c97682 (MrCipherSmith 2026-10-19 19:44:51 +0000 309) /** decide-premise: the words must name the chosen option and not the other one, and not behind a negation. */
5974c97682 (MrCipherSmith 2026-10-19 19:44:51 +0000 310) function refuseOtherChoice(answerText: string, answer: "uphold" | "dismiss"): void {
5974c97682 (MrCipherSmith 2026-10-19 19:44:51 +0000 311)   const words = wordsOf(answerText);
5974c97682 (MrCipherSmith 2026-10-19 19:44:51 +0000 312)   const other = answer === "uphold" ? "dismiss" : "uphold";

```
```
5974c9768 feat(review): record operator acts answered by the host's own question
cb32ce532 refactor: cardSafe lives in src/lib, not trigger/schedules (flow 459 round 2, owner decision)
3cb8ded48 fix(review): review round 2 findings (flow 459)
cc8f06319 fix(review): review round 1 findings on premise code (flow 459)

```

## PC-W3-001 — src/commands/review-operator.ts
Quote locator: 435
```
5974c97682 (MrCipherSmith 2026-10-19 19:44:51 +0000 431)       salt: "host-question",
5974c97682 (MrCipherSmith 2026-10-19 19:44:51 +0000 432)     });
5974c97682 (MrCipherSmith 2026-10-19 19:44:51 +0000 433)     await answerDecision({ cwd, id: opened.id, choice: premiseAnswer ?? choices.confirm });
5974c97682 (MrCipherSmith 2026-10-19 19:44:51 +0000 434)   } catch (error) {
5974c97682 (MrCipherSmith 2026-10-19 19:44:51 +0000 435)     log(`warning: the answer is recorded, but the keryx decisions journal was not updated (${error instanceof Error ? error.message : String(error)})`);
5974c97682 (MrCipherSmith 2026-10-19 19:44:51 +0000 436)   }
5974c97682 (MrCipherSmith 2026-10-19 19:44:51 +0000 437)   return 0;
5974c97682 (MrCipherSmith 2026-10-19 19:44:51 +0000 438) }

```
```
5974c9768 feat(review): record operator acts answered by the host's own question
cb32ce532 refactor: cardSafe lives in src/lib, not trigger/schedules (flow 459 round 2, owner decision)
3cb8ded48 fix(review): review round 2 findings (flow 459)
cc8f06319 fix(review): review round 1 findings on premise code (flow 459)

```

## STYLE-W3-001 — src/commands/review-operator.ts
Quote locator: 237
```
5974c97682 (MrCipherSmith 2026-10-19 19:44:51 +0000 233) // ---------------------------------------------------------------------------------------------------------------------
5974c97682 (MrCipherSmith 2026-10-19 19:44:51 +0000 234) 
5974c97682 (MrCipherSmith 2026-10-19 19:44:51 +0000 235) type HostVerb = Exclude<OperatorCommand, "verify-run">;
5974c97682 (MrCipherSmith 2026-10-19 19:44:51 +0000 236) 
5974c97682 (MrCipherSmith 2026-10-19 19:44:51 +0000 237) /** The options of the question each verb records: the one that records the decision, the one that declines it. */
5974c97682 (MrCipherSmith 2026-10-19 19:44:51 +0000 238) const HOST_OPTIONS: Record<HostVerb, { confirm: string; decline: string; options: Array<{ id: string; label: string }> }> = {
5974c97682 (MrCipherSmith 2026-10-19 19:44:51 +0000 239)   "decide-premise": {
5974c97682 (MrCipherSmith 2026-10-19 19:44:51 +0000 240)     confirm: "uphold",
5974c97682 (MrCipherSmith 2026-10-19 19:44:51 +0000 241)     decline: "dismiss",
5974c97682 (MrCipherSmith 2026-10-19 19:44:51 +0000 242)     options: [
5974c97682 (MrCipherSmith 2026-10-19 19:44:51 +0000 243)       { id: "uphold", label: "Uphold: the finding stands at its original severity" },
5974c97682 (MrCipherSmith 2026-10-19 19:44:51 +0000 244)       { id: "dismiss", label: "Dismiss: the finding is incorrect" },
5974c97682 (MrCipherSmith 2026-10-19 19:44:51 +0000 245)     ],

```
```
5974c9768 feat(review): record operator acts answered by the host's own question
cb32ce532 refactor: cardSafe lives in src/lib, not trigger/schedules (flow 459 round 2, owner decision)
3cb8ded48 fix(review): review round 2 findings (flow 459)
cc8f06319 fix(review): review round 1 findings on premise code (flow 459)

```

## STYLE-W4-001 — src/review/estimate.ts
Quote locator: 206
```
5974c97682 (MrCipherSmith 2026-10-19 19:44:51 +0000 202)   /** Flow 467: the question the host asked and the answer that came back; set only with `confirmedVia: "host-question"`. */
5974c97682 (MrCipherSmith 2026-10-19 19:44:51 +0000 203)   hostQuestion?: HostQuestion | undefined;
7a84e0dfaa (MrCipherSmith 2026-10-16 02:08:15 +0400 204) };
7a84e0dfaa (MrCipherSmith 2026-10-16 02:08:15 +0400 205) 
5974c97682 (MrCipherSmith 2026-10-19 19:44:51 +0000 206) function isHostQuestion(value: unknown): boolean {
5974c97682 (MrCipherSmith 2026-10-19 19:44:51 +0000 207)   if (value === null || typeof value !== "object") return false;
5974c97682 (MrCipherSmith 2026-10-19 19:44:51 +0000 208)   const hq = value as Record<string, unknown>;
5974c97682 (MrCipherSmith 2026-10-19 19:44:51 +0000 209)   const filled = (field: unknown): boolean => typeof field === "string" && field.trim() !== "";
5974c97682 (MrCipherSmith 2026-10-19 19:44:51 +0000 210)   return (HOST_QUESTION_SOURCES as readonly unknown[]).includes(hq.source) && filled(hq.ref) && filled(hq.questionText) && filled(hq.answerText) && filled(hq.time);
5974c97682 (MrCipherSmith 2026-10-19 19:44:51 +0000 211) }
5974c97682 (MrCipherSmith 2026-10-19 19:44:51 +0000 212) 
7a84e0dfaa (MrCipherSmith 2026-10-16 02:08:15 +0400 213) function isPlanConfirmation(value: unknown): value is PlanConfirmation {
7a84e0dfaa (MrCipherSmith 2026-10-16 02:08:15 +0400 214)   if (value === null || typeof value !== "object" || Array.isArray(value)) return false;

```
```
5974c9768 feat(review): record operator acts answered by the host's own question
1735646be feat(operator-confirm): record who pressed a remote card and enforce the allowed list and 1-hour TTL
6b1e9321f fix(review): review round 3 findings (flow 460)
ddd2a91d7 fix(review): review round 2 — gates, routing, ingest, completion gate (flow 460)

```
