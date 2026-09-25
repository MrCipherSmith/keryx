# Acceptance Criteria
Version: 0.1.0

- AC1: Shell offers OpenAI API (`openai`) and ChatGPT / Codex (`openai-codex`) separately even before credentials exist; API-key credentials never authenticate the subscription provider and subscription grants never become OPENAI_API_KEY.
- AC2: Selecting the subscription provider initiates device authorization, shows a verification URL and user code, opens the browser when possible, supports cancellation and bounded timeout, and reports errors without secrets.
- AC3: A successful subscription login persists its credential securely and enables native streamed model responses and tool calls against the verified Codex subscription endpoint, not the Platform API or FakeProvider.
- AC4: Expired/expiring subscription credentials refresh with rotation persisted; refresh failures produce actionable login errors. Legacy `openai` OAuth grants remain usable via explicit compatibility migration/fallback without affecting API keys.
- AC5: Model selection, connection status, test, disconnect, and restart distinguish API-key and subscription providers; disconnecting one does not remove the other credential.
- AC6: Deterministic offline integration tests cover login -> saved credential -> provider -> streamed answer/tool call, refresh, cancellation/error paths, and API-provider regression. Focused tests, typecheck, lint and build pass.
- AC7: Documentation explains the two providers, correct Shell command, device login prerequisite, verification steps, and honestly states that live Pro-account validation awaits the user; no release is published.
