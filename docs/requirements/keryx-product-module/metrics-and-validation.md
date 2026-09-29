# Metrics and validation — the "before" arm

The product module is justified by one claim: intents closed in code are rarely
checked for effect. This page records what the repository looked like before
anything could be checked, so the later numbers have something honest to be
compared with. The gates that use them are G1a and G1b in
[implementation-plan.md](implementation-plan.md).

## Before

Read from `keryx product index` on the corpus as it stood at release 0.3.30:

| Measure | Value |
| --- | --- |
| Closed intents with no outcome criterion, never observed | 310 of 310 |
| Intents indexed | 423 (347 flows, 76 requirements packages) |
| Entries with no extractable intent statement | 130 |
| Parse failures | 0 |

## What this does not mean

310 of 310 does NOT mean "nothing worked". It means
the instrument did not exist: no flow had a slot to say what it expected to
change, and no observation carried a verdict. Release 0.3.30 had a free-text
`outcome-observed:` line, but it recorded no verdict, so it could not say whether
anything helped. Nothing could have been recorded that way, so nothing was. The
number is the size of the gap, not a verdict on the work inside it.

## Why the arm stays honest

No outcome criterion and no observation is ever written into an existing flow or
requirements package. The historical corpus is left as it was, so "before" cannot
drift into "after" by back-filling, and a later improvement in the numbers can
only come from flows created with the slot present.

## What is recorded from now on

- **Criterion.** A `## Outcome criteria` section in a flow's `description.md`
  (created by `flow init`), or `not measured — <reason>` when there is no
  instrument. An untouched hint is not a declared criterion.
- **Observation.** A line at column 0 of a flow's `journal.md`:

  ```
  outcome-observed: <verdict> — <note>
  ```

  `<verdict>` is exactly one of `helped`, `no-effect`, `harmed`, `inconclusive`.
  A requirements package records the same in an `## Outcome observations` section
  of its README.md, as `- <verdict> — <note>`.
- **Malformed lines** are failures that name the flow or package; `product
  index` exits non-zero and the flow stays in the open queue.

Nothing gates on any of this. The measures are read by G1a and G1b, once, by a
person.
