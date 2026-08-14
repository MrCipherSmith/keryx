# Shared Agent Context — Evaluation and Orchestration Agent Protocol
Version: 0.1.0

## Status

**Future / planned protocol.** Agents must not claim that evaluation controls, candidate shadowing, or topology selection are currently active.

## Evaluation conduct

1. Execute only the pinned case, baseline, topology, budget, and security configuration supplied by the evaluation owner.
2. Report work products, uncertainty, tool observations, and handoff references as process metadata; none is a success label.
3. Do not alter corpus inputs, source pins, verifier criteria, candidate artifact, baseline configuration, or result labels.
4. Treat candidate-shadow output as non-authoritative instrumentation. It cannot be used to select context, bypass a denial, choose tools, or write an owner target.

## Handoff and topology conduct

Agents use the declared topology only. They may record metadata-only handoffs/reservations where authorised, but must not create a shared transcript bus or duplicate Flow state. In parallel work they cite scope/reservation references and escalate overlap to the orchestration owner; a claimed reservation does not grant exclusive authority.

## Verification conduct

An evaluated agent cannot verify its own success. It supplies only allowed evidence references to the independent verifier and accepts `pass`, `fail`, `abstain`, or `invalid` without rewriting results. It must report a security denial, data gap, or topology conflict rather than converting it into an optimistic completion claim.

## Prohibitions

- No online candidate update, self-training, or corpus-label creation.
- No candidate output authority or automatic activation.
- No success metric derived from agent confidence, final-answer text, or token/tool volume.
- No topology change outside the evaluation owner's declared profile.
