import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { JSON_RPC_ERROR_CODES } from "./jsonrpc";
import {
  ACP_AGENT_METHODS,
  ACP_CANCEL_REQUEST_METHOD,
  ACP_CLIENT_METHODS,
  ACP_IMPLEMENTED_AGENT_METHODS,
  ACP_PROTOCOL_VERSION,
  ACP_REFUSED_AGENT_METHODS,
  ACP_SCHEMA_SOURCE,
  ACP_STOP_REASONS,
  ACP_SUPPORTED_PROTOCOL_VERSIONS,
  KERYX_AGENT_CAPABILITIES,
  KERYX_AUTH_METHODS,
  negotiateProtocolVersion,
  permissionGranted,
  requireObjectParams,
  requireStringField,
  unsupportedProtocolVersion,
  type AcpAvailableCommand,
  type AcpPermissionOption,
  type AcpSessionConfigOption,
  type AcpSessionUpdate,
  type AcpSetSessionConfigOptionRequest,
  type AcpSetSessionConfigOptionResponse,
} from "./protocol";

// AC7: the version and the wire shapes are pinned HERE, in one file, so a
// protocol bump is a visible edit to a named constant and not a diffuse sweep.
test("keryx pins ACP v1 and advertises exactly that", () => {
  expect(ACP_PROTOCOL_VERSION).toBe(1);
  expect(ACP_SUPPORTED_PROTOCOL_VERSIONS).toEqual([1]);
  expect(ACP_SCHEMA_SOURCE).toContain("schema/v1");
});

test("the advertised agent capabilities are exactly the promises keryx keeps", () => {
  expect(KERYX_AGENT_CAPABILITIES).toEqual({
    loadSession: true,
    promptCapabilities: { image: false, audio: false, embeddedContext: true },
    mcpCapabilities: { http: false, sse: false },
    // Presence, not a boolean: `{}` advertises listing, absence declines it.
    sessionCapabilities: { list: {} },
    auth: {},
  });
  expect(KERYX_AUTH_METHODS).toEqual([]);
});

test("every capability keryx does not advertise has a refusal that names it", () => {
  const session = KERYX_AGENT_CAPABILITIES.sessionCapabilities ?? {};
  expect(session.resume).toBeUndefined();
  expect(session.close).toBeUndefined();
  expect(session.delete).toBeUndefined();

  for (const method of [
    ACP_AGENT_METHODS.sessionResume,
    ACP_AGENT_METHODS.sessionClose,
    ACP_AGENT_METHODS.sessionDelete,
    ACP_AGENT_METHODS.sessionSetMode,
    ACP_AGENT_METHODS.authenticate,
    ACP_AGENT_METHODS.logout,
  ]) {
    const refusal = ACP_REFUSED_AGENT_METHODS.get(method);
    expect({ method, code: refusal?.code }).toEqual({
      method,
      code: JSON_RPC_ERROR_CODES.methodNotFound,
    });
  }
});

test("implemented and refused are disjoint, and together cover every agent method", () => {
  const all = [...Object.values(ACP_AGENT_METHODS)].sort();
  const covered = [...ACP_IMPLEMENTED_AGENT_METHODS, ...ACP_REFUSED_AGENT_METHODS.keys()].sort();

  expect(covered).toEqual(all);
  expect(
    ACP_IMPLEMENTED_AGENT_METHODS.filter((method) => ACP_REFUSED_AGENT_METHODS.has(method)),
  ).toEqual([]);
});

test("the method names match the schema's own spelling", () => {
  expect(Object.values(ACP_AGENT_METHODS)).toEqual([
    "initialize",
    "authenticate",
    "logout",
    "session/new",
    "session/load",
    "session/resume",
    "session/prompt",
    "session/cancel",
    "session/close",
    "session/delete",
    "session/list",
    "session/set_mode",
    "session/set_config_option",
  ]);
  expect(Object.values(ACP_CLIENT_METHODS)).toEqual([
    "fs/read_text_file",
    "fs/write_text_file",
    "session/request_permission",
    "session/update",
    "elicitation/create",
    "elicitation/complete",
    "terminal/create",
    "terminal/output",
    "terminal/kill",
    "terminal/release",
    "terminal/wait_for_exit",
  ]);
  expect(ACP_CANCEL_REQUEST_METHOD).toBe("$/cancel_request");
  expect(ACP_STOP_REASONS).toEqual([
    "end_turn",
    "max_tokens",
    "max_turn_requests",
    "refusal",
    "cancelled",
  ]);
});

test("the version a client asks for is answered exactly when keryx serves it", () => {
  expect(negotiateProtocolVersion(1)).toEqual({ kind: "exact", version: 1 });
});

// The spec's MUST: a newer client is answered with the agent's ceiling and
// decides for itself, rather than being refused outright. See context.md
// §Findings for how this reads against AC1.
test("a newer client is offered keryx's ceiling rather than an error", () => {
  expect(negotiateProtocolVersion(2)).toEqual({ kind: "offer", version: 1, requested: 2 });
  expect(negotiateProtocolVersion(99)).toEqual({ kind: "offer", version: 1, requested: 99 });
});

test("a version that is not a version is refused with -32602 and never guessed at", () => {
  for (const requested of [undefined, null, "1", 1.5, Number.NaN, {}, [], -1, 65_536]) {
    const outcome = negotiateProtocolVersion(requested);
    expect({ requested, kind: outcome.kind }).toEqual({ requested, kind: "refuse" });
    if (outcome.kind === "refuse") {
      expect(outcome.error.code).toBe(JSON_RPC_ERROR_CODES.invalidParams);
      expect(outcome.error.data).toEqual({ requested, supported: [1], latest: 1 });
    }
  }
});

