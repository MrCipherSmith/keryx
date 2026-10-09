# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.


## Criteria

- AC1: Every approval prompt the shell raises (command approval, ask_user, queue dialogs) is posted to the topic with buttons or a poll; a test shows one prompt reaching the outbound log with the options.
- AC2: An answer from the topic resolves the prompt in the shell exactly once, and an answer from the terminal first removes the Telegram prompt; a test covers both orders.
- AC3: A prompt left unanswered gets a reminder in the topic after a stated interval, so a stall is visible within that interval.
- AC4: `/route`, `/external`, `/mode` and `/model` sent from the topic take effect when main is idle and are queued, with a visible notice, when main is busy.
- AC5: The topic receives progress notes at wave boundaries and at tool-heavy steps, at most one per stated interval, and not the model's raw tool output.
- AC6: A status question from the topic is answered from the session state without waiting for the running turn to end.
- AC7: Closing the shell archives the topic (a closing note, the topic stays readable) instead of deleting it; a test shows the topic and its history survive a shell exit and a Ctrl+C.
- AC8: Live: a long review run in a shell with `/remote-control` is completed with answers from Telegram only, with no terminal input after the task, recorded with the topic's message log.
- AC9: The docs describe what mirrors to Telegram, how to answer, and what happens on close; the docs site builds with --strict.
