# AFC-18 implementation report
Version: 0.1.0

Help and parsing now precede version-check/provider/session/surface initialization. Unknown arguments, missing/empty required values, invalid permission modes, conflicting agent/chat and continue/resume modes throw actionable errors. Existing UI/permission alias precedence, optional resume picker, and chat permission behavior remain compatible. Updated the obsolete ignored-invalid-permission assertion to the accepted validation contract.

RED: 1 pass/14 fail (2026-09-06T11-16-31-546Z_run). GREEN: 94 pass/0 fail, 274 assertions including real CLI subprocess help/-h/typo/missing-value cases without credentials (2026-09-06T11-32-16-381Z_run). Source-runtime Bun may create its own transpiler cache; tests exclude only cache/bun and assert no Keryx project/config/session writes. Two initial fixture TypeScript errors corrected; final independent review/current integrated typecheck pending.

Files: src/commands/shell.ts, shell.test.ts, shell-cli-validation.test.ts. No external model calls or commits. This report is implementation evidence, not final acceptance.
