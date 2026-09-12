// `/mcp` — the MCP servers keryx CONNECTS TO.
//
// The other half of D-04's rename, and the reason `/mcp` kept opening the
// installer until now. `mcp-inspector.ts` said so plainly:
//
//   "It is deliberately NOT repointed at the MCP-server consumer: that
//    surface does not exist yet, and a slash command aimed at nothing is
//    worse than one aimed at the old thing."
//
// It exists now. `/mcp` is the consumer view — what keryx is connected
// to, what failed, and what is waiting for `keryx mcp trust`.
// `/integrations` stays the installer view: where keryx ITSELF is
// registered into an editor's config. The two are easy to confuse, which
// is why they are two commands with two captions rather than two tabs.
//
// The model is built by a PURE function. Everything AC3-AC5 asks about —
// what is shown, what is elided, what is neutralised — is a property of
// that value, so it is asserted against the value and not against a
// terminal. The P0/P1 lesson, applied before the fact this time: the
// approval rendering went untested for two phases precisely because it
// only existed inside a TUI callback.

import { displayUrl } from "../mcp-servers/http-headers";
import { sanitiseForDisplay } from "../mcp-servers/tools";
import { sanitiseIdentifier } from "../mcp-servers/approval-render";
import { transportOf } from "../mcp-servers/doctor";
import type { ResolvedMcpServer } from "../mcp-servers/config";
import type { ServerState } from "../mcp-servers/manager";
import { modalBodyRows, openModal, resolveModalPanelSize } from "./modal-host";
import { clampScroll, scrollToReveal } from "./review-inspector";
import { clearTranscriptChildren } from "./transcript-blocks";

export const MCP_CONSUMER_COMMAND = "/mcp";

export function isMcpConsumerCommand(line: string): boolean {
  return (line.trim().split(/\s+/)[0] ?? "") === MCP_CONSUMER_COMMAND;
}

export type ConsumerRow = {
  readonly name: string;
  readonly source: string;
  readonly transport: string;
  readonly status: string;
  readonly toolCount: number;
  /** Where it points: an elided url, or the command line. Never a secret. */
  readonly target: string;
  /**
   * The variables this server reads, by NAME.
   *
   * The operator needs to know a server is handed `GITHUB_TOKEN`; they
   * gain nothing from seeing the token and lose everything if the screen
   * is shared. Same rule as the trust prompt.
   */
  readonly credentials: readonly string[];
  /** One line of why, when there is a why. Already safe to print. */
  readonly detail: string | undefined;
  /** What the operator should DO, when there is something. */
  readonly action: string | undefined;
};

export type ConsumerModel = {
  readonly rows: readonly ConsumerRow[];
  readonly problems: readonly string[];
  /** Shown when there is nothing at all, with the files that were read. */
  readonly emptyHint: string | undefined;
};

/** Variable names a server would read, from the RAW entry. Never values. */
function credentialNames(server: ResolvedMcpServer): string[] {
  const names = new Set<string>();
  const raw = server.raw;
  if (typeof raw.bearer_token_env_var === "string" && raw.bearer_token_env_var !== "") {
    names.add(raw.bearer_token_env_var);
  }
  for (const value of Object.values(raw.headers ?? {})) {
    for (const match of value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)/g)) names.add(match[1] as string);
  }
  for (const value of Object.values(raw.env ?? {})) {
    for (const match of value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)/g)) names.add(match[1] as string);
  }
  if (typeof raw.url === "string") {
    for (const match of raw.url.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)/g)) names.add(match[1] as string);
  }
  // A header whose value has NO `${}` is a credential pasted in
  // literally, and it was disclosed nowhere here — so `/mcp` said
  // nothing at all about a server sending a static bearer, while
  // `trust.ts` reports exactly that as `literal header(s) …`. Two
  // surfaces with one purpose and this was the weaker of them. The NAME
  // only; the value stays off the screen, as everywhere else.
  for (const [name, value] of Object.entries(raw.headers ?? {})) {
    if (!/\$\{/.test(value)) names.add(`${name} (literal)`);
  }
  return [...names].sort();
}

/**
 * What the row points at, safe to print.
 *
 * `displayUrl` for a remote server — the same function `keryx mcp list`
 * and the trust prompt use, and for the same reason: an operator may
 * write the credential into the url literally, and 0.2.91 shipped a
 * `list` that printed it. A third surface repeating that would be the
 * third time.
 *
 * For stdio it is the RAW command line, so `--token=${GITHUB_TOKEN}`
 * shows the variable rather than its value.
 */
