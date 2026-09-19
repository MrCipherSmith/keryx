# Implementation Plan

Status: approved for freeze

## Steps

1. **T5, sonnet: delivery core.** Touches `src/bus/inbox.ts`, `src/bus/peer-notification.ts`, `src/harness/child/quarantine.ts` and `src/commands/agent.ts` (drains only).
   - `createBusInbox()`, with:
     - `push(RenderedBusEvent)`;
     - `drainUndelivered()`, exactly once;
     - `hasWakeEligible()`, classified per spec §4.2;
     - `size`.
   - `buildPeerMessageNotification(events)`:
     - opens with a banner;
     - renders each event as a `<peer-message id seq from kind [reply_to]>` block;
     - quarantines each body with `quarantinePeerMessage` (it shares `PATTERNS` with `quarantineChildSummary`, labelled "peer message");
     - escapes `<` and `>` in bodies;
     - returns `""` for no events.
   - In `runAgentTurn`, keep the task-notification shape and add three points:
     - turn start with `origin === "bus-message"`: drain; if nothing was drained, return `{}`;
     - the round boundary;
     - the post-answer point, which pushes and `continue`s.

     Each drain carries `provenance: "tool"`. After a push, call `deps.busAck?.(ids)`.
   - `AgentDeps` gains `busInbox?` and `busAck?`. Widen the `origin` union with `"bus-message"`.
   - The client's `ack(ids)` writes kind `ack` events: origin `system`, `to` the sender's instance, `refs.replyTo` set to the delivered event's id.
2. **T6, sonnet, in parallel with T7: tools and conduct.** Touches `src/bus/agent-tools.ts`, `src/commands/interactive-agent-tools.ts` and the system-prompt section.
   - `buildBusTools(getClient)` builds `bus_list` and `bus_send`, both risk `read`, with the named refusals from §7.1.
   - `buildInteractiveAgentTools` accepts `bus?: { client: () => BusClient | undefined }` and adds the tools only when a client is present.
   - Subagent and child tool sets never include `bus_*`. Find the child tool build path and assert it with a test.
   - Add the `agent-protocol.md` conduct text as a guidance block, included only when the bus is joined.
3. **T7, sonnet, in parallel with T6: surface wiring.** Touches `src/tui/tui-shell.ts` and `src/commands/shell.ts`.
   - Feed `onEvent` into a `busInbox`, pass `busInbox` and `busAck` into `makeAgentDeps`, and pass the bus client getter to the tools option.
   - TUI:
     - wake on poll when idle and `hasWakeEligible()`, calling `runLine("", "bus-message")` and sharing `consecutiveAutoWakes` and the cap message;
     - also wake on turn settle when the inbox still holds wake-eligible messages;
     - never wake while a turn is held (P4 hook point; for now, never while busy).
   - Readline: no wake. Announce pending messages on the prompt line; drains happen inside turns.
4. **T8, sonnet: integration tests.**
   - `runAgentTurn` with a scripted provider covers all three drain sites and the "never inside a `tool_calls` batch" rule.
   - An empty `bus-message` turn makes no model call.
   - Two scripted agents that always reply stop at the auto-wake cap.
   - An ack is written only after delivery.
5. **T9, haiku: docs.** Status, plus the cli-reference/agent docs mention of the tools.
6. **Review.** Opus for r1; sonnet for the verification rounds.

## Risks

- `agent.ts` is shared by T5 and T6. T5 runs first; T6 touches only the prompt section, after T5 is committed.
- The child tool filter: if no filter exists, T6 adds one without changing other tools for children.
- Local runs are limited to targeted tests, per the operator. CI covers the full suite.
