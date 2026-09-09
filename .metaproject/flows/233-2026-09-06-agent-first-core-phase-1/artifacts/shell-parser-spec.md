# AFC-18 Shell parser implementation specification
Version: 0.1.0

Help (`--help`, `-h`) must return before version lookup, provider discovery, renderer/session initialization or writes. The parser rejects unknown arguments, missing/empty required values and invalid permission modes with actionable usage advice. Preserve supported flags, optional resume picker, and documented last-flag-wins behavior for UI/permission aliases. Reject conflicting session continuation/resume and agent/chat modes before startup. Help includes every supported option and example invocation. Explicit permission flags in chat remain ignored for backward compatibility (existing contract).

Root creates bounded regression tests while workers are occupied; a separate worker will independently review source changes. No real provider/network/model calls in tests. Tests use injected launch/version spies; help and errors must never reach them.