function targetOf(server: ResolvedMcpServer): string {
  const raw = server.raw;
  const target =
    typeof raw.url === "string" && raw.url.length > 0
      ? displayUrl(raw.url)
      : [raw.command, ...(raw.args ?? [])].filter(Boolean).join(" ");
  // SANITISED, and an identifier-grade sanitise at that. This came from
  // a committed `.keryx/mcp-servers.json` — a file in a repository
  // somebody else wrote, which `trust.ts` is explicit is not consent —
  // and nothing in the config loader rejects control characters in
  // `command`, `args` or `url`. `detail` and `problems` were sanitised
  // here and this was not, so the row reading `needs-approval` was
  // precisely the row that could print `\u001b[1A\u001b[2K✓ trusted`
  // over the line above it.
  return sanitiseIdentifier(target);
}

/**
 * Join the configured servers to their live states.
 *
 * Config-first, so a server that is configured and has no state yet
 * appears as `connecting` rather than vanishing — the same rule the
 * runtime follows for its own initial states, and for the same reason: a
 * server the operator configured and cannot see anywhere reads as one
 * keryx never noticed.
 */
export function buildConsumerModel(input: {
  readonly configured: readonly ResolvedMcpServer[];
  readonly states: readonly ServerState[];
  readonly problems: readonly { file: string; message: string }[];
  readonly userFile: string;
  readonly projectFile: string;
}): ConsumerModel {
  const stateByName = new Map(input.states.map((s) => [s.name, s]));

  const rows: ConsumerRow[] = input.configured.map((server) => {
    const state = stateByName.get(server.name);
    const status = state?.status ?? (server.enabled ? "connecting" : "disabled");

    // SANITISED. `ServerState.error` carries the message the SDK produced,
    // which for an HTTP failure embeds the server's own response body
    // verbatim. `doctor` sanitises its copy and this one did not — the
    // asymmetry P1's security reviewer recorded as unreachable "until the
    // surface that would display it exists". This is that surface, so it
    // is reachable now, and it is handled here rather than left for the
    // round after.
    const detail = state?.error === undefined ? undefined : sanitiseForDisplay(state.error);

    return {
      name: server.name,
      source: server.source,
      transport: transportOf(server),
      status,
      toolCount: state?.toolCount ?? 0,
      target: targetOf(server),
      credentials: credentialNames(server),
      detail,
      action:
        status === "needs-approval"
          ? `keryx mcp trust ${server.name}`
          : status === "needs_auth"
            ? "set the variable named above, then restart the session"
            : undefined,
    };
  });

  return {
    rows,
    problems: input.problems.map((p) => `${p.file}: ${sanitiseForDisplay(p.message)}`),
    emptyHint:
      rows.length > 0
        ? undefined
        : `No MCP servers configured.\n  user:    ${input.userFile}\n  project: ${input.projectFile}`,
  };
}

/**
 * Every line the view prints, in order — including the no-session case.
 *
 * Built here rather than in the TUI callback for the reason the last
 * commit gave, one file over: the mutation sweep showed that five
 * separate decisions in that callback could be inverted with nothing
 * failing, because a callback inside `tui-shell.ts` has no harness. This
 * is the third time on this branch that moving lines into a value was
 * the fix, so it is now the default rather than the remedy.
 */
export function renderConsumerLines(model: ConsumerModel | undefined): string[] {
  if (model === undefined) {
    // No runtime: `--chat` never builds a tool list, and opening a
    // read-only view must not be what spawns every configured server.
    // Saying which of the two states this is beats an empty panel.
    return [
      "No MCP session yet — this shell has not built a tool list.",
      "Configured servers are listed by `keryx mcp list`; `keryx mcp doctor` dials them.",
    ];
  }
  return [
    ...model.problems.flatMap((problem) =>
      problem.split("\n").map((line, index) => (index === 0 ? `config problem — ${line}` : `    ${line}`)),
    ),
    ...(model.emptyHint === undefined ? [] : model.emptyHint.split("\n")),
    ...model.rows.flatMap((row) => {
      const lines = [formatConsumerRow(row)];
      // EVERY line of the detail is indented, not just the first.
      //
      // `state.error` is the SDK's message, which for an HTTP failure
      // embeds the server's response body verbatim, and the sanitiser
      // keeps `\n` because a multi-line error message is legitimate.
      // Indenting only the first line let a 400 body of
      // "\ngithub (user http connected) — 41 tool(s)  https://…"
      // render two fabricated rows at column 0, indistinguishable from
      // real ones. A message-shaped sanitiser applied to record-shaped
      // output; the fix belongs at the record, which is here.
      if (row.detail !== undefined) {
        for (const line of row.detail.split("\n")) lines.push(`    ${line}`);
      }
      if (row.action !== undefined) lines.push(`    → ${row.action}`);
      return lines;
    }),
  ];
}

