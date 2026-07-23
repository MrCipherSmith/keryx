# Plan — P0

1. Add pure `resolveCredentialMasks` in `src/harness/process/sandbox/mask-resolve.ts` + unit tests AC1–AC6.
2. Add shared helpers: parse maskMode (default manual), tlsExplicit from env, buildDefaultMaskProviders.
3. Wire shell-exec restricted path through resolver → setupNetworkRun.
4. Wire harness exec parse flags --mask-mode / --auto-mask + same resolver.
5. AC7/AC8 via exported shell/harness input builders or pure golden tests.
6. Note in package README: P0.a runtime landed when green; P1/P2/Verify still draft.
