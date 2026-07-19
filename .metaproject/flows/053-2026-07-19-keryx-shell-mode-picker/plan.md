# Plan — flow 053
- T1 context: pickProviderModel IO contract, shellCommand flag/mode flow, header modeLabel. [done]
- T2 implement: pickAgentMode in select.ts; --chat + agent-default + mode step in shellCommand; explicit header label.
- T3 test: pickAgentMode unit tests (agent/chat/reprompt/EOF/empty).
- T4 verify: tsc; bun test >= baseline; cli smoke.
