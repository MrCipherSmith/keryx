# Flow origin: where a flow came from and the human's original request in the effects

Status: draft
Source: user description (origin: human-request)

## Problem

The only label on a flow's outcome is `outcomeAuthor` (human|agent): who typed the outcome criterion. It measures the wrong thing. In the real process a human almost always gives the idea and the agent discusses and formalizes it, so "who typed the text" is almost always the agent, and that is normal. What matters is where the idea came from and whether the original request survived. Today the human's request is paraphrased away, and an idea an agent proposed on its own is indistinguishable from one a human asked for.

## Expected Outcome

Every new flow records its origin in `flow.json` and keeps the human's original request, verbatim, in the Outcome criteria. `outcomeAuthor` stays (G1a is computed on it) but becomes secondary, derived from the origin unless set explicitly. Nothing blocks.

## Scope

1. `origin` in flow.json: `{kind, quote?, source?}`, kind one of `human-request` (a human gave the idea, the agent discussed it, the human confirmed creation), `agent-finding` (the agent found it in a check, review or test, the human confirmed), `agent-proposal` (the agent proposed a new idea, the human confirmed). Set by `flow init --origin <kind> [--quote "<verbatim>"] [--source "<channel, message id or time>"]`.
2. Evidence, not assertion: `human-request` is accepted only with a verbatim quote of the human's first message with the idea and a source. No quote or no source means the origin stays `unknown`. The quote is stored as is, no translation or paraphrase.
3. The Outcome criteria template gets three lines: "Запрос (дословно)", "Эффект (формализация агента)", "Как наблюдать" (marked as the agent's proposal). For agent-finding and agent-proposal "Источник" replaces the request line.
4. `outcomeAuthor` is derived from the origin by default; an explicit setting is kept. `keryx flow origin set <id> <kind> --reason` changes the origin and writes a journal line; it works on any flow, there is no mass relabelling.
5. `flow status`, product index, `product open` and the TUI flow inspector show the origin (kind, quote, source). G1a in product is computed by origin x (real criterion | not measured): an agent line is obedience, a human-request is acceptance.
6. Old flows read as `unknown`. No automatic retro-marking.
7. TUI: the flow inspector and `product open` show the origin; a shell command `/flow origin` shows and sets it.
8. Docs: the flow guide and the CLI reference describe origin and its three kinds.

## Constraints

Not a gate: `flow init`, `freeze`, `complete` and product commands never refuse because of the origin; a flow without one is created and shows "origin: unknown".

## Outcome criteria

- Запрос (дословно): «каждый раз, когда создаётся flow, агент должен сам определять, откуда он пришёл. Если это рождается из обсуждения — первоначальную идею даёт пользователь, агент обсуждает и получает подтверждение — он должен в этом flow формализовать этот запрос от человека и указать в эффекты» (the operator, in `~/prompts/keryx-supervisor/flow-E-flow-origin.md`, confirmed in channel message 177555).
- Эффект (формализация агента): every new flow has an origin in flow.json and, for a human-request, the verbatim quote with its source in the Outcome criteria.
- Как наблюдать (предложение агента): `flow status` and `product open` show the origin; G1a in product is counted by origin; after a week, `keryx flow list` shows no human-request without a quote.

## Out of Scope

Automatic relabelling of old flows (the research labelling stays outside the repo), making the origin a gate, changing how G1a's thresholds are judged.