/** One line per row, for a surface that renders text. */
export function formatConsumerRow(row: ConsumerRow): string {
  const tags = [row.source, row.transport, row.status].join(" ");
  const tools = row.status === "connected" ? ` — ${row.toolCount} tool(s)` : "";
  const creds = row.credentials.length > 0 ? `  [reads ${row.credentials.join(", ")}]` : "";
  return `${row.name} (${tags})${tools}  ${row.target}${creds}`;
}


export const MCP_CONSUMER_FOOTER = [
  { key: "↑/↓", label: "select" },
  { key: "click", label: "row: select/act" },
  { key: "c/d", label: "connect/disconnect" },
  { key: "y", label: "confirm" },
  { key: "esc", label: "close" },
] as const;

export const MCP_CONSUMER_HEADER =
  "Servers keryx CONNECTS TO. c/d then y to connect or disconnect. Held project servers need `keryx mcp trust` first.";

const STATUS_GLYPH: Record<string, string> = {
  connected: "● connected",
  connecting: "… connecting",
  failed: "✗ failed",
  disabled: "○ disabled",
  "needs-approval": "! needs approval",
  needs_auth: "! needs auth",
};

export type ConsumerArmedAction = { name: string; action: "connect" | "disconnect" };
export type ConsumerActionStatus =
  | { kind: "idle" }
  | { kind: "armed"; target: ConsumerArmedAction }
  | { kind: "running"; target: ConsumerArmedAction }
  | { kind: "done"; target: ConsumerArmedAction; outcome: { ok: true } | { ok: false; message: string } };

/** Connect is offered for a server that is not live; disconnect for one that is. Held/auth rows name the CLI instead. */
export function consumerActionFor(status: string): "connect" | "disconnect" | undefined {
  if (status === "connected") return "disconnect";
  if (status === "disabled" || status === "failed") return "connect";
  return undefined;
}

function statusGlyph(status: string): string {
  return STATUS_GLYPH[status] ?? status;
}

export function formatConsumerModalRow(row: ConsumerRow, isSelected: boolean, status: ConsumerActionStatus): string {
  const mark = isSelected ? ">" : " ";
  const name = row.name.padEnd(18);
  const source = row.source.padEnd(10);
  const transport = row.transport.padEnd(6);
  const glyph = statusGlyph(row.status).padEnd(18);
  const tools = row.status === "connected" ? `${row.toolCount} tool(s)` : "";
  let action: string;
  const offered = consumerActionFor(row.status);
  if (status.kind === "armed" && status.target.name === row.name) {
    action = `  [click again or press y to ${status.target.action}]`;
  } else if (status.kind === "running" && status.target.name === row.name) {
    action = `  ${status.target.action === "connect" ? "connecting…" : "disconnecting…"}`;
  } else if (status.kind === "done" && status.target.name === row.name) {
    action = status.outcome.ok ? "  ✓ done" : `  ✗ ${status.outcome.message}`;
  } else if (offered === "disconnect") {
    action = "  [d] disconnect";
  } else if (offered === "connect") {
    action = "  [c] connect";
  } else if (row.action !== undefined) {
    action = `  → ${row.action}`;
  } else {
    action = "";
  }
  const creds = row.credentials.length > 0 ? `  [reads ${row.credentials.join(", ")}]` : "";
  return `${mark} ${name} ${source} ${transport} ${glyph}${tools}${action}  ${row.target}${creds}`.trimEnd();
}

