// The `/routing` modal: every category's routing decision + a flat model picker.
//
// List: every category (`ROUTING_CATEGORIES`) previewed through the routing
// resolver against the session baseline, with the layer that assigned it.
// Enter opens the picker: ONE searchable/filterable list spanning every
// connected provider's models (`mountFilterList`, `./filter-list.ts`), plus
// one "provider default" row per connected provider and one "session default"
// row. A confirmed pick writes immediately to the user layer's canonical
// routing settings (`settings.ts`), not on modal close.
//
//  - The SAME connected-provider list fetched once for the flat picker
//    (`reload()`, below — not a second live probe) also feeds the preview.
//  - Unapproved project settings are ignored (`readRoutingSettings`) with a
//    visible notice; `t` on the list tab arms an approve action that shows the
//    project layer BEFORE recording anything (`y` confirms, any other key
//    cancels) — the same discipline `keryx routing trust` uses on the CLI.
import { normalizeRoutingConfig, routingDigest, type NormalizedRoutingConfig, type RoutingAssignment, type RoutingConfigLayer } from "../harness/routing/config";
import {
  approveProjectRouting,
  readRoutingSettings,
  ROUTING_NORMALIZATION,
  setRoutingCategory,
  type RoutingLocation,
  type RoutingScope,
} from "../harness/routing/settings";
import type { RoutingDecisionReceipt } from "../harness/routing/routing-runtime";
import type { RoutingJournalLocation } from "../harness/routing/routing-journal";
import { resolveRoutingForRuntime } from "../harness/routing/routing-runtime";
import { buildCatalogRoutingSnapshot, type RoutingSnapshotPolicy } from "../harness/routing/snapshot-adapter";
import { resolveProviderDefaultModelId } from "../harness/routing/provider-default";
import {
  connectedPredicateFrom,
  flatModelOptions,
  ROUTING_CATEGORIES,
  type CategoryAssignment,
  type FlatModelOption,
  type FlatPickerProvider,
  type RoutingCategory,
} from "../harness/routing/table";
import { describeLayerForApproval, describeRoutingAssignment } from "../harness/routing/trust";
import {
  formatNumericField,
  isModelDerivable,
  loadModelProfiles,
  profileKey,
  type ModelProfile,
} from "../harness/routing/model-profile";
import type { DetectedProvider } from "../commands/select";
import type { ProviderCatalogDeps } from "../harness/provider-catalog";
import { mountFilterList, type KeypressEvent } from "./filter-list";
import { modalBodyRows, openModal, resolveModalPanelSize, type ModalHandle } from "./modal-host";
import { onThemeChange } from "./theme";
import { guardedThemeRepaint, isRenderableGone } from "./theme-repaint";
import { dimChunk, roleChunk } from "./theme-text";
import { hasCredential } from "../harness/provider/single-turn";
import { envWithSavedApiKeys } from "../lib/shell-config";
import { resolveExternalSetting } from "../lib/external-switch";
import { externalAllowedConnectedPredicate, loadExternalProvidersConfig } from "../lib/external-providers";

type OpenTui = typeof import("@opentui/core");

export const ROUTING_COMMAND = "/routing";

export const ROUTING_FOOTER = [
  { key: "↑/↓", label: "move" },
  { key: "enter", label: "pick model" },
  { key: "t", label: "trust project file" },
  { key: "esc", label: "close" },
] as const;

export interface RoutingPreviewRow {
  readonly category: RoutingCategory;
  readonly receipt: RoutingDecisionReceipt;
}

export function formatRoutingPreviewLines(rows: readonly RoutingPreviewRow[], selected: number): string[] {
  return rows.map((row, index) => {
    const mark = index === selected ? ">" : " ";
    const decision = row.receipt.decision;
    const outcome = decision.status === "selected"
      ? `${decision.selection.providerId}/${decision.selection.modelId}`
      : decision.status === "blocked" ? `blocked: ${decision.reason}`
      : decision.status;
    return `${mark} ${row.category.padEnd(12)} ${outcome}  [${decision.assignmentSource}]`;
  });
}

