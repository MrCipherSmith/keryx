# Decisions

- F-001: acted-on — commit 5fbc78610dd14be87ddd22a7544de4774a4fa233: GRANT_REFRESH_TIMEOUT_MS = 5_000 via AbortSignal.timeout, providers limited to providerArg when given; sequential kept on purpose (each refresh rewrites auth.json) (valid_followup, post_flow_feedback).
- F-002: acted-on — commit 5fbc78610dd14be87ddd22a7544de4774a4fa233: noteSavedCredentialEnv([envKey]) at the picker write; test in src/harness/process/shell-env.test.ts (valid_followup, post_flow_feedback).
- F-003: acted-on — commit 5fbc78610dd14be87ddd22a7544de4774a4fa233: realSelectProviderModel uses envWithSavedApiKeys(process.env) for detection and picking (valid_followup, post_flow_feedback).
- F-004: acted-on — commit 5fbc78610dd14be87ddd22a7544de4774a4fa233: warning 'the saved login has expired and holds no refresh token'; test in src/lib/oauth/refresh-saved-grants.test.ts (valid_followup, post_flow_feedback).
- F-005: acted-on — commit 5fbc78610dd14be87ddd22a7544de4774a4fa233: refresh limited to providerArg; test 'a session on another provider does not wait on the grok token endpoint' (valid_followup, post_flow_feedback).
