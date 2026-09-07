# Nested audit decoding repair

Independent review F001 requires malformed nested npm containers and entries to produce parse failure. Recognized valid advisories must remain available even if another entry is malformed. Supported empty reports remain clean. Reserved npm container keys with wrong shapes cannot fall through as Bun package names. Unknown/missing severity must not silently default to a low-priority clean outcome.

Implement decoder validity separately from its successfully decoded advisory list. runAdapter already retains findings when validate fails, so no change to the fold is required. Add direct parser fixtures and one actual runHealth fake-executable integration regression before production.