export function previewCatalogRoutingCategories(options: {
  readonly config: NormalizedRoutingConfig;
  readonly providers: readonly FlatPickerProvider[];
  readonly profiles: Readonly<Record<string, ModelProfile>>;
  readonly baseline: { readonly providerId: string; readonly modelId: string };
  readonly policy: RoutingSnapshotPolicy;
  readonly observedAt: string;
  readonly policyRevision: string;
  readonly capabilityRevision: string;
  readonly journal?: RoutingJournalLocation;
}): RoutingPreviewRow[] {
  return ROUTING_CATEGORIES.map((category) => {
    const request = {
      requestId: `routing-inspector:${category}`,
      category,
      origin: "operator" as const,
      baseline: options.baseline,
      requirements: { capabilities: [] as const, inputTokensRequired: 0, outputTokensReserved: 0 },
    };
    const snapshot = buildCatalogRoutingSnapshot({
      configDigest: options.config.configDigest,
      observedAt: options.observedAt,
      policyRevision: options.policyRevision,
      capabilityRevision: options.capabilityRevision,
      baseline: options.baseline,
      providers: options.providers,
      profiles: options.profiles,
      request,
      policy: options.policy,
    });
    return { category, receipt: resolveRoutingForRuntime({
      request,
      snapshot,
      config: options.config,
      ...(options.journal === undefined ? {} : { journal: { ...options.journal, kind: "preview" as const } }),
    }) };
  });
}

/** Every category's assignment and source, for when there is no session baseline to resolve against. */
export function formatRoutingAssignmentLines(config: NormalizedRoutingConfig, selected: number): string[] {
  return ROUTING_CATEGORIES.map((category, index) => {
    const mark = index === selected ? ">" : " ";
    return `${mark} ${category.padEnd(12)} ${describeRoutingAssignment(config.categories[category])}  [${config.categorySources[category]}]`;
  });
}

/** The session's own model is always reachable, even when the provider list omits it (flow 468). */
function withSessionModel(providers: readonly FlatPickerProvider[], session: { readonly providerId: string; readonly modelId: string }): readonly FlatPickerProvider[] {
  const own = providers.find((provider) => provider.name === session.providerId);
  if (own === undefined) return [...providers, { name: session.providerId, models: [session.modelId] }];
  if (own.models?.includes(session.modelId) === true) return providers;
  return providers.map((provider) => provider === own ? { ...provider, models: [...(provider.models ?? []), session.modelId] } : provider);
}

/** A picker row as a routing assignment; a provider default resolves to that provider's documented model. */
export function pickerAssignment(assignment: CategoryAssignment): RoutingAssignment | { readonly error: string } {
  if (assignment.kind === "session-default") return { mode: "baseline" };
  if (assignment.kind === "model") return { mode: "model", target: { providerId: assignment.providerId, modelId: assignment.modelId } };
  const modelId = resolveProviderDefaultModelId(assignment.providerId);
  return modelId === undefined
    ? { error: `${assignment.providerId} has no documented default model; pick a model instead` }
    : { mode: "model", target: { providerId: assignment.providerId, modelId } };
}

/** Longer than the catalog's own per-provider fetch bound (8s), so a slow-but-answering catalog still lands. */
export const ROUTING_PROVIDERS_TIMEOUT_MS = 12_000;

export interface RoutingModalOptions {
  /** Project root — the "project" layer. */
  cwd: string;
  /** Per-user config dir override (test seam only) — the "user" layer. Default: the real global config dir. */
  userConfigDir?: string;
  onKeypress: (handler: (key: KeypressEvent) => void) => () => void;
  /** Connected providers for the flat picker AND AC10's resolution check. Defaults to the live provider catalog (flow 309, `../harness/provider-catalog.ts`), read ONCE per `reload()` — never a second probe for resolution alone. */
  providers?: () => Promise<readonly FlatPickerProvider[]>;
  /** Live provider detection (`tui-shell.ts`'s `opts.redetect`, the path `/model` uses) the default loader falls back to when the catalog cache is empty (flow 468). Ignored when `providers` is given. */
  redetect?: () => Promise<readonly DetectedProvider[]>;
  /** Catalog dependencies (config dir, fetch, env) for the default loader. Test seam only; production uses the real ones. Ignored when `providers` is given. */
  catalog?: Partial<Pick<ProviderCatalogDeps, "dir" | "fetch" | "env">>;
  /** How long `reload()` waits for the provider loader before showing the model list as unavailable (flow 468). Default {@link ROUTING_PROVIDERS_TIMEOUT_MS}; a test seam. */
  timeoutMs?: number;
  /**
   * The session's own current provider/model — the baseline every preview
   * resolves against. `undefined` (no live selection) shows each category's
   * assignment and source without resolving it.
   */
  session?: { providerId: string; modelId: string };
  /** Model-profile catalogue loader (flow 327) — defaults to the real per-user store (`../harness/routing/model-profile.ts`). Test seam. */
  loadProfiles?: (userConfigDir: string | undefined) => Record<string, ModelProfile>;
  /** Category write (test seam). Default: the canonical routing settings store. */
  write?: (scope: RoutingScope, location: RoutingLocation, category: RoutingCategory, assignment: RoutingAssignment) => Promise<void>;
  renderer?: { width?: number; height?: number };
  visibleRows?: number;
  /** True while a composer choice or permission prompt owns the keyboard (review pattern, flow 300). */
  inputBlocked?: () => boolean;
}

