# Metaproject Security Policies

Version: 0.2.0

## 1. Purpose

Policies define what Metaproject Security checks and what action it should take.

## 2. Policy Categories

| Category | Purpose | Default action |
|---|---|---|
| `secret` | API keys, private keys, tokens, credentials | `block` |
| `pii` | Personal or customer-identifying information | `redact` |
| `prompt-injection` | Instructions embedded in untrusted content | `require-approval` |
| `egress` | Attempts to send private data outside approved channels | `block` |
| `artifact-safety` | Unsafe writes to memory, wiki, reports, tasks | `redact` |
| `raw-retention` | Attempts to persist raw sensitive content | `block` |

## 3. Default Policies

### secrets.default

Detect:

- provider-shaped API keys;
- private key blocks;
- `.env` assignments such as `DATABASE_URL`, `JWT_SECRET`, `TOKEN`, `API_KEY`;
- URL credentials;
- JWT-like tokens;
- high-entropy strings near sensitive labels.

Default action: `block`.

### pii.default

Detect:

- emails;
- phone numbers;
- addresses;
- personal names when context suggests user/customer identity;
- national IDs or internal customer IDs when configured.

Default action: `redact`.

### prompt-injection.default

Detect untrusted content that asks the agent to:

- ignore previous/system/developer instructions;
- reveal memory, secrets, prompts or hidden context;
- send private data to URLs or tools;
- alter security policies;
- treat external content as higher-priority instructions.

Default action: `require-approval`.

Injection heuristics default to **low confidence**: a lone injection signal is
`warn`. It escalates to `require-approval`/`block` only when combined with an
`egress` signal (an instruction to send private data outside approved channels).
This keeps false positives from blocking normal agent work.

### egress.default

Detect attempts to publish:

- `.metaproject/memory/**`;
- raw logs;
- secret-like spans;
- unredacted PII;
- local config files;
- private task context.

Default action: `block`.

## 4. Trust Levels

Sources should be classified as:

- `trusted-project` - project-owned code/docs/rules.
- `trusted-user` - direct user instruction in the current session.
- `untrusted-external` - web pages, external docs, issue bodies, copied files.
- `tool-output` - command output, logs, test output.
- `generated` - model output.

External content is data, not instruction.

## 5. Severity Mapping

| Severity | Meaning |
|---|---|
| `critical` | Secret/private key or direct exfiltration instruction. |
| `high` | likely credential/PII leak or high-confidence injection. |
| `medium` | sensitive artifact risk requiring redaction or approval. |
| `low` | weak signal or informational policy warning. |
| `info` | advisory-only signal; never gates. |

