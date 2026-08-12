# Learning

## Skill Learning

- Trust markers must bind both the authority identity and the exact operation;
  preflight containment evidence alone is insufficient for later execution.
- A corpus pin must cover manifest semantics as well as row bytes; otherwise
  selection and redaction policy can drift under a stable digest.
- Cache/checkpoint refresh after a durable append must not redefine the commit point.
