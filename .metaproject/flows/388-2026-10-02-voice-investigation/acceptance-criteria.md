# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: A report `docs/requirements/keryx-voice/report.md` exists and compares at least three speech-to-text options and at least three text-to-speech options, each with: local or cloud, install size, new dependency, Russian and English support, latency, cost, and a source link or a measurement. [verify: judged]
- AC2: The report states how helyx does voice today (what it calls, what it installs, what it costs), read from the helyx sources on this machine, and says what keryx can reuse and what it cannot. [verify: judged]
- AC3: The report names one path that adds no new npm dependency to keryx and one path that adds the smallest, with the number of megabytes and packages each adds to the install. [verify: judged]
- AC4: The report ends with one recommendation, the smallest first step as a draft of a follow-up flow's expected outcome, and the open decisions for the operator. [verify: judged]
- AC5: The change touches only files under `docs/requirements/keryx-voice/` and this flow's folder; no file under `src/` changes. [verify: exec `git diff --name-only origin/main...HEAD -- src | wc -l | grep -x 0`]
