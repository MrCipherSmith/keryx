# Flows

Managed units of work tracked by the Task Manager module (`keryx flow`).

Each flow lives in its own `NNN-<date>-<slug>/` directory holding CLI-owned
state (`flow.json`) alongside its acceptance criteria, plan, tasks, and journal.
Start one with:

```bash
keryx flow init --title "<short problem statement>"
```

See the `flow` skill for the full lifecycle (freeze → start → tasks → verify →
complete). This directory is empty in a fresh workspace.
