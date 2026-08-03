# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: Off by default. Given a fresh install with nothing configured, no port is bound, no token exists, and `keryx serve status` reports `stopped`.
- AC2: Authentication. A request with a missing, malformed, or wrong bearer token gets an identical 401 in all three cases; the body reveals nothing about configuration, projects, or sessions; the comparison is constant-time and does not short-circuit on length. A correct token gets 200.
- AC3: Non-loopback is explicit. A non-loopback bind address without the explicit acknowledgement flag enters `refused` and binds no port; with the acknowledgement it binds and `serve status` reports the bind as non-loopback.
- AC4: Refusal is terminal. For every refusal reason, the process exits non-zero, prints what is missing, and no socket is listening — proven by attempting a connection to the configured address, not by reading a log line.
- AC5: Token is shown once. `serve token issue` prints the token once; the store holds only a salted hash and an opaque id; no command, route, status output or error message ever prints it again; `rotate` invalidates the previous token in the same operation; `revoke` invalidates.
- AC6: No secret in configuration or output. The raw token appears in no config file, no `.metaproject` artifact, no status output, no error text, and no log. Asserted by scanning the actual bytes of every file written and every stream captured during a full lifecycle run.
- AC7: `GET /v1/projects` requires authentication, returns the R4a registry projection, addressing only, and contains no credential-shaped field.
- AC8: `GET /v1/status` requires authentication, reports state, bind, profile name, non-loopback flag and a pending-approval count of 0, and never the token.
- AC9: Nothing else is reachable. Any other path, and any non-GET method on the two routes, is refused with a body that discloses nothing; an unauthenticated request to an unknown path is indistinguishable from an unauthenticated request to a known one.
- AC10: Graceful drain. On SIGINT/SIGTERM the server enters `draining`, accepts no new request, closes, and releases the port — proven by binding the same port again afterwards.
- AC11: Read-only on disk. Exercising every route writes nothing under `.metaproject` — `flow.json` in particular — verified by an inventory-and-mtime comparison taken before and after, not by inspection.
- AC12: Gates. `tsc --noEmit` clean; the full `bun test` suite passes; `keryx health run` passes; the command-registry coverage guard is green with the new verbs classified.
