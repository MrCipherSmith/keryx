# Plan — flow 064
- T1 context: shellCommand flag parse + agent branch + rl lifecycle. [done]
- T2 implement: --no-tui; default TUI on TTY agent mode; onStart stdin handoff in launchTuiAgentShell.
- T3 test/smoke: non-TTY runs readline; --no-tui forces readline; tsc; bun test.
- T4 verify.
