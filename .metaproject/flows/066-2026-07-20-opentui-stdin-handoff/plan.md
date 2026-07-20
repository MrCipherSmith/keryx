# Plan — flow 066
- T1 context: flow-065 report root cause; launchTuiAgentShell order. [done]
- T2 implement: onBeforeInit (release rl before createCliRenderer); shellCommand passes rl.close() as onBeforeInit.
- T3 verify: tsc; bun test; default→readline smoke; real-TTY validation handed to user.
