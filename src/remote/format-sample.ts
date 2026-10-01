// Print a sample of formatted Telegram replies, for the judged AC13 check.
// No network, no session: it only runs `formatReply` on a few fixed inputs.
//
//   bun run src/remote/format-sample.ts
//
// Each reply is shown as the messages Telegram would receive, separated by lines.

import { formatReply } from "./format";
import { TELEGRAM_MAX_TEXT } from "./types";

const codeLines = Array.from({ length: 220 }, (_, i) => `export const step${i} = (n: number): number => n + ${i};`);

const SAMPLES: { title: string; text: string }[] = [
  { title: "short reply (one message, no number)", text: "Done. The build passes and the three failing tests are fixed." },
  {
    title: "prose longer than one message",
    text: Array.from({ length: 90 }, (_, i) => `Paragraph ${i + 1}: the settings modal reads the same file as the readline command, so both agree.`).join("\n\n"),
  },
  {
    title: "fenced code block that crosses the limit",
    text: `Here is the patch.\n\n\`\`\`ts\n${codeLines.join("\n")}\n\`\`\`\n\nRun the tests after applying it.`,
  },
  { title: "one 5000-character word", text: "x".repeat(5000) },
  { title: "emoji at the boundary", text: `${"a".repeat(4089)}😀${"b".repeat(60)}` },
  { title: "empty reply (no message)", text: "" },
];

const rule = "-".repeat(60);

for (const sample of SAMPLES) {
  const parts = formatReply(sample.text);
  console.log(`${"=".repeat(60)}\n${sample.title}: ${sample.text.length} chars -> ${parts.length} message(s)\n${"=".repeat(60)}`);
  parts.forEach((part, index) => {
    const preview = part.length > 600 ? `${part.slice(0, 280)}\n[... ${part.length - 560} characters not shown ...]\n${part.slice(-280)}` : part;
    console.log(`${rule}\nmessage ${index + 1} of ${parts.length}, ${part.length} of ${TELEGRAM_MAX_TEXT} characters\n${rule}`);
    console.log(preview);
  });
  if (parts.length === 0) {
    console.log("(nothing is sent)");
  }
}