export function formatConsumerModalLines(
  model: ConsumerModel | undefined,
  selected: number,
  status: ConsumerActionStatus,
): string[] {
  if (model === undefined) {
    return [
      "No MCP session yet — this shell has not built a tool list.",
      "Configured servers are listed by `keryx mcp list`; `keryx mcp doctor` dials them.",
    ];
  }
  const header = [MCP_CONSUMER_HEADER];
  const problems = model.problems.flatMap((problem) =>
    problem.split("\n").map((line, index) => (index === 0 ? `config problem — ${line}` : `    ${line}`)),
  );
  if (model.emptyHint !== undefined) {
    return [...header, ...problems, ...model.emptyHint.split("\n")];
  }
  return [
    ...header,
    ...problems,
    ...model.rows.map((row, index) => formatConsumerModalRow(row, index === selected, status)),
  ];
}

export type ConsumerConnectFn = (name: string) => Promise<{ ok: true } | { ok: false; message: string }>;

export type PresentMcpConsumerOptions = {
  snapshot: () => ConsumerModel | undefined;
  connect: ConsumerConnectFn;
  disconnect: ConsumerConnectFn;
  renderer?: { width?: number; height?: number };
  visibleRows?: number;
  onKeypress?: (handler: (key: { name: string; sequence: string }) => void) => () => void;
};

type RowNode = { content: string };
type RowTextCtor = new (
  renderer: unknown,
  opts: { id: string; content: string; onMouseDown?: () => void },
) => RowNode;
type RowTarget = {
  add: (child: unknown) => void;
  getChildren: () => readonly unknown[];
  remove: (child: unknown) => void;
};

function asRowTarget(body: unknown): RowTarget | undefined {
  const parent = body as {
    add?: (child: unknown) => void;
    getChildren?: () => readonly unknown[];
    remove?: (child: unknown) => void;
  };
  if (parent.add === undefined || parent.getChildren === undefined || parent.remove === undefined) {
    return undefined;
  }
  return {
    add: parent.add.bind(parent),
    getChildren: parent.getChildren.bind(parent),
    remove: parent.remove.bind(parent),
  };
}

export type ModalTab = { id: string; label: string };
export type OpenModalInput = {
  title: string;
  tabs: readonly ModalTab[];
  initialTab?: string;
  footer?: readonly { key: string; label: string }[];
  renderTab: (tabId: string, body: unknown, ctx?: { width: number }) => void | (() => void);
  onClose?: () => void;
};
export type ModalHandle = {
  close(): void;
  setTab(id: string): void;
  activeTab(): string;
};
export type OpenModalFn = (otui: unknown, chrome: unknown, input: OpenModalInput) => ModalHandle | undefined;