export interface RoutingModalHandle extends ModalHandle {
  readonly ready: Promise<void>;
  reload(): Promise<void>;
  status(): string;
  visibleLines(): readonly string[];
  selectedCategory(): RoutingCategory | undefined;
  /** The flat picker's current options (populated once the "picker" tab has loaded providers). Tests only. */
  pickerOptions(): readonly FlatModelOption[];
  /** AC11 — whether the project layer is currently unapproved/changed. Tests only. */
  projectUntrusted(): boolean;
  /** Settles once the in-flight write/arm/approve/reload (if any) has finished. Tests only. */
  settled(): Promise<void>;
}

export function openRouting(otui: unknown, chrome: unknown, options: RoutingModalOptions): RoutingModalHandle | undefined {
  const core = otui as OpenTui;
  const r = (chrome as { renderer?: unknown } | undefined)?.renderer;
  const write = options.write ?? setRoutingCategory;
  const location: RoutingLocation = {
    cwd: options.cwd,
    ...(options.userConfigDir !== undefined ? { configDir: options.userConfigDir } : {}),
  };
  const loadProviders = options.providers ?? (() => loadRoutingProviders(options.redetect, options.catalog));
  const providersTimeoutMs = options.timeoutMs ?? ROUTING_PROVIDERS_TIMEOUT_MS;
  const loadProfiles = options.loadProfiles ?? ((dir) => loadModelProfiles(dir));
  const rendererHint = options.renderer ?? (chrome as { renderer?: { width?: number; height?: number } } | undefined)?.renderer;
  const panelRows =
    typeof rendererHint?.width === "number" && typeof rendererHint.height === "number"
      ? modalBodyRows(resolveModalPanelSize(rendererHint.width, rendererHint.height).height)
      : 13;
  const bodyRows = Math.max(1, options.visibleRows ?? panelRows);

  let config: NormalizedRoutingConfig | undefined;
  let previewRows: RoutingPreviewRow[] = [];
  let flatOptions: FlatModelOption[] = [];
  let providers: readonly FlatPickerProvider[] = [];
  /** Why the provider list could not be read (loader rejected or timed out) — shown on the Model tab. */
  let providersError: string | undefined;
  /** Why the routing settings could not be read; keeps the list tab off "Reading routing settings…" forever. */
  let loadError: string | undefined;
  let profiles: Record<string, ModelProfile> = {};
  let projectIsUntrusted = false;
  let selected = 0;
  let statusText = "enter to pick a model for the selected category";
  let closed = false;
  let currentTab: string = "list";
  /** Armed by `t`, confirmed by `y`, cancelled by any other key. */
  let armedApproval: RoutingConfigLayer | undefined;
  /** Every async action (write/arm/approve/reload) assigns here — `settled()` (tests) awaits exactly the work a keypress started. */
  let inFlight: Promise<void> = Promise.resolve();
  let statusNode: { content: unknown } | undefined;
  let bodyNode: { content: unknown } | undefined;
  const host: { handle?: ModalHandle } = {};
  const keys: { off?: () => void } = {};

  const selectedCategory = (): RoutingCategory | undefined => (config === undefined ? undefined : ROUTING_CATEGORIES[selected]);

  const listLines = (): string[] => {
    if (config === undefined) return [loadError === undefined ? "Reading routing settings…" : `routing settings unavailable: ${loadError}`];
    return options.session === undefined ? formatRoutingAssignmentLines(config, selected) : formatRoutingPreviewLines(previewRows, selected);
  };

  const paintList = (): void => {
    // Guarded on `currentTab`: once the operator switches to "picker",
    // modal-host tears the list nodes down and `reload()` (called from
    // `writePick`) or a theme change must not paint into them.
    if (closed || currentTab !== "list") return;
    if (statusNode !== undefined) {
      statusNode.content = core.t`${roleChunk(core, armedApproval !== undefined ? "attention" : "muted", statusText)}`;
    }
    if (bodyNode !== undefined) {
      bodyNode.content = core.t`${dimChunk(core, listLines().join("\n"))}`;
    }
  };

  /** The provider loader, bounded and never rejecting: a failure or timeout becomes an empty list plus the reason (flow 468). */
  const loadProvidersBounded = async (): Promise<{ readonly list: readonly FlatPickerProvider[]; readonly error?: string }> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${Math.round(providersTimeoutMs / 1000)}s`)), providersTimeoutMs);
    });
    try {
      return { list: await Promise.race([Promise.resolve().then(() => loadProviders()), timeout]) };
    } catch (error) {
      return { list: [], error: error instanceof Error ? error.message : String(error) };
    } finally {
      clearTimeout(timer);
    }
  };

  const reload = async (): Promise<void> => {
    try {
      await reloadUnguarded();
    } catch (error) {
      // Never reject and never leave "Reading routing settings…": the reason is the visible state.
      config = undefined;
      loadError = error instanceof Error ? error.message : String(error);
      statusText = `routing: ${loadError}`;
      paintList();
    }
  };

  const reloadUnguarded = async (): Promise<void> => {
    const settings = readRoutingSettings(location);
    const loaded = await loadProvidersBounded();
    loadError = undefined;
    config = normalizeRoutingConfig(settings.layers, ROUTING_NORMALIZATION);
    providers = loaded.list;
    providersError = loaded.error;
    profiles = loadProfiles(options.userConfigDir);
    projectIsUntrusted = !settings.project.trusted;
    for (const notice of settings.notices) statusText = `routing: ${notice}`;
    if (options.session !== undefined) {
      const session = options.session;
      const connected = connectedPredicateFrom(providers, session);
      const external = await resolveExternalSetting({ cwd: location.cwd, ...(options.userConfigDir === undefined ? {} : { dir: options.userConfigDir }) });
      const externalProviders = loadExternalProvidersConfig(options.userConfigDir).config;
      const allowed = externalAllowedConnectedPredicate(connected, external.value === "on", externalProviders);
      const env = envWithSavedApiKeys(process.env, options.userConfigDir);
      previewRows = previewCatalogRoutingCategories({
        config,
        providers: withSessionModel(providers, session),
        profiles,
        baseline: session,
        observedAt: new Date().toISOString(),
        policyRevision: routingDigest({ external: external.value, externalProviders }),
        capabilityRevision: routingDigest({ baseline: session, capabilities: "unproven", catalogCapabilities: "unproven" }),
        journal: { cwd: location.cwd, ...(options.userConfigDir === undefined ? {} : { configDir: options.userConfigDir }) },
        policy: {
          credentialsAvailable: (target) => target.providerId === session.providerId || hasCredential(target.providerId, env),
          policyAllowed: (target) => allowed(target.providerId, target.modelId),
          parentAllowed: () => true,
          capabilities: () => [],
          cooldown: () => false,
          observedLatencyMs: () => null,
          availability: (target) => target.providerId === session.providerId && target.modelId === session.modelId ? "available" : undefined,
        },
      });
    } else {
      previewRows = [];
    }
    selected = Math.min(selected, ROUTING_CATEGORIES.length - 1);
    paintList();
  };

  const writePick = async (category: RoutingCategory, picked: CategoryAssignment): Promise<void> => {
    const assignment = pickerAssignment(picked);
    if ("error" in assignment) {
      statusText = `routing: ${assignment.error}`;
    } else {
      try {
        await write("user", location, category, assignment);
        statusText = `${category} -> ${describeRoutingAssignment(assignment)}  [user]`;
      } catch (error) {
        statusText = `routing: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    await reload();
    host.handle?.setTab("list");
  };

  /** `t`: show the project layer and arm the approval. */
  const armApproval = async (): Promise<void> => {
    let layer: RoutingConfigLayer | undefined;
    try {
      layer = readRoutingSettings(location).project.layer;
    } catch (error) {
      statusText = `routing: ${error instanceof Error ? error.message : String(error)}`;
      paintList();
      return;
    }
    const lines = layer === undefined ? [] : describeLayerForApproval(layer);
    if (layer === undefined || lines.length === 0) {
      statusText = "routing.config.json declares no routing settings — nothing to approve.";
      paintList();
      return;
    }
    armedApproval = layer;
    statusText = `Approve routing.config.json?\n  ${lines.join("\n  ")}\ny confirms · any other key cancels`;
    paintList();
  };

  const confirmApproval = async (): Promise<void> => {
    const layer = armedApproval;
    armedApproval = undefined;
    if (layer === undefined) return;
    try {
      const current = readRoutingSettings(location).project.layer;
      if (current === undefined || routingDigest(current) !== routingDigest(layer)) {
        statusText = "routing.config.json changed since it was shown; nothing was approved — press t again";
      } else {
        const result = approveProjectRouting(location);
        statusText = result.ok ? `Approved (${result.file}).` : `routing: ${result.error}`;
      }
    } catch (error) {
      statusText = `routing: ${error instanceof Error ? error.message : String(error)}`;
    }
    await reload();
  };

  let unsubscribeTheme: () => void = () => {};
  const handle = openModal(core, chrome as never, {
    title: ROUTING_COMMAND,
    tabs: [
      { id: "list", label: "Categories" },
      { id: "picker", label: "Model" },
    ],
    footer: ROUTING_FOOTER,
    renderTab: (tabId, body) => {
      currentTab = tabId;
      const parent = body as { add(child: unknown): void };
      if (tabId === "list") {
        statusNode = new core.TextRenderable(r as never, { id: "rt-status", content: "" }) as never;
        bodyNode = new core.TextRenderable(r as never, { id: "rt-body", content: "", marginTop: 1 }) as never;
        parent.add(statusNode);
        parent.add(bodyNode);
        paintList();
        return options.onKeypress((key) => {
          if (closed || options.inputBlocked?.() === true) return;
          const token = key.name || key.sequence;
          if (armedApproval !== undefined) {
            if (token === "y") {
              inFlight = confirmApproval();
            } else {
              armedApproval = undefined;
              statusText = "approval cancelled";
              paintList();
            }
            return;
          }
          if (token === "up" || token === "k") {
            selected = Math.max(0, selected - 1);
            paintList();
          } else if (token === "down" || token === "j") {
            selected = Math.min(ROUTING_CATEGORIES.length - 1, selected + 1);
            paintList();
          } else if (token === "return" || token === "enter") {
            if (selectedCategory() !== undefined) host.handle?.setTab("picker");
          } else if (token === "t") {
            inFlight = armApproval();
          }
        });
      }
      // "picker" tab — the flat model list, built from the SAME provider
      // list `reload()` already fetched (no extra live probe).
      const category = selectedCategory();
      statusNode = new core.TextRenderable(r as never, {
        id: "rt-picker-status",
        content: core.t`${roleChunk(core, "muted", category === undefined ? "no category selected" : `picking a model for ${category}`)}`,
      }) as never;
      parent.add(statusNode as never);
      flatOptions = flatModelOptions(providers, options.session);
      const notes = modelTabNotes(providers, providersError);
      if (notes.length > 0) {
        parent.add(
          new core.TextRenderable(r as never, {
            id: "rt-picker-notes",
            content: core.t`${roleChunk(core, "attention", notes.join("\n"))}`,
          }) as never,
        );
      }
      const list = mountFilterList(core, r as never, parent as never, {
        idPrefix: "rt",
        items: flatOptions,
        // Each "model" row also shows its profile (tier, price, context,
        // priority, sources, availability) from the catalogue `reload()` loaded.
        toOption: (opt) => ({ name: opt.label, description: describePickerRowProfile(opt, profiles) }),
        matches: (opt, q) => opt.search.includes(q),
        emptyLabel: "(no connected providers)",
        idleHint: "type to filter · ↑/↓ Enter to pick · Esc back",
        filterHint: (filter, shown, total) => `filter: ${filter}  (${shown}/${total})`,
        showDescription: true,
        width: "100%",
        height: Math.max(1, bodyRows - 1 - notes.length),
        onPick: (opt) => {
          const current = selectedCategory();
          if (opt === undefined || current === undefined) return;
          inFlight = writePick(current, opt.assignment);
        },
      });
      return options.onKeypress((key) => {
        if (closed || options.inputBlocked?.() === true) return;
        list.onKey(key);
      });
    },
    onClose: () => {
      closed = true;
      keys.off?.();
      unsubscribeTheme();
    },
  });
  if (handle === undefined) return undefined;
  host.handle = handle;
  unsubscribeTheme = onThemeChange(
    guardedThemeRepaint("routing-modal", paintList, () => closed || isRenderableGone(bodyNode) || (r as { isDestroyed?: boolean } | undefined)?.isDestroyed === true),
  );

  const ready = reload();
  return {
    ...handle,
    ready,
    reload,
    status: () => statusText,
    visibleLines: () => windowLines(listLines(), bodyRows),
    selectedCategory,
    pickerOptions: () => flatOptions,
    projectUntrusted: () => projectIsUntrusted,
    settled: () => inFlight,
  };
}

