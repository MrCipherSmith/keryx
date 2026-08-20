# Restore the tool-call loop: assistant tool_calls and tool_call_id survive into the provider request

Status: formalized
Source: user description (follow-up to flow 176; evidence: keryx session `4a24a760`)

## Problem

A model driven by keryx agent mode never sees evidence that it called a tool.

Measured against this tree with a scripted provider — the model emits one
`get_cwd` call, the driver executes it, and the SECOND request carries:

```
role=user      content="покажи cwd"
role=tool      content="/tmp"
KEYS ON A MESSAGE: ["role","content","provenance"]
```

The assistant turn that made the call is absent. Three causes compound:

1. `src/commands/agent.ts` creates an assistant history message only inside the
   `text_delta` branch, so a round consisting purely of a tool call writes
   nothing to history at all.
2. `NormalizedMessage` (`src/harness/provider/types.ts`) is `{role, content,
   provenance}`. There is no field able to carry a tool call or its id, so even
   a driver that wanted to record one has nowhere to put it.
3. `src/harness/provider/ollama/ollama-provider.ts` — the adapter behind EVERY
   OpenAI-compatible provider (DeepSeek, OpenRouter, Z.AI, Groq, Cerebras,
   Moonshot) — degrades `role:"tool"` to `role:"user"` with a `Tool result:`
   prefix, with an accurate comment saying the normalized layer does not track
   `tool_call_id`. The Anthropic adapter maps every non-assistant role to `user`
   with the bare content and no framing at all.

So the conversation the model is asked to continue reads as: a user request,
then a user message pasting command output, and no assistant participation
in between. The canonical `assistant(tool_calls) → tool(result) → assistant`
loop these models are trained on is broken, and the in-context precedent for
"call a tool" is empty while the precedent for "a human pastes output and I
comment on it" is reinforced every round. Prose replies are the trained
continuation of that transcript, not a defect of any one model — the weaker the
model, the more reliably it narrates ("Смотрю реализацию 145.") instead of
calling. In the recorded session this cost eight manual continuations.

Flow 176 raised the toolless-reprompt budget and made the nudge escalate. That
is a recovery path for the symptom; it does not change the transcript that
produces it.

## Expected Outcome

- An assistant turn that emits tool calls is recorded in history with those
  calls, and each tool result carries the id of the call it answers.
- An OpenAI-compatible request carries real `tool_calls` on the assistant
  message and `role:"tool"` with `tool_call_id` for each result.
- An Anthropic request carries `tool_use` / `tool_result` content blocks.
- A request can never be made invalid by compaction, resume, or a partially
  executed batch: an orphaned result or an unanswered call degrades to today's
  framed-text behaviour instead of being sent as a broken link.
- Tool calls survive session persistence, so a resumed session keeps the loop.
- No regression in the existing suites.

## Out of Scope

- `tool_choice: "required"` support on the provider port.
- Any change to tool execution, approval, budgets, or the reprompt policy from
  flow 176.
- Provider-side parallel tool-call semantics beyond passing through the calls
  the driver already collects.
