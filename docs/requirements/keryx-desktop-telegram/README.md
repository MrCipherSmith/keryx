# Keryx Desktop Telegram
Version: 0.4.0

**Status: spec ready.** Desktop support is planned. The existing terminal Telegram integration and its `keryx serve` transport are the implementation baseline.

## Purpose and scope

Connect a selected, open Keryx Desktop chat to a topic in the operator's Telegram supergroup. The operator continues the same session from either device, sees its progress and replies, and answers eligible questions from either interface.

- First-time setup of local `serve`, Start, Stop and Restart via **Settings → Integrations → Telegram**. The same settings accept a bot token, show QR and manual pairing options, and support changing the token. A compatible manually started service can be connected as an external instance. Desktop and terminal use one revision-checked channel configuration.
- Explicit opt-in per Desktop chat, with a visible source label and an action to open or detach the topic.
- One existing session owner and one policy decision for each turn and question.
- Later scope includes running the shared Desktop chat after Desktop exits, project-wide inbox topics, new sessions from Telegram, attachments and voice, and broad Telegram slash-command parity.

## Documents

| Document | Purpose |
| --- | --- |
| [PRD](prd.md) | Operator journeys, release criteria, and expected outcomes |
| [Specification](specification.md) | Pairing, session lifecycle, input arbitration, permissions, and typed controls |
| [Implementation plan](implementation-plan.md) | Delivery phases and dependencies |
| [Validation](metrics-and-validation.md) | Controlled CI scenarios and live Telegram acceptance |
| [Desktop control schema](schemas/telegram-session-control.schema.json) | Proposed local ACP session-control request and state contract |

## Related modules

- [Desktop Client](../keryx-desktop-client/README.md) owns the Tauri/ACP session interface.
- [Drive Keryx remotely](../../docs/guides/drive-keryx-remotely.md#remote-control-from-telegram) documents the shipping terminal workflow.
- [Telegram Transport](../keryx-telegram-transport/README.md) describes a separate future project-agent transport, including project-level topics.
- [Team Hub remote sessions](../hub-remote-sessions/README.md) is the reference for work hosted independently of the Desktop window.
