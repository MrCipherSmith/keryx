# Decisions

- F-001: acted-on — declaredCredentialEnvKeys() added to src/lib/shell-config.ts, buildMcpChildEnv's strip changed to the union of the runtime singleton and the disk-declared names, and configDir threaded through defaultConnect — all in the fix-round commit inside squash-merge 6b5c7d2c6c6e0658f5cd6f34b4487eddd84f6df7 (PR #657), proved by the new src/mcp-servers/declared-credentials.process.test.ts. (valid_followup, post_flow_feedback).