/**
 * Flow 468 — the Model tab's status rows: why the list is short or empty, one
 * line per cause, instead of a bare "session default". Empty when every
 * provider is healthy.
 */
export function modelTabNotes(providers: readonly FlatPickerProvider[], providersError: string | undefined): string[] {
  const notes: string[] = [];
  if (providersError !== undefined) {
    notes.push(`model list unavailable (${providersError})`);
  } else if (providers.length === 0) {
    notes.push("no providers connected — add one with /connect");
  }
  for (const provider of providers) {
    if (provider.authFailed === true) notes.push(`${provider.name}: auth failed — /connect to re-enter the key`);
    else if (provider.listUnavailable !== undefined) notes.push(`${provider.name}: model list unavailable (${provider.listUnavailable})`);
    else if ((provider.models ?? []).length === 0) notes.push(`${provider.name}: 0 models`);
  }
  return notes;
}

function windowLines(lines: readonly string[], rows: number): readonly string[] {
  return lines.slice(0, Math.max(1, rows));
}

/**
 * Flow 327 (AC12) — the flat picker row's description: its model profile
 * (tier, price, context, priority, each field's source) and, when
 * `available: false`, an explicit "unavailable" marker (still selectable —
 * PRD §6.4). Empty for a non-"model" row (session default / provider
 * default), which carries no profile.
 */
