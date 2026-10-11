// A stand-in for `keryx shell --print`: records what its stdio looks like to the events file named by
// --events-file, then exits. Used by the no-TTY test of the autonomous runner.

import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
const eventsFile = args[args.indexOf("--events-file") + 1];
if (eventsFile === undefined) process.exit(64);
appendFileSync(
  eventsFile,
  `${JSON.stringify({ type: "tty", stdin: process.stdin.isTTY === true, stdout: process.stdout.isTTY === true, answers: process.env["KERYX_AUTONOMOUS_ANSWERS_FILE"] ?? null, system: process.env["KERYX_REVIEW_SYSTEM"] ?? null })}\n`,
);
process.exit(0);
