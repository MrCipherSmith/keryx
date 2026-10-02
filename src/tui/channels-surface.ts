// `/channels` (flow 377): connect Telegram to this machine, test it, disconnect it.
// The sidebar row, the modal and the readline text are all built from one
// `ChannelsSnapshot`, so no surface states something the others do not.
//
// The bot token is the one secret that passes through this file. opentui's input
// renderable cannot mask, so the token step is built by hand: a key and paste handler
// takes every key (the modal host is told so through `ownsKeys`, so `x` and Esc never close
// it from under the field, whichever listener runs first), keeps the token in a closure
// variable and draws asterisks. The composer, the transcript, the input history and the
// scrollback never see it. It is handed to `client.startPairing` once and dropped; it is
// never put in a notice, a status line or an error.

import type { ChannelsClient, ChannelsLocalFiles } from "../remote/channels-client";
import type { PairingResponse } from "../remote/protocol";
import { smallActionButton } from "./action-button";
import { openModal, type ModalHandle } from "./modal-host";
import { CONFIRM_MIN_GAP_MS } from "./settings-modal";
import { getTheme, onThemeChange, type TextRole } from "./theme";
import { guardedThemeRepaint, isRenderableGone } from "./theme-repaint";
import { boldChunk, dimChunk, roleChunk } from "./theme-text";

type OpenTui = typeof import("@opentui/core");
type Box = InstanceType<OpenTui["BoxRenderable"]>;

export const CHANNELS_COMMAND = "/channels";
export const CHANNELS_SUMMARY = "Connect, test or disconnect Telegram for this machine: /channels [status]";
export const CHANNELS_USAGE = `Usage: ${CHANNELS_COMMAND} [status]`;

export function isChannelsCommand(line: string): boolean {
  return (line.trim().split(/\s+/)[0] ?? "") === CHANNELS_COMMAND;
}

export type ChannelsRequest = { action: "open" } | { action: "invalid"; message: string };

/** `/channels` and `/channels status` open the modal; anything else is a usage error. */
export function parseChannelsArgs(line: string): ChannelsRequest {
  const words = line.trim().split(/\s+/).slice(1);
  if (words.length === 0 || (words.length === 1 && words[0]!.toLowerCase() === "status")) return { action: "open" };
  return { action: "invalid", message: CHANNELS_USAGE };
}

// ---------------------------------------------------------------------------
// Snapshot: what every surface draws
// ---------------------------------------------------------------------------

export type ChannelsApi = Pick<
  ChannelsClient,
  "localFiles" | "status" | "startPairing" | "pairingStatus" | "cancelPairing" | "connectFinish" | "reload" | "test" | "disconnect"
>;

export type ChannelsSnapshotState = "not-connected" | "pairing" | "connected" | "off" | "serve-down" | "error";

export interface ChannelsSnapshot {
  state: ChannelsSnapshotState;
  /** A token or config file is on this machine, whether or not serve could be reached. */
  configured: boolean;
  machine?: string;
  sessions?: number;
  /** Serve's or the client's own plain-language reason. */
  reason?: string;
}

export async function loadChannelsSnapshot(client: Pick<ChannelsApi, "status" | "localFiles">): Promise<ChannelsSnapshot> {
  const status = await client.status();
  const local: ChannelsLocalFiles = client.localFiles();
  if (status.ok) {
    const { machine, telegram } = status.value;
    return {
      state: telegram.state,
      // A token or config left on disk counts even when serve says nothing is connected (a crash between the two writes).
      configured: telegram.state !== "not-connected" || local.tokenFile || local.configFile,
      machine,
      sessions: telegram.sessions,
      ...(telegram.reason !== undefined ? { reason: telegram.reason } : {}),
    };
  }
  const configured = local.tokenFile || local.configFile;
  const down = status.code === "serve-down" || status.code === "unsafe-endpoint";
  return { state: down ? "serve-down" : "error", configured, reason: status.reason };
}

export interface ChannelsRow {
  /** The value shown after the "Telegram" label. */
  readonly text: string;
  readonly role: TextRole;
  readonly action: "open";
}

function fit(text: string, width: number): string {
  if (width <= 0) return "";
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;
}

