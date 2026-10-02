# Flow Journal

- 2026-10-02T11:54:20.132Z - flow created
- 2026-10-02T11:58:15.644Z - frozen: 11 criteria; checksum recorded
- 2026-10-02T11:58:15.818Z - started
- 2026-10-02T12:30:00.000Z - implementation notes: journal in src/decisions (core zone, reached through service.ts); `keryx decisions open|answer|reason|report`; ask_user is wrapped by journaledAskUser; /decisions modal + sidebar row in src/tui/decisions-surface.ts; AC10 fixed in src/flow/service.ts and src/tui/flow-origin-command.ts. Decided without the operator: irreversible defaults (release, delete, push, publish, deploy; config extends them), a question with no recommendation is never blind, the tool-permission picker is not journaled, the flow comes from KERYX_FLOW, the report counts the first answer for the match share.
- 2026-10-02T12:16:48.491Z - implemented: draft PR: https://github.com/MrCipherSmith/keryx/pull/856 (base: main)
