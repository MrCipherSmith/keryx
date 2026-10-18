/**
 * The harness tools whose `command` argument is a shell line the session executes: `shell_exec`, and `shell`, the name
 * an approval meta and an older history may carry for it. The one list the approval-cause classifier and the review
 * completion gate read, so a new shell tool is added in one place. `bash` is deliberately absent: it is another agent
 * host's tool name, and no keryx harness tool is registered under it (the shell tool is `shell_exec`); a host that
 * registers one adds its name here.
 */
export const SHELL_TOOL_NAMES: ReadonlySet<string> = new Set(["shell_exec", "shell"]);
