# Implementation Plan

Status: draft — scoped from a reproduced defect, not yet brainstormed or frozen.

## Approach

Guard the match, do not weaken the pattern. The phone detector is doing its job;
what it lacks is a reason to reject a match that begins and ends inside a longer
token. Two candidate guards, to be decided when the pattern is read:

1. **Token boundary** — refuse a match whose neighbouring character is part of
   the same identifier-ish run (`[0-9a-f-]` on either side). Cheap, local, and
   kills the UUID case without touching any real phone number, which is always
   bounded by whitespace, punctuation or a line edge.
2. **Negative context** — recognise the enclosing shape (a UUID, a hex digest)
   and suppress PII findings inside it. Stronger, but it is a second pattern to
   maintain and it only covers the shapes it knows.

(1) first; (2) only if (1) proves insufficient for a case the corpus names.

Whichever is chosen, the phone corpus is the gate: a fix that silences a real
phone number is a worse defect than the one being repaired, so AC4 holds the
existing expectations unchanged.

## Steps

1. **Reproduce in a test.** Put the CI UUID in as a literal, assert zero
   findings, watch it fail. This is the artefact AC3 needs; everything else is
   done against it.
2. **Read the pattern.** Locate the phone rule and whatever boundary logic the
   detector already has (some families may already guard and only this one does
   not — that answers AC6 cheaply).
3. **Apply the guard**, run the phone corpus, confirm nothing that was caught is
   now missed.
4. **Prove the rate is zero.** The 0.9 % measurement was empirical; replace it
   with a deterministic enumeration (AC2) so the claim does not depend on luck.
5. **Sweep the other PII patterns** for the same weakness (AC6), recording the
   result for each — including "not affected".
6. **Pin the parity test** with a forced phone-shaped correlationId (AC5), so
   the gate that found this cannot silently lose the ability to find it.
7. Full gate, PR, release.

## Risks

- **Over-correction.** A boundary guard written too broadly stops catching phone
  numbers that legitimately sit next to punctuation. The corpus is the defence;
  it must not be edited to make the fix pass.
- **Wider blast radius than one pattern.** If the boundary logic is shared, the
  fix touches every family at once and the sweep in step 5 becomes the main
  work rather than a footnote. Worth knowing before estimating.
- **Silent historical corruption.** Anything already persisted through a
  redacting surface may hold a mangled id. Out of scope to repair, but worth
  naming in the flow's report so nobody later treats those records as sound.
