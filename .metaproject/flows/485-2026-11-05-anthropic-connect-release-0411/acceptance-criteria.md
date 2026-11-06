# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- Every criterion ends with [verify: exec `<command>`],
  [verify: invariant `<command>`], [verify: judged] or
  [verify: none — <reason>].
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: connectionProviderByName("anthropic") возвращает ANTHROPIC_PICKER, и тесты src/commands/providers.anthropic.test.ts проходят в main d5de38e78 [verify: exec `bun test src/commands/providers.anthropic.test.ts` · sensitive: mutation]
