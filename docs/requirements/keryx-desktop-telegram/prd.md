# Keryx Desktop Telegram PRD
Version: 0.4.0

**Status: spec ready.**

## Problem

The operator can pair Telegram with a terminal Keryx session. A chat started in Desktop uses ACP and its Telegram commands currently return text status or terminal instructions. An operator stepping away from a Desktop chat cannot continue that live session from the phone.

## Goal and users

A Desktop operator with an authorized Telegram account can attach the active chat to Telegram and continue the same work from either device. An operator who already paired this machine in the terminal can reuse that connection.

## Requirements

### R1. Set up and manage the machine from Desktop

In Settings → Integrations → Telegram, the operator can set up and start the local service on a clean machine without opening Terminal. On subsequent visits the operator can see live status, start a stopped service, and stop or restart a Desktop-managed service. Desktop can reuse a compatible instance started outside the app and identifies who manages it. Setup preserves existing credentials and settings. A bind conflict or incompatible service reports a recovery action.

The operator can also reuse a bot connection or paste a new token into a protected Desktop field and pair the bot with a forum. To link the Telegram account, scan a QR code, open its link, or send the one-time code manually to the bot. Pairing can resume after closing Settings. The operator can run a connection test, change the saved token or disconnect. A valid replacement token for the same bot preserves the group and session topics. Switching to a different bot requires explicit pairing and leaves existing topic history in Telegram. A replacement is successful after the candidate receives its first successful update response. A rejected replacement preserves the previous configuration and restores its connection when the old token is still valid. The operator sees a recovery action when the previous connection cannot be verified. If Desktop and the terminal race to change the settings, the first successful revision wins and the other interface asks the operator to refresh. Stop and restart preserve the bot connection. Disconnect is machine-wide and explains its effect on active topics.

Verification: judged

### R2. Share one Desktop chat

The operator explicitly enables Telegram from the chat, sees its connection state, opens the bound topic, and can detach it. Topics are isolated by session, even for two chats in the same project. A reconnect preserves the topic only when the transport proves that it belongs to the same live binding. A similar name does not establish ownership. Attaching sends no previous transcript.

Verification: judged

### R3. Continue from either device

A valid topic message becomes user input in the exact open session and is visibly marked as Telegram in Desktop. The final reply to either device's input is visible in Desktop and mirrored as one logical reply to the active topic. Uncertain Telegram delivery is shown separately. Telegram gets short progress summaries and can stop a turn it initiated. When ACP cannot accept input, Telegram gets a clear busy or unavailable response with no hidden retry.

Verification: judged

### R4. Resolve questions once

The same eligible approval or structured question can be answered on Desktop or in Telegram. The first valid answer wins. Expired, duplicated, stale, or unauthorized answers apply no action. Policy checks remain in force and Desktop-only confirmations stay on Desktop.

Verification: judged

### R5. Preserve privacy and authority

Only allowlisted Telegram senders in the bound topic can submit input. Telegram-originated work uses a delegated principal and receives at most the supported Ask-mode authority, further constrained by session policy. The bridge shares redacted replies and eligible questions, with no token, raw tool output, internal reasoning, or automatic history export.

Verification: judged

### R6. Explain interruptions and shutdown

Desktop distinguishes unavailable `serve`, reconnecting, active, and detached states. Switching the selected chat alone never reroutes an existing topic. Detaching the chat or disconnecting the machine cancels an in-flight Telegram turn and its pending decisions. A Desktop-origin turn remains under Desktop control. Closing the ACP owner ends remote access, and reopening the chat requires an explicit attach. Delivery uncertainty is visible and does not cause automatic execution of an old input.

Verification: judged

## Success criteria

### Release criteria

- V1–V7 and V9 in the [validation plan](metrics-and-validation.md) pass on the candidate revision in GitHub CI, including dispatch races, access boundaries, and reconnection.
- V8 records first launch and subsequent service management from the installed macOS app, followed by pairing and bidirectional use with a disposable live Telegram bot and group.
- The connection and quit limitations appear in the shipped Desktop help or guide and in the relevant UI states.

### Outcome criteria

- One week after acceptance, review the operator's opt-in follow-up checklist for a real Desktop-started task completed from the phone without switching to terminal. Record success or the point of friction.
- Fleet adoption is not measured — the first release includes no product telemetry.

## Risks and recommendation

Accidental cross-session routing can expose the wrong project. Separate permission paths can execute an action twice or infer more authority than the session granted. Distinguish “sent to the bridge” from “accepted by the session” and keep per-session ownership and decisions in ACP. Ship live Desktop sharing first. Treat background session ownership as a separate product decision.
