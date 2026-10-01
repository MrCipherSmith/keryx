# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `buildExternalChildEnv` (src/harness/external/env.ts) strips SSH_AUTH_SOCK, GIT_ASKPASS, SSH_ASKPASS, AWS_SHARED_CREDENTIALS_FILE, GOOGLE_APPLICATION_CREDENTIALS, KUBECONFIG, NETRC, GITHUB_TOKEN, GH_TOKEN and other providers' API keys (e.g. OPENAI_API_KEY for a Gemini child), while keeping the credential the target CLI itself needs; a unit test asserts both directions, and the credential-boundary test's claim matches the behaviour.
- AC2: `SandboxedWebTransport.fetchRaw` never sends `request.credential` to a redirect target whose origin differs from the original request's origin (it drops the credential or refuses the redirect); a test with a cross-origin 302 proves the second hop carries no credential.
- AC3: The spawn_subagent timeout exit passes the child's partial output through the same quarantine/fold used on the other exit paths; a test with instruction-shaped partial output asserts it arrives wrapped.
- AC4: `isDeniedForMcpChild` denies credential-shaped names without an underscore separator (PRIVATEKEY, REFRESHTOKEN, ACCESSTOKEN, APITOKEN, DBPASS) and still allows ordinary variables (PATH, HOME, LANG, TOKENIZERS_PARALLELISM-style non-secrets are decided explicitly in the test).
- AC5: `serverFingerprint` covers the `oauth` block (clientId, scopes, callbackPort), so changing any of them makes a trusted server untrusted; a test asserts it.
- AC6: Aborting the parent turn aborts an in-flight spawn_subagent child, for the sequential path, the concurrent spawn batch (`runConcurrentSpawnBatch`) and the budget wrap-up round (`finishWithBudgetSummary`); tests assert each receives an aborted signal.
- AC7: In keryx shell, a turn that throws still releases the session lease and leaves the bus, and SIGINT/SIGTERM (`closeAndExit`) sweeps tracked background jobs; tests assert both.
- AC8: typecheck, lint and the touched test files pass; CHANGELOG has an entry for the release and package.json is bumped.
