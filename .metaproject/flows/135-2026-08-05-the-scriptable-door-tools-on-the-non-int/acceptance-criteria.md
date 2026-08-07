# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `keryx harness run` registers the read-only metaproject tools, and a non-interactive run can execute at least one of them end to end. A test asserts a tool result appears in the run output.
- AC2: `keryx harness run --provider <p>` accepts every provider the registry declares, including the OpenAI-compatible gateways, and a test enumerates them from `OPENAI_COMPAT_PROVIDERS` rather than from a literal list in the test.
- AC3: An unknown provider is still refused with the usage message, asserted by a test.
- AC4: `docs/docs/cli-reference.md` states the accepted providers correctly, in the same pull request as the code change. `check:doc-links` passes.
- AC5: No provider-registry default names a model id the provider does not list. A test asserts each declared default is present in that provider's declared model set, or the entry carries an explicit comment saying why it cannot be checked offline.
- AC6: The fail-closed credential behaviour is unchanged: a provider requiring a credential still aborts before any network call when it is absent. A test asserts it.
- AC7: `bun run check` passes; no test skipped or weakened.