/** `Telegram: off | pairing | connected | serve down`, as the value half of the row. */
export function projectChannelsRow(snapshot: ChannelsSnapshot | undefined, width: number): ChannelsRow {
  if (snapshot === undefined) return { text: fit("…", width), role: "muted", action: "open" };
  switch (snapshot.state) {
    case "connected":
      return { text: fit("connected", width), role: "ok", action: "open" };
    case "pairing":
      return { text: fit("pairing", width), role: "attention", action: "open" };
    case "off":
      return { text: fit("off", width), role: "attention", action: "open" };
    case "serve-down":
      return snapshot.configured
        ? { text: fit("serve down", width), role: "attention", action: "open" }
        : { text: fit("off", width), role: "muted", action: "open" };
    case "error":
      return { text: fit("error", width), role: "attention", action: "open" };
    default:
      return { text: fit("off", width), role: "muted", action: "open" };
  }
}

/** The status block shared by the modal's list view and the readline text. */
export function channelsStatusLines(snapshot: ChannelsSnapshot): string[] {
  const machine = snapshot.machine === undefined ? [] : [`Machine: ${snapshot.machine}`];
  switch (snapshot.state) {
    case "not-connected":
      return [
        "Telegram: not connected",
        ...machine,
        ...(snapshot.configured
          ? ["A bot token is left on this machine from an unfinished connection. Connect starts over; Disconnect erases it."]
          : [
              "This machine has no bot yet. Connect it to drive keryx sessions from Telegram topics.",
              "You need a bot token from @BotFather and a Telegram group with topics turned on.",
            ]),
      ];
    case "pairing":
      return [
        "Telegram: pairing in progress",
        ...machine,
        "Resume shows the one-time code again, or connects a pairing that already finished; Cancel pairing abandons it and erases the token.",
      ];
    case "connected":
      return [
        "Telegram: connected",
        ...machine,
        `Sessions in Telegram: ${snapshot.sessions ?? 0}`,
        "Test sends one message to the General topic. Disconnect deletes the topics and erases the token.",
        "Sessions join through /remote-control in each shell.",
      ];
    case "off":
      return [
        "Telegram: configured, but not running",
        ...machine,
        ...(snapshot.reason === undefined ? [] : [`Why: ${snapshot.reason}`]),
        "Retry starts it again from the saved token and config. Disconnect erases them. Test works once Telegram is running.",
      ];
    case "serve-down":
      return [
        "Telegram: keryx serve is not running",
        ...(snapshot.reason === undefined ? [] : [snapshot.reason]),
        snapshot.configured
          ? "A bot is configured on this machine; it works again once `keryx serve` runs. Disconnect still erases the token."
          : "Start `keryx serve`, then connect.",
      ];
    case "error":
      return ["Telegram: status unavailable", ...(snapshot.reason === undefined ? [] : [snapshot.reason])];
  }
}

/**
 * The readline shell's whole `/channels`. That shell has no hidden input, so it cannot take a
 * bot token: it shows the state and points at the full-screen shell, where Connect is.
 */
