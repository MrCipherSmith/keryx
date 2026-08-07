# Flow 3 — the scriptable door is real
Version: 1.0.0

Covers D3, D4, D5. Independent of flows 1 and 2; can run in parallel with flow 1.

Three small corrections that travel together only because they share one file and
one test surface. None of them is interesting on its own; together they are the
difference between a CLI that can be scripted and one that cannot.

## Flow setup

```bash
keryx flow init --title "The scriptable door: tools on the non-interactive path, providers from the registry, declared model ids"
```

```bash
keryx flow task add <id> --title "T1 register read-only tools on harness run" --kind implement
keryx flow task add <id> --title "T2 provider validation from OPENAI_COMPAT_PROVIDERS" --kind implement
keryx flow task add <id> --title "T3 stop defaulting to an undeclared model id" --kind implement
keryx flow task add <id> --title "T4 tests" --kind test
keryx flow task add <id> --title "T5 CLI reference correction and draft PR" --kind review
keryx flow freeze <id> && keryx flow start <id>
```

## Acceptance criteria — paste verbatim

```
- AC1: `keryx harness run` registers the read-only metaproject tools, and a non-interactive run can execute at least one of them end to end. A test asserts a tool result appears in the run output.
- AC2: `keryx harness run --provider <p>` accepts every provider the registry declares, including the OpenAI-compatible gateways, and a test enumerates them from `OPENAI_COMPAT_PROVIDERS` rather than from a literal list in the test.
- AC3: An unknown provider is still refused with the usage message, asserted by a test.
- AC4: `docs/docs/cli-reference.md` states the accepted providers correctly, in the same pull request as the code change. `check:doc-links` passes.
- AC5: No provider-registry default names a model id the provider does not list. A test asserts each declared default is present in that provider's declared model set, or the entry carries an explicit comment saying why it cannot be checked offline.
- AC6: The fail-closed credential behaviour is unchanged: a provider requiring a credential still aborts before any network call when it is absent. A test asserts it.
- AC7: `bun run check` passes; no test skipped or weakened.
```

## Files

| Task | File | Change |
|---|---|---|
| T1 | `src/commands/harness.ts` (~247) | Replace the "Release 0 CLI runs register no tools" refusal with the read-only metaproject registration |
| T2 | `src/commands/harness.ts` (~318) | Replace `new Set(["fake","anthropic","ollama"])` with the registry |
| T2 | `src/commands/providers.ts` | Export whatever the validation needs; do not duplicate the list |
| T3 | `src/commands/providers.ts` | Declared model ids only |
| T5 | `docs/docs/cli-reference.md` | The `harness run` provider line |

## Note on scope

D4 is the same class of defect as the 0.2.15 audit: code and documentation
disagreeing, with the documentation being the optimistic one. Fixing the code and
leaving the reference stale would only move the divergence, which is why AC4
requires both in one pull request.

## Definition of done

AC1–AC7 confirmed with evidence, draft PR, review, merge, `flow complete`.
