/** Narrow D7 existing-resource controls. Membership alone never authorizes a resource or grants execution. */
export const OWNED_CONTROL_COMMANDS = ["tasks.kill", "demote", "approvals.allow-once", "approvals.deny", "interrupt", "questions.answer"] as const;
export type OwnedControlCommand = typeof OWNED_CONTROL_COMMANDS[number];
export function isOwnedControlCommand(name: string): name is OwnedControlCommand { return OWNED_CONTROL_COMMANDS.some((command) => command === name); }