export function readlineChannelsText(line: string, snapshot: ChannelsSnapshot): string {
  const request = parseChannelsArgs(line);
  if (request.action === "invalid") return `${request.message}\n`;
  const how =
    snapshot.state === "not-connected" || snapshot.state === "serve-down" || snapshot.state === "error"
      ? "Connecting needs a hidden token entry, which this line-based shell cannot give: run `keryx shell` (the full-screen shell) and use /channels there."
      : "Test and Disconnect are in the full-screen shell: run `keryx shell` and use /channels there.";
  return `${[...channelsStatusLines(snapshot), "", how].join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Modal: views and their text
// ---------------------------------------------------------------------------

type Notice = { tone: "ok" | "attention" | "error"; text: string };

export type ChannelsView =
  | { kind: "list"; notice?: Notice }
  | { kind: "token"; error?: string }
  | { kind: "working"; text: string }
  | { kind: "pairing"; pairing: PairingResponse }
  | { kind: "connected"; group?: string; test: Notice }
  | { kind: "failed"; title: string; reason: string }
  | { kind: "confirm-disconnect" };

export type ViewTone = "heading" | "text" | "muted" | "ok" | "attention" | "error" | "code";
export interface ViewLine {
  text: string;
  tone: ViewTone;
}

export const CHANNELS_FOOTER = [
  { key: "c", label: "connect" },
  { key: "t", label: "test" },
  { key: "d", label: "disconnect" },
  { key: "←/→", label: "button" },
  { key: "Enter", label: "press" },
  { key: "esc", label: "back" },
] as const;

/** `9 min`, `less than a minute`, `expired`. */
export function codeLifetime(expiresAt: number, now: number): string {
  const left = expiresAt - now;
  if (left <= 0) return "expired";
  if (left < 60_000) return "less than a minute";
  return `${Math.ceil(left / 60_000)} min`;
}

export function channelsViewLines(
  view: ChannelsView,
  snapshot: ChannelsSnapshot | undefined,
  ctx: { tokenLength: number; now: number },
): ViewLine[] {
  switch (view.kind) {
    case "list": {
      const lines: ViewLine[] = [];
      if (view.notice !== undefined) lines.push({ text: view.notice.text, tone: view.notice.tone }, { text: "", tone: "text" });
      if (snapshot === undefined) return [...lines, { text: "Reading the Telegram state…", tone: "muted" }];
      const [first, ...rest] = channelsStatusLines(snapshot);
      return [...lines, { text: first!, tone: "heading" }, ...rest.map((text): ViewLine => ({ text, tone: "text" }))];
    }
    case "token":
      return [
        { text: "Step 1 of 4 · Bot token", tone: "heading" },
        { text: "Create a bot with @BotFather in Telegram, then paste its token here.", tone: "text" },
        { text: "", tone: "text" },
        { text: `Token: ${"*".repeat(Math.min(ctx.tokenLength, 60))}${ctx.tokenLength === 0 ? "(waiting for the token)" : ""}`, tone: "code" },
        ...(view.error === undefined ? [] : [{ text: view.error, tone: "error" as const }]),
        { text: "", tone: "text" },
        { text: "Typed hidden: the token is not shown, not kept in history and not logged. It goes only to this machine's owner-only keryx config.", tone: "muted" },
        { text: "Enter to continue · Esc to go back", tone: "muted" },
      ];
    case "working":
      return [{ text: view.text, tone: "heading" }];
    case "pairing": {
      const { pairing } = view;
      const bot = pairing.botUsername === undefined ? "the bot" : `@${pairing.botUsername}`;
      if (pairing.state === "waiting-for-user") {
        return [
          { text: "Step 2 of 4 · Send the code to the bot", tone: "heading" },
          { text: `Open a private chat with ${bot} in Telegram and send it this code:`, tone: "text" },
          { text: "", tone: "text" },
          { text: `    ${pairing.code ?? "(no code: cancel and connect again)"}`, tone: "code" },
          { text: "", tone: "text" },
          { text: `Waiting for your message… the code is valid for ${codeLifetime(pairing.expiresAt, ctx.now)} and works once.`, tone: "muted" },
          ...(pairing.problems.length === 0 ? [] : pairing.problems.map((text): ViewLine => ({ text, tone: "attention" }))),
        ];
      }
      return [
        { text: "Step 3 of 4 · Add the bot to your group", tone: "heading" },
        { text: `Add ${bot} to your Telegram group as an administrator with the "Manage topics" right. The group must have topics turned on.`, tone: "text" },
        ...(pairing.chatTitle === undefined ? [] : [{ text: `Group: ${pairing.chatTitle}`, tone: "text" as const }]),
        ...(pairing.problems.length === 0
          ? [{ text: `Waiting for the group… ${codeLifetime(pairing.expiresAt, ctx.now)} left. A bot that is already in the group is picked up too.`, tone: "muted" as const }]
          : [{ text: "Still missing:", tone: "attention" as const }, ...pairing.problems.map((text): ViewLine => ({ text: `  - ${text}`, tone: "attention" }))]),
      ];
    }
    case "connected":
      return [
        { text: "Step 4 of 4 · Connected", tone: "heading" },
        ...(view.group === undefined ? [] : [{ text: `Group: ${view.group}`, tone: "text" as const }]),
        ...(snapshot?.machine === undefined ? [] : [{ text: `Machine: ${snapshot.machine}`, tone: "text" as const }]),
        { text: view.test.text, tone: view.test.tone },
        { text: "Turn a session on with /remote-control in each shell.", tone: "muted" },
      ];
    case "failed":
      return [
        { text: view.title, tone: "error" },
        { text: view.reason, tone: "text" },
        { text: "Nothing was kept on this machine for the attempt that failed.", tone: "muted" },
      ];
    case "confirm-disconnect":
      return [
        { text: "Disconnect Telegram from this machine?", tone: "heading" },
        { text: "This deletes every keryx topic in the group, stops polling, and erases the bot token and the config.", tone: "attention" },
        { text: "The group itself and the bot stay in Telegram.", tone: "muted" },
      ];
  }
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

type KeyLike = {
  name: string;
  sequence: string;
  ctrl?: boolean;
  meta?: boolean;
  preventDefault?: () => void;
  stopPropagation?: () => void;
};
type PasteLike = { bytes: Uint8Array; preventDefault?: () => void; stopPropagation?: () => void };

export interface OpenChannelsOptions {
  client: ChannelsApi;
  /** The last known state, so the first frame is not empty. */
  snapshot?: ChannelsSnapshot | undefined;
  renderer: Parameters<typeof smallActionButton>[1];
  onKeypress: (handler: (key: KeyLike) => void) => () => void;
  /** The renderer's paste stream. Without it the token can only be typed. */
  onPaste?: (handler: (event: PasteLike) => void) => () => void;
  inputBlocked?: () => boolean;
  /** Told every time the modal learns the state, so the sidebar follows. */
  onChanged?: (snapshot: ChannelsSnapshot) => void;
  now?: () => number;
  pollMs?: number;
  /** Runs `fn` every `ms` until the returned function is called. Injectable for tests. */
  schedule?: (fn: () => void, ms: number) => () => void;
}

interface Action {
  id: string;
  label: string;
  tone: "primary" | "danger" | "plain";
  run: () => void;
}

const TOKEN_CHAR = /^[A-Za-z0-9_:-]$/;
const TOKEN_MAX = 200;
export const PAIRING_POLL_MS = 2_000;

const swallow = (event: { preventDefault?: () => void; stopPropagation?: () => void }): void => {
  event.preventDefault?.();
  event.stopPropagation?.();
};

function defaultSchedule(fn: () => void, ms: number): () => void {
  const timer = setInterval(fn, ms);
  return () => clearInterval(timer);
}

export function openChannels(otui: unknown, chrome: unknown, options: OpenChannelsOptions): ModalHandle | undefined {
  const core = otui as OpenTui;
  const r = options.renderer;
  const { client } = options;
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? defaultSchedule;

  let snapshot = options.snapshot;
  let view: ChannelsView = { kind: "list" };
  let secret = "";
  let selected = 0;
  let busy = false;
  let closed = false;
  // Bumped on every view change: an answer that arrives for a view the operator left is dropped.
  let epoch = 0;
  let confirmArmedAt = 0;
  let stopPolling: () => void = () => {};
  let polling = false;
  let body: Box | undefined;
  let blocks: unknown[] = [];

  const blocked = (): boolean => closed || options.inputBlocked?.() === true;

  const learn = (next: ChannelsSnapshot): void => {
    snapshot = next;
    options.onChanged?.(next);
  };
  const reload = async (): Promise<void> => {
    try {
      learn(await loadChannelsSnapshot(client));
    } catch {
      // The old snapshot stays; the next action reads it again.
    }
  };

  // ---- actions per view --------------------------------------------------------------

  function actions(): Action[] {
    switch (view.kind) {
      case "list": {
        if (snapshot === undefined) return [];
        const disconnectButton: Action = { id: "disconnect", label: "Disconnect", tone: "danger", run: () => askDisconnect() };
        switch (snapshot.state) {
          case "pairing":
            return [
              { id: "resume", label: "Resume", tone: "primary", run: () => void resume() },
              { id: "cancel-pairing", label: "Cancel pairing", tone: "danger", run: () => void cancelPairing() },
            ];
          case "connected":
            return [{ id: "test", label: "Test", tone: "primary", run: () => void runTest(false) }, disconnectButton];
          case "not-connected":
            // Leftover files (a crash between the two writes) can only be erased by Disconnect.
            return [{ id: "connect", label: "Connect", tone: "primary", run: () => void beginConnect() }, ...(snapshot.configured ? [disconnectButton] : [])];
          case "off":
            return [{ id: "retry-start", label: "Retry", tone: "primary", run: () => void retryStart() }, disconnectButton];
          default:
            // serve down, error: Connect and Test cannot work, but what is on disk can still be erased.
            return snapshot.configured ? [disconnectButton] : [];
        }
      }
      case "token":
        return [
          { id: "continue", label: "Continue", tone: "primary", run: () => void submitToken() },
          { id: "back", label: "Back", tone: "plain", run: () => backToList() },
        ];
      case "pairing":
        return [
          { id: "cancel-pairing", label: "Cancel pairing", tone: "danger", run: () => void cancelPairing() },
          { id: "back", label: "Back", tone: "plain", run: () => backToList() },
        ];
      case "connected":
        return [
          { id: "test", label: "Test again", tone: "primary", run: () => void runTest(true) },
          { id: "back", label: "Done", tone: "plain", run: () => backToList() },
        ];
      case "failed":
        return [
          { id: "retry", label: "Try again", tone: "primary", run: () => void beginConnect() },
          { id: "back", label: "Back", tone: "plain", run: () => backToList() },
        ];
      case "confirm-disconnect":
        return [
          { id: "cancel", label: "Cancel", tone: "plain", run: () => backToList() },
          { id: "confirm-disconnect", label: "Yes, disconnect", tone: "danger", run: () => void disconnect() },
        ];
      case "working":
        return [];
    }
  }

  // ---- painting ----------------------------------------------------------------------

  function chunkFor(line: ViewLine): ReturnType<typeof boldChunk> {
    const text = line.text === "" ? " " : line.text;
    switch (line.tone) {
      case "heading":
        return boldChunk(core, text);
      case "muted":
        return dimChunk(core, text);
      case "code":
        return core.bold(roleChunk(core, "accent", text));
      case "text":
        return roleChunk(core, "text", text);
      default:
        return roleChunk(core, line.tone, text);
    }
  }

  function paint(): void {
    if (closed || body === undefined) return;
    for (const block of blocks) {
      try {
        body.remove(block as never);
      } catch {
        // already detached
      }
    }
    blocks = [];
    const lines = channelsViewLines(view, snapshot, { tokenLength: secret.length, now: now() });
    lines.forEach((line, index) => {
      const node = new core.TextRenderable(r, { id: `ch-line-${index}`, content: core.t`${chunkFor(line)}` });
      body!.add(node);
      blocks.push(node);
    });
    const available = actions();
    if (available.length > 0) {
      selected = Math.min(selected, available.length - 1);
      const row = new core.BoxRenderable(r, { id: "ch-buttons", width: "100%", flexDirection: "row", marginTop: 1 });
      available.forEach((action, index) => {
        const color = action.tone === "primary" ? getTheme().ok : action.tone === "danger" ? getTheme().error : getTheme().tool;
        const button = smallActionButton(core, r, action.label, `ch-btn-${action.id}`, color, () => {
          if (blocked() || busy) return;
          selected = index;
          press(false);
        });
        button.setActive(index === selected);
        row.add(button.box);
      });
      body.add(row);
      blocks.push(row);
    }
  }

  function go(next: ChannelsView, selection = 0): void {
    epoch += 1;
    stopPolling();
    stopPolling = () => {};
    polling = false;
    view = next;
    selected = selection;
    if (next.kind === "pairing") {
      stopPolling = schedule(() => void pollPairing(), options.pollMs ?? PAIRING_POLL_MS);
    }
    paint();
  }

  function backToList(notice?: Notice): void {
    secret = "";
    go(notice === undefined ? { kind: "list" } : { kind: "list", notice });
  }

  function press(viaKey: boolean): void {
    const action = actions()[selected];
    if (action === undefined) return;
    if (view.kind === "confirm-disconnect" && action.id === "confirm-disconnect" && viaKey && now() - confirmArmedAt < CONFIRM_MIN_GAP_MS) {
      // The Enter that opened this view is still auto-repeating: it is not a decision.
      return;
    }
    action.run();
  }

  // ---- the flow ----------------------------------------------------------------------

  async function beginConnect(): Promise<void> {
    if (busy) return;
    busy = true;
    const mine = epoch + 1;
    go({ kind: "working", text: "Looking for keryx serve…" });
    try {
      await reload();
      if (closed || epoch !== mine) return;
      if (snapshot?.state === "serve-down" || snapshot?.state === "error") {
        backToList({ tone: "attention", text: snapshot.reason ?? "keryx serve is not reachable; start it with `keryx serve`." });
        return;
      }
      if (snapshot?.state === "connected" || snapshot?.state === "off") {
        backToList({ tone: "attention", text: "Telegram is already configured on this machine. Disconnect it first to connect a different bot." });
        return;
      }
      if (snapshot?.state === "pairing") {
        busy = false;
        await resume();
        return;
      }
      secret = "";
      go({ kind: "token" });
    } finally {
      busy = false;
    }
  }

  async function submitToken(): Promise<void> {
    if (view.kind !== "token" || busy || secret.length === 0) return;
    busy = true;
    // The token leaves the closure here: one local, one call, gone.
    const token = secret;
    secret = "";
    go({ kind: "working", text: "Checking the token with Telegram…" });
    const mine = epoch;
    try {
      const result = await client.startPairing(token);
      if (closed || epoch !== mine) return;
      if (!result.ok) {
        go({ kind: "token", error: result.reason });
        return;
      }
      await reload();
      if (closed || epoch !== mine) return;
      go({ kind: "pairing", pairing: result.value });
    } finally {
      busy = false;
    }
  }

  async function resume(): Promise<void> {
    if (busy) return;
    busy = true;
    const mine = epoch + 1;
    go({ kind: "working", text: "Reading the pairing…" });
    try {
      const result = await client.pairingStatus();
      if (closed || epoch !== mine) return;
      if (!result.ok) {
        if (result.code === "no-pairing") {
          await settlePairing(lostPairing());
          return;
        }
        backToList({ tone: "attention", text: result.reason });
        return;
      }
      await settlePairing(result.value);
    } finally {
      busy = false;
    }
  }

  async function settlePairing(pairing: PairingResponse): Promise<void> {
    if (pairing.state === "ready") {
      await finishConnect(pairing);
    } else if (pairing.state === "waiting-for-user" || pairing.state === "waiting-for-group") {
      go({ kind: "pairing", pairing });
    } else {
      // The attempt is over: nothing is kept, so the token written for it goes too (cancelPairing erases it when no config exists).
      const mine = epoch;
      await client.cancelPairing();
      await reload();
      if (closed || epoch !== mine) return;
      go({
        kind: "failed",
        title: pairing.state === "expired" ? "The pairing code expired" : pairing.state === "cancelled" ? "Pairing was cancelled" : "Pairing failed",
        reason: pairing.reason ?? (pairing.state === "expired" ? "The code is valid for 10 minutes. Connect again for a new one." : "Connect again to start over."),
      });
    }
  }

  function lostPairing(): PairingResponse {
    return {
      schemaVersion: "1",
      state: "expired",
      expiresAt: 0,
      problems: [],
      reason: "keryx serve no longer has this pairing (it was restarted or the pairing was dropped), so the code on screen does not work. Connect again for a new one.",
    };
  }

  async function pollPairing(): Promise<void> {
    if (polling || closed || view.kind !== "pairing" || busy) return;
    polling = true;
    const mine = epoch;
    try {
      const result = await client.pairingStatus();
      if (closed || epoch !== mine) return;
      if (!result.ok && result.code === "no-pairing") {
        // Serve restarted (or dropped the pairing): the code on screen no longer works.
        polling = false;
        busy = true;
        try {
          await settlePairing(lostPairing());
        } finally {
          busy = false;
        }
        return;
      }
      if (!result.ok) {
        // A hiccup while waiting: keep the code on screen and say why.
        view = { kind: "pairing", pairing: { ...view.pairing, problems: [...view.pairing.problems.filter((p) => !p.startsWith("serve: ")), `serve: ${result.reason}`] } };
        paint();
        return;
      }
      polling = false;
      const next = result.value;
      if (next.state === "ready" || next.state === "failed" || next.state === "expired" || next.state === "cancelled") {
        busy = true;
        try {
          await settlePairing(next);
        } finally {
          busy = false;
        }
        return;
      }
      view = { kind: "pairing", pairing: next };
      paint();
    } finally {
      polling = false;
    }
  }

  async function finishConnect(pairing: PairingResponse): Promise<void> {
    if (pairing.userId === undefined || pairing.chatId === undefined) {
      await client.cancelPairing();
      await reload();
      go({ kind: "failed", title: "Pairing is incomplete", reason: "Telegram did not report both the user and the group. Connect again." });
      return;
    }
    go({ kind: "working", text: "Connecting…" });
    const mine = epoch;
    const connected = await client.connectFinish({ userId: pairing.userId, chatId: pairing.chatId });
    if (closed || epoch !== mine) return;
    if (!connected.ok) {
      // The client already put the files back; read the state so the list and the sidebar agree with the disk.
      await reload();
      if (closed || epoch !== mine) return;
      go({ kind: "failed", title: "Could not connect", reason: connected.reason });
      return;
    }
    await reload();
    const group = pairing.chatTitle;
    const test = await client.test();
    if (closed || epoch !== mine) return;
    go({ kind: "connected", ...(group === undefined ? {} : { group }), test: testNotice(test) });
  }

  function testNotice(result: Awaited<ReturnType<ChannelsApi["test"]>>): Notice {
    return result.ok
      ? { tone: "ok", text: `Test message delivered to the General topic (machine: ${result.value.machine}).` }
      : { tone: "error", text: `Test message not delivered: ${result.reason}` };
  }

  async function runTest(fromConnected: boolean): Promise<void> {
    if (busy) return;
    busy = true;
    const group = view.kind === "connected" ? view.group : undefined;
    go({ kind: "working", text: "Sending a test message…" });
    const mine = epoch;
    try {
      const result = await client.test();
      if (closed || epoch !== mine) return;
      const notice = testNotice(result);
      await reload();
      if (closed || epoch !== mine) return;
      if (fromConnected) go({ kind: "connected", ...(group === undefined ? {} : { group }), test: notice });
      else backToList(notice);
    } finally {
      busy = false;
    }
  }

  async function retryStart(): Promise<void> {
    if (busy) return;
    busy = true;
    go({ kind: "working", text: "Starting Telegram again…" });
    const mine = epoch;
    try {
      const result = await client.reload();
      await reload();
      if (closed || epoch !== mine) return;
      backToList(
        result.ok
          ? { tone: "ok", text: "Telegram is running again." }
          : { tone: "error", text: `Telegram did not start: ${result.reason}` },
      );
    } finally {
      busy = false;
    }
  }

  async function cancelPairing(): Promise<void> {
    if (busy) return;
    busy = true;
    go({ kind: "working", text: "Cancelling the pairing…" });
    const mine = epoch;
    try {
      const result = await client.cancelPairing();
      await reload();
      if (closed || epoch !== mine) return;
      backToList(result.ok ? { tone: "ok", text: "Pairing cancelled. The token was erased." } : { tone: "attention", text: result.reason });
    } finally {
      busy = false;
    }
  }

  function askDisconnect(): void {
    confirmArmedAt = now();
    go({ kind: "confirm-disconnect" }, 0);
  }

  async function disconnect(): Promise<void> {
    if (busy) return;
    busy = true;
    go({ kind: "working", text: "Deleting the topics and erasing the token…" });
    const mine = epoch;
    try {
      const result = await client.disconnect();
      await reload();
      if (closed || epoch !== mine) return;
      if (!result.ok) {
        backToList({ tone: "error", text: result.code === "no-answer" ? result.reason : `Not disconnected: ${result.reason}` });
        return;
      }
      backToList({ tone: result.value.erased && result.value.remaining === 0 && result.value.topicsDeleted ? "ok" : "attention", text: result.value.message });
    } finally {
      busy = false;
    }
  }

  // ---- keys --------------------------------------------------------------------------

  function appendToken(text: string): void {
    for (const ch of text) {
      if (TOKEN_CHAR.test(ch) && secret.length < TOKEN_MAX) secret += ch;
    }
    paint();
  }

  function tokenKey(key: KeyLike): void {
    const name = key.name;
    if (key.ctrl === true && name === "c") return;
    swallow(key);
    if (name === "escape") {
      backToList();
    } else if (name === "return" || name === "linefeed" || name === "kpenter") {
      void submitToken();
    } else if (name === "backspace" || name === "delete") {
      secret = secret.slice(0, -1);
      paint();
    } else if (key.ctrl === true && name === "u") {
      secret = "";
      paint();
    } else if (key.ctrl !== true && key.meta !== true && key.sequence.length === 1) {
      appendToken(key.sequence);
    }
  }

  const unsubscribeKeys = options.onKeypress((key) => {
    if (blocked()) return;
    if (view.kind === "token") {
      tokenKey(key);
      return;
    }
    const name = key.name;
    const isEnter = name === "return" || name === "linefeed" || name === "kpenter";
    if (name === "escape") {
      // From the list Esc falls through and closes the modal; from any other view it steps back.
      // While work is running the modal stays: the work cannot be cancelled and its outcome must be seen.
      if (view.kind === "working") {
        swallow(key);
        return;
      }
      if (view.kind === "list") return;
      backToList();
      swallow(key);
      return;
    }
    if (busy) return;
    const available = actions();
    if (name === "left" || name === "right") {
      if (available.length < 2) return;
      selected = name === "left" ? Math.max(0, selected - 1) : Math.min(available.length - 1, selected + 1);
      paint();
      swallow(key);
    } else if (isEnter) {
      if (available.length === 0) return;
      press(true);
      swallow(key);
    } else if (view.kind === "list" || view.kind === "connected") {
      const shortcuts: Record<string, string | undefined> = { c: "connect", t: "test", d: "disconnect" };
      const shortcut = shortcuts[key.sequence.toLowerCase()];
      const hit = shortcut === undefined ? undefined : available.find((a) => a.id === shortcut || (shortcut === "connect" && a.id === "resume"));
      if (hit !== undefined && key.ctrl !== true && key.meta !== true) {
        hit.run();
        swallow(key);
      }
    }
  });

  const unsubscribePaste = options.onPaste?.((event) => {
    if (blocked() || view.kind !== "token") return;
    swallow(event);
    appendToken(new TextDecoder().decode(event.bytes));
  });

  let unsubscribeTheme: () => void = () => {};
  const handle = openModal(core, chrome as never, {
    title: CHANNELS_COMMAND,
    tabs: [{ id: "telegram", label: "Telegram" }],
    ownsKeys: () => view.kind === "token",
    footer: CHANNELS_FOOTER,
    contentRows: 14,
    renderTab: (_tabId, tabBody) => {
      body = tabBody as Box;
      blocks = [];
      paint();
    },
    onClose: () => {
      closed = true;
      secret = "";
      stopPolling();
      unsubscribeKeys();
      unsubscribePaste?.();
      unsubscribeTheme();
    },
  });
  if (handle === undefined) {
    closed = true;
    unsubscribeKeys();
    unsubscribePaste?.();
    return undefined;
  }
  unsubscribeTheme = onThemeChange(
    guardedThemeRepaint("channels-modal", paint, () => closed || isRenderableGone(body) || (r as { isDestroyed?: boolean }).isDestroyed === true),
  );
  void reload().then(() => {
    if (!closed && view.kind === "list") paint();
  });
  return handle;
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

type PanelParent = { add(child: unknown): void };
type TextNode = { content: unknown; onMouseDown?: (() => void) | undefined };

export interface ChannelsPanelOptions {
  width: number;
  load: () => Promise<ChannelsSnapshot>;
  onOpen: () => void;
  /** How often the row re-reads the state. Default 10 s. */
  intervalMs?: number;
  schedule?: (fn: () => void, ms: number) => () => void;
}

export interface ChannelsPanelHandle {
  /** Read the state again and repaint. */
  refresh(): Promise<void>;
  /** Repaint from a state the modal already read. */
  update(snapshot: ChannelsSnapshot): void;
  row(): ChannelsRow;
  activate(): "open";
  dispose(): void;
}

export const CHANNELS_ROW_POLL_MS = 10_000;

export function mountChannelsPanel(otui: unknown, renderer: unknown, parent: unknown, options: ChannelsPanelOptions): ChannelsPanelHandle {
  const core = otui as OpenTui;
  const box = new core.BoxRenderable(renderer as never, { id: "sb-channels", flexDirection: "column", flexShrink: 0 });
  (parent as PanelParent).add(box);
  let disposed = false;
  let snapshot: ChannelsSnapshot | undefined;

  const label = new core.TextRenderable(renderer as never, { id: "sb-channels-k", content: core.t`${dimChunk(core, "Telegram")}`, marginTop: 1 });
  const value = new core.TextRenderable(renderer as never, { id: "sb-channels-v", content: "" }) as unknown as TextNode;
  box.add(label);
  box.add(value as never);

  const currentRow = (): ChannelsRow => projectChannelsRow(snapshot, options.width);
  const draw = (): void => {
    if (disposed) return;
    const row = currentRow();
    label.content = core.t`${dimChunk(core, "Telegram")}`;
    value.content = core.t`${roleChunk(core, row.role, row.text)}`;
  };
  const activate = (): "open" => {
    options.onOpen();
    return "open";
  };
  label.onMouseDown = () => {
    activate();
  };
  value.onMouseDown = () => {
    activate();
  };

  const refresh = async (): Promise<void> => {
    try {
      const next = await options.load();
      if (disposed) return;
      snapshot = next;
      draw();
    } catch {
      // The row keeps what it showed.
    }
  };
  const stop = (options.schedule ?? defaultSchedule)(() => void refresh(), options.intervalMs ?? CHANNELS_ROW_POLL_MS);
  const unsubscribeTheme = onThemeChange(guardedThemeRepaint("channels-panel", draw, () => disposed || isRenderableGone(box)));
  draw();
  void refresh();

  return {
    refresh,
    update(next) {
      snapshot = next;
      draw();
    },
    row: currentRow,
    activate,
    dispose() {
      disposed = true;
      stop();
      unsubscribeTheme();
    },
  };
}
