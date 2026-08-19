# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: After a round in which the model emits a tool call, the driver's history contains an assistant message carrying that call (`toolCalls[0].id/name/arguments`), positioned before the tool result it answers.
- AC2: Each tool result message the driver appends carries `toolCallId` equal to the id of the call it answers.
- AC3: When the model emits BOTH text and a tool call in one round, exactly one assistant message is recorded, carrying the text and the call.
- AC4: The OpenAI-compatible adapter sends a linked assistant message as `{role:"assistant", tool_calls:[{id, type:"function", function:{name, arguments}}]}` and each linked result as `{role:"tool", tool_call_id, content}` — no `Tool result:` framing for linked pairs.
- AC5: The Anthropic adapter sends a linked assistant turn with a `tool_use` block (id, name, parsed input) and the matching result as a `tool_result` block referencing that id.
- AC6: An orphaned tool result (its assistant call absent from the request) and an unanswered assistant call (no result in the request) both degrade to the pre-existing text form, and neither adapter emits a dangling `tool_call_id` or an unanswered `tool_calls`.
- AC7: `linkToolCalls` is pure and total: malformed or duplicate ids, empty arrays, and a message array with no tool traffic all return without throwing.
- AC8: A session written and read back through the store preserves `toolCalls` and `toolCallId`; a transcript line with a malformed value for either drops that field instead of propagating it.
- AC9: A history compacted by `compactMessages` such that the cut falls between an assistant call and its result still serializes to a valid request (the orphaned side degrades, per AC6).
- AC10: `bun test` passes over the full suite and `bun run typecheck` is clean, with the new tests co-located with the code they exercise.
