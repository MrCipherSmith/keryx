# Plan — flow 062
- T1 context: SelectRenderable options/visible/getSelectedOption, Input INPUT event, KeyHandler. [done]
- T2 implement: agent-commands.ts (registry + filterCommands + findAgentCommand); wire live menu + submit handling in launchTuiAgentShell.
- T3 test: filterCommands/findAgentCommand units + headless reactivity (type /h → menu shows /help).
- T4 verify: tsc; bun test >= baseline.
