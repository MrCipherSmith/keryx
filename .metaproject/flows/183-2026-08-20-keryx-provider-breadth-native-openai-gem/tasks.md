# Tasks

Task definitions live here; task **statuses** live in flow.json and are managed
only via `keryx flow task done <id> <taskId>`.

| ID | Kind | Title |
|----|------|-------|
| T1 | context | Collect remaining context |
| T2 | implement | Implement per plan (umbrella; closed once T5-T9 land) |
| T3 | test | Add/adjust tests and make them pass |
| T4 | review | Self-review and prepare draft PR |
| T5 | implement | Extract `OllamaProvider`'s compat engine into its own module, keep the 8-file blast radius passing unchanged (plan step 1) |
| T6 | implement | `OpenAiProvider`: native adapter targeting the Responses API (plan step 2) |
| T7 | implement | `GeminiProvider`: native adapter targeting `generateContent`/`streamGenerateContent` (plan step 3) |
| T8 | implement | `make-provider.ts`: `openai`/`gemini` named branches, code not compat-registry data (plan step 4) |
| T9 | implement | `select.ts`: add `openai`/`gemini` as first-class picker entries (plan step 5) |
| T10 | test | `.SYNTHETIC.` fixtures for both vendors, sourced from researched wire shapes, provenance documented in a manifest mirroring `fixtures/mcp-client/codex/manifest.json`'s style (plan step 6) |
| T11 | test | SSRF/egress guard test for both new adapters, analogous to `guard.loopback.test.ts` (plan step 7, AC4) |

## AC coverage map

- AC1 (partial, live-verification not met) -> T6, T10
- AC2 (partial, live-verification not met) -> T7, T10
- AC3 -> T5
- AC4 -> T11
- AC5 -> T6, T7, T10 (capability matrix honesty)
- AC6 -> T6, T7 (import audit, no vendor SDK)