test("a version below keryx's floor is refused rather than silently upgraded", () => {
  const outcome = negotiateProtocolVersion(0);

  expect(outcome.kind).toBe("refuse");
  if (outcome.kind === "refuse") {
    expect(outcome.error.message).toContain("cannot speak anything older");
  }
});

test("the refusal is also available as a throwable carrying the same shape", () => {
  const error = unsupportedProtocolVersion(0, "too old");

  expect(error.code).toBe(JSON_RPC_ERROR_CODES.invalidParams);
  expect(error.toErrorObject().data).toEqual({ requested: 0, supported: [1], latest: 1 });
});

// The prose docs show `outcome: "granted" | "denied"`. The schema does not: a
// denial is a SELECTED option whose kind rejects, and `cancelled` is not an
// answer at all. Anything that reads this as a boolean has to get both right.
test("permission is granted only by an explicit allow option", () => {
  const options: readonly AcpPermissionOption[] = [
    { optionId: "yes", name: "Allow", kind: "allow_once" },
    { optionId: "always", name: "Always allow", kind: "allow_always" },
    { optionId: "no", name: "Reject", kind: "reject_once" },
    { optionId: "never", name: "Never", kind: "reject_always" },
  ];

  expect(permissionGranted({ outcome: { outcome: "selected", optionId: "yes" } }, options)).toBe(true);
  expect(permissionGranted({ outcome: { outcome: "selected", optionId: "always" } }, options)).toBe(true);
  expect(permissionGranted({ outcome: { outcome: "selected", optionId: "no" } }, options)).toBe(false);
  expect(permissionGranted({ outcome: { outcome: "selected", optionId: "never" } }, options)).toBe(false);
  expect(permissionGranted({ outcome: { outcome: "cancelled" } }, options)).toBe(false);
  // An option id the agent never offered is not an allow.
  expect(permissionGranted({ outcome: { outcome: "selected", optionId: "ghost" } }, options)).toBe(false);
});

test("params helpers raise invalid-params rather than letting a TypeError escape", () => {
  expect(() => requireObjectParams(undefined, "session/new")).toThrow("params must be an object");
  expect(() => requireObjectParams([], "session/new")).toThrow("params must be an object");
  expect(requireObjectParams({ cwd: "/repo" }, "session/new")).toEqual({ cwd: "/repo" });

  expect(() => requireStringField({}, "cwd", "session/new")).toThrow("cwd must be a non-empty string");
  expect(() => requireStringField({ cwd: "" }, "cwd", "session/new")).toThrow("non-empty");
  expect(requireStringField({ cwd: "/repo" }, "cwd", "session/new")).toBe("/repo");
});

// AC7 states that a protocol-version bump touches ONE module plus its tests.
// That claim is only worth making if something can falsify it: this reads the
// directory and fails when a wire shape leaks into a sibling file.
test("no file outside protocol.ts names a protocol version or an ACP method", () => {
  const dir = import.meta.dir;
  const offenders: string[] = [];

  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".ts") || entry === "protocol.ts" || entry.endsWith(".test.ts")) {
      continue;
    }
    const source = readFileSync(path.join(dir, entry), "utf8");
    // Comments explain the split and are allowed to name methods; code is not.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    if (/"(?:session|fs|terminal|elicitation)\/[a-z_]+"/.test(code) || /"initialize"/.test(code)) {
      offenders.push(entry);
    }
  }

  expect(offenders).toEqual([]);
});

// Flow 288, AC7: the shapes the published docs define for slash commands and
// session config options ("Slash Commands", "Session Config Options"), typed
// rather than `unknown[]`. Written out as typed literals so a drift in either
// direction fails the typecheck, and asserted at runtime so this file says what
// the wire carries.
test("session/set_config_option is implemented, not refused (flow 288)", () => {
  expect(ACP_IMPLEMENTED_AGENT_METHODS).toContain(ACP_AGENT_METHODS.sessionSetConfigOption);
  expect(ACP_REFUSED_AGENT_METHODS.has(ACP_AGENT_METHODS.sessionSetConfigOption)).toBe(false);
});

test("available commands, config options and their updates carry the published fields", () => {
  const command: AcpAvailableCommand = { name: "model", description: "Switch", input: { hint: "model id" } };
  const option: AcpSessionConfigOption = {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "a/b",
    options: [{ value: "a/b", name: "b", description: "a" }],
  };
  const request: AcpSetSessionConfigOptionRequest = { sessionId: "s", configId: "model", value: "a/b" };
  const response: AcpSetSessionConfigOptionResponse = { configOptions: [option] };
  const commandsUpdate: AcpSessionUpdate = { sessionUpdate: "available_commands_update", availableCommands: [command] };
  const optionsUpdate: AcpSessionUpdate = { sessionUpdate: "config_option_update", configOptions: [option] };
  expect(Object.keys(request).sort()).toEqual(["configId", "sessionId", "value"]);
  expect(response.configOptions[0]?.category).toBe("model");
  expect(commandsUpdate).toMatchObject({ availableCommands: [{ name: "model", input: { hint: "model id" } }] });
  expect(optionsUpdate).toMatchObject({ configOptions: [{ type: "select", currentValue: "a/b" }] });
});
