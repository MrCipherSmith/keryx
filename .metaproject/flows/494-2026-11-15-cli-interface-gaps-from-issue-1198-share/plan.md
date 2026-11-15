# Plan
T1 adds `src/commands/flags.ts` (or the nearest existing shared CLI helper module) with `rejectUnknownFlags(command, args, accepted)`, migrates the six copies keeping their messages' meaning, and guards modules/skills/memory. T2 wraps skills verify JSON in `{schemaVersion, ...}` with a documented legacy flag or env for the bare array. T3 adds the alias notice. Sequential T1 then T2 and T3 (T1 touches review.ts and skills.ts).

State × event matrix: not applicable — CLI output only.
