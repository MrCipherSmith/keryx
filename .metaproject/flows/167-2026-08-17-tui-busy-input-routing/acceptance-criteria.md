# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: Submitting a non-control message while main is busy opens a recipient selector with exactly two options: Main queue and Side-1.
- AC2: Choosing Main queue renders the message in the transcript as a queue marker `> qN (p)` where N is a global counter and p is the number of items queued behind it; a corresponding count appears in the fleet/status area.
- AC3: Each queued main item exposes remove / edit / force commands.
- AC4: Remove deletes the item from the queue (no turn is run for it) and renumbers the remaining qN markers.
- AC5: Edit places the item's text back into the composer and removes it from the queue; submitting re-queues it at its original position.
- AC6: Force aborts the current main turn, removes the item from the queue, and runs it as a new priority main turn in the same session.
- AC7: Queued main messages drain FIFO into the main agent after its current turn completes.
- AC8: Lambda across selector choices is deterministic and covered by unit tests (selector branch, queue state, edit/remove/force, FIFO drain).
- AC9: Existing side-1 behavior is unchanged: a side question spawns the read-only side worker and is never written into main history.