export function describePickerRowProfile(opt: FlatModelOption, profiles: Readonly<Record<string, ModelProfile>>): string {
  if (opt.assignment.kind !== "model") return "";
  const profile = profiles[profileKey(opt.assignment.providerId, opt.assignment.modelId)];
  if (profile === undefined) return "";
  const parts = [
    `${profile.strengthTier.value} (${profile.strengthTier.source})`,
    `in ${formatNumericField(profile.priceInputPerMillion, "/M")}`,
    `out ${formatNumericField(profile.priceOutputPerMillion, "/M")}`,
    `ctx ${profile.contextLength.value === "unknown" ? "unknown" : `${profile.contextLength.value} (${profile.contextLength.source})`}`,
    `priority ${profile.priority.value}`,
  ];
  if (!profile.available) parts.push("UNAVAILABLE");
  if (!isModelDerivable(profile)) parts.push("non-chat/free — never auto-derived");
  return parts.join("  ·  ");
}

/**
 * Live connected-provider list for the flat picker (flow 309) — the SAME
 * on-disk catalog `keryx shell`'s startup refresh and `keryx providers
 * status` read/write, not a fresh probe on every `/routing` open. A fresh
 * cache answers immediately; a stale/missing one triggers exactly one
 * refresh (AC3). Root cause this replaces: `detectProviders()`'s result
 * handed straight to the picker — curated model ids, and every OpenAI-compat
 * provider offered whether or not it had a credential.
 */
export async function loadRoutingProviders(
  redetect?: () => Promise<readonly DetectedProvider[]>,
  overrides: Partial<Pick<ProviderCatalogDeps, "dir" | "fetch" | "env">> = {},
): Promise<readonly FlatPickerProvider[]> {
  const { loadOrRefreshProviderCatalog, loadOrRefreshProviderCatalogLive, catalogToFlatPickerProviders } = await import("../harness/provider-catalog");
  const { envWithSavedApiKeys } = await import("../lib/shell-config");
  const deps = { fetch, env: envWithSavedApiKeys(undefined, overrides.dir), ...overrides };
  // Flow 468: an empty or stale cache falls back to the live detection `/model` uses when the shell hands it over; a non-empty fresh cache is still served as is.
  const catalog = redetect !== undefined ? await loadOrRefreshProviderCatalogLive({ ...deps, redetect }) : await loadOrRefreshProviderCatalog(deps);
  return catalogToFlatPickerProviders(catalog, { withStatusRows: true });
}
