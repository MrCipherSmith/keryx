# Voice for Telegram and keryx: investigation

Status: draft, awaiting operator check of the acceptance criteria before freeze
Source: operator request 2026-10-01 (message 176715)

## Problem

helyx talks by voice: the operator sends a voice message and hears long replies. keryx has no voice at all, neither in the Telegram topic nor in the shell. The operator wants the same ability with minimal dependencies and weight, so it must be clear what to use, what it costs and what it adds to the install.

## Expected Outcome

A report with a recommendation, no implementation. It compares speech-to-text (voice message in, text line out) and text-to-speech (reply out as a voice message) options for keryx: local versus cloud, install size, new runtime dependencies, languages (Russian and English first), latency, cost, and a path that adds no new npm dependency. It ends with one recommended option, the smallest first step and the open decisions for the operator.

## Outcome criteria

- not measured — an investigation; its result is a report the operator reads and decides on.

## Out of Scope

Any implementation, any change to `src/`, voice in the TUI, wake words and calls. Voice for the Telegram topic is considered only as a source of requirements for a later flow.
