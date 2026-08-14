# Shared Agent Context — Secure Minimal Evidence: Agent Protocol
Version: 0.1.0

## Status

**Future / planned protocol.** It describes behavior after the secure-evidence
capability is delivered; it grants no current agent a transcript/archive tool.

## Preconditions

An agent has a trusted server-created `ActorContext`, a visible workspace, and
either a sealed-session reference issued by Harness or an approved read-only
Flow wrap-up reference. The agent treats an absent, unsealed, denied, expired,
deleted, stale, or scan-failed result as unknown. It never uses prior chat,
filesystem paths, or a client-provided session ID as permission.

## Prepare minimal evidence

1. Ask the authorised server surface to prepare evidence from the sealed source.
2. Supply only an explicit bounded summary/decision/risk/follow-up and typed
   evidence references required by the schema.
3. Do not submit message arrays, raw transcript, prompt, hidden reasoning,
   credentials, PII, or unverified copied web content.
4. Receive the typed scan/minimisation result. On denied, indeterminate, or
   `needs-approval`, stop; do not split, encode, or retry around the gate.
5. Attribute material statements to permitted evidence references and retain
   the source trust/sensitivity label.

## Proposal behavior

An agent may create only a `proposed` candidate bound to successful minimal
evidence. It must name a target intent, not claim the target changed, and must
not self-accept, automatically promote, or directly write owner knowledge. Work
state changes remain Flow-native.

## Archive behavior

The normal agent protocol has no archive read/write operation. An agent must
not ask a human to paste an archive into a prompt as a workaround. If an
authorised owner separately provides an archive-derived extract, the agent
treats it as restricted/untrusted until it passes a new minimisation scan.

## Failure behavior

- `unsealed`/`consumed`/`expired`: request a new owner-issued eligible source.
- `scan-fail`/`indeterminate`: report a concise non-sensitive failure and await
  Security/owner handling.
- `deleted`/`unresolved`: do not request a copied fallback; rebuild from a
  permitted source only.
- `sensitivity-restricted`: avoid disclosure and use a smaller authorised scope.
- `retention-failed`: stop proposal use and report the reference to the owner.

## Prohibited behavior

- Persisting or reconstructing hidden reasoning, transcripts, prompts, secrets,
  or prohibited archive content.
- Editing source trust/sensitivity, policy revision, provenance, TTL, or
  deletion receipt.
- Treating a capability expiry as permission to leave evidence stored.
- Bypassing Security, Session/Harness, Flow, Context Operations, or target
  owners by writing files or calling generic writers.
