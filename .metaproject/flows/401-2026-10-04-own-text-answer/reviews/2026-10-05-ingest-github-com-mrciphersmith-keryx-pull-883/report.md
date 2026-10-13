# Review of PR #883 (flow 401), head de2b8be0

The non-test source diff of PR #883 (own-text answer in the shell and Telegram) was read in full: `AskAnswer` and `storedOperatorText` (redaction, secret-run masking, one line, 2000-character cap), the `prompt-close` route, the ForceReply own-answer flow with its five-minute window, `ChoiceAnswer` kinds in `askChoice`, the shell race between dock and topic (`raceAskUser`), the composer text step (Esc goes back, Enter sends, whitespace refused, typed text never logged), the transcript answer line, the decisions report `annotated` rows and the sidebar mark. No defect was confirmed that would change behaviour: aborts and settle paths are idempotent, a typed answer is redacted before it reaches the screen or the journal, and the topic leg's silence never closes the dock.

Two low-confidence observations were not raised as findings because neither could be reproduced from the diff alone: a late frame arriving after a client timeout is parked as before this change, and the reason-less `option` branch of the answer mapping is the pre-existing behaviour.

```json keryx:findings
[]
```
