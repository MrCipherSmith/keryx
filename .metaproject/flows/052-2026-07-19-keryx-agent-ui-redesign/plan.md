# Plan — flow 052
- T1 context: locate the double-prompt (printHeader + runAgentRepl both print), header/banner, role headers. [done]
- T2 implement: remove runAgentRepl initial prompt; minimal printHeader; unify ● keryx headers; tidy spacing.
- T3 verify: tsc; bun test >= baseline; NO_COLOR plain-path check; cli smoke; live smoke = user.