export function presentMcpConsumer(
  openModalFn: OpenModalFn,
  otui: unknown,
  chrome: unknown,
  options: PresentMcpConsumerOptions,
): ModalHandle | undefined {
  let selected = 0;
  let scroll = 0;
  let status: ConsumerActionStatus = { kind: "idle" };
  let body: RowTarget | undefined;
  let rowCtor: RowTextCtor | undefined;
  let activeRenderer: unknown;
  let unsubscribeKey: (() => void) | undefined;
  const rendererHint =
    options.renderer ?? (chrome as { renderer?: { width?: number; height?: number } } | undefined)?.renderer;
  const bodyRows =
    options.visibleRows ??
    (typeof rendererHint?.width === "number" && typeof rendererHint.height === "number"
      ? modalBodyRows(resolveModalPanelSize(rendererHint.width, rendererHint.height).height)
      : 13);

  const rowsOf = (): readonly ConsumerRow[] => options.snapshot()?.rows ?? [];

  const paint = (): void => {
    if (body === undefined || rowCtor === undefined) return;
    clearTranscriptChildren(body);
    const model = options.snapshot();
    const rows = model?.rows ?? [];
    selected = rows.length === 0 ? 0 : Math.min(selected, rows.length - 1);
    scroll = scrollToReveal(selected, scroll, bodyRows);
    scroll = clampScroll(scroll, Math.max(rows.length, 1), bodyRows);
    const lines = formatConsumerModalLines(model, selected, status);
    if (rows.length === 0) {
      for (const [i, line] of lines.entries()) {
        body.add(new rowCtor(activeRenderer, { id: `mcp-consumer-line-${i}`, content: line }));
      }
      return;
    }
    body.add(new rowCtor(activeRenderer, { id: "mcp-consumer-header", content: MCP_CONSUMER_HEADER }));
    const problems = model?.problems ?? [];
    for (const [i, problem] of problems.entries()) {
      body.add(
        new rowCtor(activeRenderer, {
          id: `mcp-consumer-problem-${i}`,
          content: `config problem — ${problem}`,
        }),
      );
    }
    const start = clampScroll(scroll, rows.length, bodyRows);
    for (const [i, row] of rows.slice(start, start + bodyRows).entries()) {
      const index = start + i;
      body.add(
        new rowCtor(activeRenderer, {
          id: `mcp-consumer-row-${row.name}`,
          content: formatConsumerModalRow(row, index === selected, status),
          onMouseDown: () => handleRowClick(row.name, index),
        }),
      );
    }
  };

  const moveSelection = (next: number): void => {
    const rows = rowsOf();
    if (rows.length === 0) return;
    const clamped = Math.min(rows.length - 1, Math.max(0, next));
    if (clamped === selected) return;
    selected = clamped;
    status = { kind: "idle" };
    paint();
  };

  const runAction = (): void => {
    if (status.kind !== "armed") return;
    const target = status.target;
    status = { kind: "running", target };
    paint();
    const fn = target.action === "connect" ? options.connect : options.disconnect;
    void fn(target.name).then((outcome) => {
      status = { kind: "done", target, outcome };
      paint();
    });
  };

  const armFor = (name: string): void => {
    const rows = rowsOf();
    const index = rows.findIndex((row) => row.name === name);
    const row = rows[index];
    const offered = row === undefined ? undefined : consumerActionFor(row.status);
    if (index < 0 || row === undefined || offered === undefined || status.kind === "running") return;
    selected = index;
    status = { kind: "armed", target: { name: row.name, action: offered } };
    paint();
  };

  const handleRowClick = (name: string, index: number): void => {
    if (status.kind === "armed" && status.target.name === name) {
      runAction();
      return;
    }
    if (status.kind === "running") return;
    const row = rowsOf()[index];
    if (row === undefined || consumerActionFor(row.status) === undefined) {
      if (index !== selected) {
        selected = index;
        status = { kind: "idle" };
        paint();
      }
      return;
    }
    armFor(name);
  };

  const handle = openModalFn(otui, chrome, {
    title: "MCP servers",
    tabs: [{ id: "servers", label: "Servers" }],
    initialTab: "servers",
    footer: MCP_CONSUMER_FOOTER,
    renderTab: (_tabId, tabBody, ctx) => {
      const renderer = options.renderer ?? (chrome as { renderer?: unknown } | undefined)?.renderer;
      const ctor = (otui as { TextRenderable?: RowTextCtor }).TextRenderable;
      const target = asRowTarget(tabBody);
      if (target === undefined || ctor === undefined) return;
      rowCtor = ctor;
      activeRenderer = renderer;
      body = target;
      paint();
      void ctx;
    },
    onClose: () => {
      unsubscribeKey?.();
    },
  });
  if (handle === undefined) return undefined;
  if (options.onKeypress !== undefined) {
    unsubscribeKey = options.onKeypress((key) => {
      const token = key.name || key.sequence;
      const rows = rowsOf();
      if (status.kind === "armed") {
        if (token === "y") {
          runAction();
        } else {
          status = { kind: "idle" };
          paint();
        }
        return;
      }
      if (token === "c") {
        const row = rows[selected];
        if (row !== undefined && consumerActionFor(row.status) === "connect" && status.kind !== "running") {
          status = { kind: "armed", target: { name: row.name, action: "connect" } };
          paint();
        }
        return;
      }
      if (token === "d") {
        const row = rows[selected];
        if (row !== undefined && consumerActionFor(row.status) === "disconnect" && status.kind !== "running") {
          status = { kind: "armed", target: { name: row.name, action: "disconnect" } };
          paint();
        }
        return;
      }
      if (token === "up" || token === "k") {
        moveSelection(selected - 1);
        return;
      }
      if (token === "down" || token === "j") {
        moveSelection(selected + 1);
        return;
      }
      if (token === "pageup" || token === "pagedown") {
        const step = token === "pageup" ? -bodyRows : bodyRows;
        scroll = clampScroll(scroll + step, Math.max(rows.length, 1), bodyRows);
        paint();
      }
    });
  }
  return handle;
}

export function openMcpConsumer(
  otui: Parameters<typeof openModal>[0],
  chrome: Parameters<typeof openModal>[1],
  options: PresentMcpConsumerOptions,
): ModalHandle | undefined {
  return presentMcpConsumer(
    (hostOtui, hostChrome, input) => openModal(hostOtui as typeof otui, hostChrome as typeof chrome, input),
    otui,
    chrome,
    options,
  );
}
