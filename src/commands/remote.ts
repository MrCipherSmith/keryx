// `keryx remote format-sample` (flow 395): print the fixed sample reply the way each Telegram
// rendering mode would send it. No network, no bot token, no session: it runs the same rendering
// code as the outbound path and stops before the Bot API call, so an operator can see what a mode
// does to a table, a list and a rule before choosing one (`/rendering`, or the /settings row).

import { optionValue } from "../lib/args";
import { formatSampleText, renderAllSamples, renderSample, SAMPLE_REPLY } from "../remote/rendering-sample";
import { isRenderMode, RENDER_MODE_CHOICES, RENDER_MODES } from "../remote/rendering-mode";

export const REMOTE_USAGE = `keryx remote format-sample — show the sample reply in every Telegram rendering mode (no network)

Usage:
  keryx remote format-sample [--mode ${RENDER_MODES.join("|")}] [--full] [--json]

--mode  Only that mode. Without it all four are printed.
--full  Print the whole rich message (JSON) instead of a count of its blocks.
--json  Machine-readable: the sample source and, per mode, each part with how it is sent.

The mode in effect for a running session is set with \`/rendering\` in the shell, or the
"Telegram rendering" row of \`/settings\`; \`/channels\` shows it together with the last fallback.
`;

export function remoteCommand(args: string[]): void {
  const [sub, ...rest] = args;
  if (sub === undefined || sub === "--help" || sub === "-h" || sub === "help") {
    console.log(REMOTE_USAGE);
    return;
  }
  if (sub !== "format-sample") {
    console.error(`keryx remote: unknown subcommand '${sub}'. Try \`keryx remote format-sample\`.`);
    process.exitCode = 1;
    return;
  }
  const wanted = optionValue(rest, "--mode");
  if (wanted !== undefined && !isRenderMode(wanted)) {
    console.error(`keryx remote format-sample: --mode must be ${RENDER_MODE_CHOICES}`);
    process.exitCode = 1;
    return;
  }
  const renderings = wanted === undefined ? renderAllSamples() : [renderSample(wanted as (typeof RENDER_MODES)[number])];
  if (rest.includes("--json")) {
    console.log(JSON.stringify({ sample: SAMPLE_REPLY, renderings }, null, 2));
    return;
  }
  process.stdout.write(formatSampleText(renderings, { full: rest.includes("--full") }));
}
