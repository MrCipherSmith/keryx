// Projection of the public coordinator transcript. Never return a prompt, tool arguments,
// raw output, private reasoning or the underlying events file across the Desktop boundary.
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import path from "node:path";
import { publicReadFile, publicReviewText } from "./desk-public-text";
import { phaseOf } from "./autonomous-progress";
import { reviewerName, waveNumber } from "./reviewer-activity";
import type { CoordinatorEvent } from "./desk-run-types";

export { publicReviewText } from "./desk-public-text";

function projectEvent(event: Record<string, unknown>): CoordinatorEvent | undefined {
  if (event.type === "desktop_context_reused" && reviewerName(event.reviewer))
    return { kind: "status", text: publicReviewText(`Shared your earlier reply with ${event.reviewer}.`, 200) };
  if (event.type === "turn_start") return { kind: "status", text: "Coordinator started" };
  if (event.type === "turn_end") {
    if (typeof event.text === "string" && event.text.trim()) return { kind: "message", final: true, text: publicReviewText(event.text, 2000) };
    return event.errorMessage ? { kind: "error", text: "Coordinator stopped with an error" } : { kind: "status", text: "Coordinator finished the turn" };
  }
  if (event.type === "reviewer_activity" && event.activity === "finished" && reviewerName(event.reviewer) && waveNumber(event.wave) &&
      ["completed", "partial", "cancelled", "failed"].includes(String(event.outcome))) {
    return { kind: "status", text: publicReviewText(`${event.reviewer} · Wave ${event.wave} · ${event.outcome}`, 200) };
  }
  if (typeof event.text === "string" && event.text.trim()) {
    if (event.type === "assistant") return { kind: "message", text: publicReviewText(event.text, 2000) };
    if (event.type === "desktop_question" || event.type === "desktop_answer") {
      return {
        kind: event.type === "desktop_question" ? "question" : "answer",
        text: publicReviewText(event.text, 2000),
        ...(reviewerName(event.reviewer) && { reviewer: publicReviewText(event.reviewer, 96) }),
        ...(typeof event.questionId === "string" && /^[a-f0-9-]{36}$/.test(event.questionId) && { questionId: event.questionId }),
      };
    }
  }
  if (event.type !== "tool_call" && event.type !== "tool_result") return;
  if (typeof event.name !== "string" || !/^[\w-]{1,96}$/.test(event.name)) return;
  const name = publicReviewText(event.name, 96);
  if (event.type === "tool_call") {
    let label = name;
    if (name === "shell_exec" && typeof event.input === "string") label = phaseOf(name, event.input);
    if (name === "read_file" && typeof event.input === "string") {
      const file = publicReadFile(event.input);
      if (file) label = `${name} · ${file}`;
    }
    if (name === "spawn_subagent" && typeof event.input === "string") {
      try {
        const input = JSON.parse(event.input);
        const assignment = typeof input?.assignment === "string" ? path.basename(input.assignment, ".txt") : undefined;
        const reviewer = input?.label ?? assignment;
        if (reviewerName(reviewer) && reviewer.startsWith("review-")) label = `${name} · ${publicReviewText(reviewer, 96)}`;
      } catch { /* Truncated arguments leave the tool name. */ }
    }
    return { kind: "tool", text: `Started ${publicReviewText(label, 120)}` };
  }
  if (event.isError === true) {
    // This public routing verdict is useful even for older attempts with only a draft report.
    const unverified = name === "spawn_subagent" && typeof event.output === "string" &&
      event.output.includes("denied by routing: candidate-unverified");
    return { kind: "error", text: unverified ? `${name} denied by routing: candidate-unverified` : `${name} failed` };
  }
  return { kind: "result", text: `${name} finished` };
}

export function coordinatorActivity(directory: string): CoordinatorEvent[] {
  return coordinatorActivityPage(directory).events;
}

/** The cursor is an exclusive byte offset in this attempt's append-only log. */
export function coordinatorActivityPage(directory: string, before?: number): { events: CoordinatorEvent[]; before?: number } {
  const run = path.join(directory, "run");
  const events: CoordinatorEvent[] = [];
  if (before !== undefined && (!Number.isSafeInteger(before) || before <= 0)) return { events };
  try {
    if (!lstatSync(directory).isDirectory() || !lstatSync(run).isDirectory()) return { events };
    const fd = openSync(path.join(run, "events.ndjson"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile()) return { events };
      const end = Math.min(stat.size, before ?? stat.size);
      const offset = Math.max(0, end - (512 * 1024 - 1));
      // Include the byte preceding the read window to tell a full first line from a fragment.
      const first = offset ? offset - 1 : 0;
      const buf = Buffer.alloc(end - first);
      const bytes = readSync(fd, buf, 0, buf.length, first);
      const start = offset && buf[0] !== 10 ? buf.indexOf(10, 1) + 1 : offset ? 1 : 0;
      if (offset && (!start || start >= bytes)) return { events, before: offset }; // a single overlong line
      // A cursor inside an overlong line ends on a fragment. Ignore it on both sides.
      let lineEnd = before !== undefined && buf[bytes - 1] !== 10 ? buf.lastIndexOf(10, bytes - 1) + 1 : bytes;
      while (lineEnd > start && events.length < 80) {
        const scanFrom = lineEnd - (buf[lineEnd - 1] === 10 ? 2 : 1);
        const lineStart = scanFrom >= 0 ? buf.lastIndexOf(10, scanFrom) + 1 : 0;
        try {
          const event = projectEvent(JSON.parse(buf.toString("utf8", lineStart, lineEnd)));
          if (event && !(event.kind === "message" && events.at(-1)?.kind === "message" && events.at(-1)?.text === event.text)) events.push(event);
        } catch { /* Torn, malformed or unsupported event. */ }
        lineEnd = lineStart;
      }
      const earlier = offset ? Math.max(offset, first + lineEnd) : lineEnd;
      return { events: events.reverse(), ...(earlier > 0 && { before: earlier }) };
    } finally { closeSync(fd); }
  } catch { /* A queued attempt has no transcript yet. */ }
  return { events: events.reverse() };
}
