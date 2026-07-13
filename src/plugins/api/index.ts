/**
 * @chronicle/plugin-api — the contract every Chronicle plugin implements.
 *
 * A plugin is a git repo the server clones and compiles (esbuild → CJS with the
 * app's own react / @tiptap / motion left external). At runtime the host
 * evaluates it with a `require` shim wired to those singletons, so a plugin
 * shares ONE React instance with the app.
 *
 * TRUST MODEL: plugins run with full power inside the app's JS context — this
 * is the Obsidian/VS Code model, trust-on-install, not a sandbox. Install only
 * repos you trust. (See PLUGINS.md.)
 *
 * A plugin declares what it CONTRIBUTES; the host renders/registers it. Every
 * feature — including the ones core will eventually hand over (proofreader,
 * outliner, checkers, thesaurus…) — is a first-class citizen using these same
 * slots.
 */
import type React from 'react';
import type { Editor } from '@tiptap/react';
import type { AnyExtension, Extension, Node, Mark } from '@tiptap/core';

/** Bumped when the host makes a breaking change to this contract. */
export const PLUGIN_API_VERSION = 3;

// ---------------------------------------------------------------------------
// Dependencies — declared in chronicle-plugin.json, enforced by the server
// (server/lib/pluginResolve.ts). Mirrored here so plugin authors get types.
// ---------------------------------------------------------------------------

/**
 * Host services a plugin can depend on. Detected live, not read from config:
 * `host:languagetool` means the sidecar ANSWERED, because LANGUAGETOOL_URL has
 * a default and is therefore always "set".
 */
export type HostCapability = 'host:languagetool' | 'host:ai' | 'host:gemini';

/** Built-in features a plugin can supersede via `replaces`. */
export type CoreCapability =
  | 'core:grammar'
  | 'core:tense'
  | 'core:autocorrect'
  | 'core:outliner'
  | 'core:proofreader'
  | 'core:thesaurus'
  | 'core:issues';

/**
 * The dependency half of chronicle-plugin.json.
 *
 *   "provides":  ["checker", "checker:grammar"],
 *   "requires":  ["host:languagetool"],   // hard — refuses to enable without it
 *   "wants":     ["host:ai"],             // soft — enables, flagged "limited"
 *   "conflicts": ["checker:grammar"],     // no second grammar checker
 *   "replaces":  ["core:grammar"],        // shadow the built-in while enabled
 *   "dependencies": { "leven": "^4.0.0" } // npm, installed at build time
 *
 * A plugin implicitly provides its own id, so `requires: ["chronicle.grammarcheck"]`
 * — depending on a *named* plugin — needs no extra syntax.
 */
export interface PluginManifestDeps {
  provides?: string[];
  requires?: (HostCapability | string)[];
  wants?: (HostCapability | string)[];
  conflicts?: string[];
  replaces?: CoreCapability[];
  dependencies?: Record<string, string>;
}

/** Why a plugin can't be enabled, or is running degraded. Computed server-side. */
export interface PluginStatus {
  /** Unmet hard requirements. Non-empty ⇒ cannot be enabled. */
  missing: string[];
  /** Unmet soft requirements. Runs, but limited. */
  unmetWants: string[];
  conflictsWith: { capability: string; pluginId: string }[];
}

// ---------------------------------------------------------------------------
// Context handed to a plugin at activation and to every contribution
// ---------------------------------------------------------------------------

/** Persisted plugin state. Global by default, or scoped to one manuscript. */
export interface PluginStateApi<S = Record<string, unknown>> {
  get(): S;
  /** Merge-free replace; persisted to the server (debounced by the host). */
  set(next: S): void;
  /** Per-manuscript variant — keyed by the open manuscript, not global. */
  getForManuscript(): S;
  setForManuscript(next: S): void;
}

/**
 * The findings bus: how a checker plugin hands results to a panel plugin
 * without the two importing each other. The grammar/tense plugins publish;
 * the issues panel subscribes.
 */
export interface FindingsBus {
  /** Replace this source's findings (empty array clears them). */
  publish: (source: string, findings: PluginFinding[]) => void;
  /** Called whenever any source publishes. Returns an unsubscribe fn. */
  subscribe: (listener: (all: Record<string, PluginFinding[]>) => void) => () => void;
  /** Current findings from every source, keyed by source id. */
  snapshot: () => Record<string, PluginFinding[]>;
}

/** Host services a plugin may use instead of reimplementing them. */
export interface PluginServices {
  /** Shared checker results (see FindingsBus). */
  findings: FindingsBus;
  editor: {
    /**
     * Ready-made TipTap options for a plugin that needs its OWN editor — with
     * the app's core extensions already merged in. **Use this.** You cannot get
     * the schema wrong with it:
     *
     *   const editor = useEditor(ctx.services.editor.createEditorOptions({
     *     content: chapter.content,
     *     extensions: [MyChecker],       // yours are appended to the core set
     *     onUpdate: (html) => save(html),
     *   }));
     *
     * Why it matters: chapter content is HTML, and TipTap parses it against the
     * schema your extensions define, SILENTLY DROPPING anything it has no parse
     * rule for. Build an editor from bare StarterKit and loading a chapter
     * quietly deletes every inline comment (`span[data-comment]`), every audio
     * marker (`span[data-audio-token]`), and every epigraph's `data-type` — then
     * your first save writes that back over the author's work. No error is
     * raised. See scripts/schemaRoundTrip.test.ts, which proves both halves.
     */
    createEditorOptions: (opts: {
      content?: string;
      placeholder?: string;
      /** Your extensions — appended AFTER the core set. */
      extensions?: AnyExtension[];
      onUpdate?: (html: string) => void;
      /** Merged into editorProps.attributes (e.g. class, spellcheck). */
      attributes?: Record<string, string>;
    }) => Record<string, unknown>;

    /**
     * The raw core extension set, if you need to compose it yourself.
     * Prefer `createEditorOptions` — it is the same guarantee with no way to
     * forget it.
     */
    coreExtensions: (opts?: { placeholder?: string }) => AnyExtension[];
  };
  /** LanguageTool proxy: lint text, returns offsets into the text passed in. */
  grammar: {
    lint(text: string): Promise<{ start: number; end: number; kind: string; message: string; replacements?: string[] }[]>;
  };
  /** Server-mediated AI. Absent when AI is disabled or AI_UI=off — always null-check. */
  ai: {
    available: boolean;
    /** Free-form prompt → text. Throws with the server's message on failure. */
    respond(prompt: string, system?: string): Promise<string>;
  };
  /** The user's synced settings store (survives updates + follows devices). */
  settings: {
    get(key: string): string | null;
    set(key: string, value: string): void;
  };
  /** Transient message to the user. */
  toast(message: string, kind?: 'info' | 'error'): void;
}

export interface PluginContext<S = Record<string, unknown>> {
  /** The open manuscript, or null in views that aren't editing one (e.g. Library). */
  manuscriptId: string | null;
  /** The live TipTap editor, when one is mounted. Null in the library/full-page views. */
  editor: Editor | null;
  state: PluginStateApi<S>;
  services: PluginServices;
}

// ---------------------------------------------------------------------------
// Contribution slots — each exists to unblock a specific kind of feature
// ---------------------------------------------------------------------------

/** Icon: any component taking a className (lucide-react icons qualify). */
export type PluginIcon = React.ComponentType<{ className?: string }>;

/**
 * TipTap extensions merged into every editor the app builds.
 * Unblocks: autocorrect, grammar check, tense check.
 */
export type EditorExtensionsSlot = (ctx: PluginContext) => AnyExtension[];

/**
 * A tab in the manuscript sidebar.
 * Unblocks: issues panel, the outliner pane (plot/characters/outline).
 */
export interface SidebarTabContribution {
  id: string;
  label: string;
  icon: PluginIcon;
  render: (ctx: PluginContext) => React.ReactNode;
}

/**
 * A full-page view the app can switch to (replacing the editor shell).
 * Unblocks: the proofreader.
 */
export interface ViewContribution {
  id: string;
  title: string;
  render: (ctx: PluginContext & { close: () => void }) => React.ReactNode;
}

/**
 * An icon button on each Library book card.
 * Unblocks: "open this book in the proofreader".
 */
export interface LibraryActionContribution {
  id: string;
  icon: PluginIcon;
  tooltip: string;
  /** Typically opens one of this plugin's `views` for that manuscript. */
  run: (manuscriptId: string, openView: (viewId: string, manuscriptId: string) => void) => void;
}

/**
 * An action on the selection bubble menu.
 * Unblocks: the thesaurus.
 */
export interface SelectionActionContribution {
  id: string;
  label: string;
  icon?: PluginIcon;
  run: (ctx: PluginContext, selectedText: string) => void;
}

/**
 * A `#!/name` editor command. Replaces v1's `portalCommands` — and unlike v1's
 * stub, `services`/`editor` here are live at invoke time.
 */
export interface SlashCommandContribution {
  name: string;
  description?: string;
  run: (ctx: PluginContext, args: string[]) => void | Promise<void>;
}

/**
 * A checker that publishes findings to the host's results bus, so any panel
 * (e.g. a future issues plugin) can consume them without knowing the producer.
 */
export interface CheckerContribution {
  id: string;
  label: string;
  /** Called with the current chapter text; returns findings as char offsets. */
  run: (text: string, ctx: PluginContext) => Promise<PluginFinding[]> | PluginFinding[];
}

export interface PluginFinding {
  start: number;
  end: number;
  /** Free-form category, e.g. 'misspelling' | 'tense' | 'clarity'. */
  kind: string;
  message: string;
  /** Optional one-click fixes. Rendering hosts may ignore these. */
  replacements?: string[];
}

// ---------------------------------------------------------------------------
// The plugin itself
// ---------------------------------------------------------------------------

export interface PluginContributions {
  editorExtensions?: EditorExtensionsSlot;
  sidebarTabs?: SidebarTabContribution[];
  views?: ViewContribution[];
  libraryActions?: LibraryActionContribution[];
  selectionActions?: SelectionActionContribution[];
  slashCommands?: SlashCommandContribution[];
  checkers?: CheckerContribution[];
  /** A free-floating overlay rendered over the editor (e.g. a companion). */
  companion?: React.ComponentType<PluginContext>;
  /** The plugin's own section inside Global Settings. */
  settingsPanel?: React.ComponentType<PluginContext>;
}

export interface ChroniclePlugin<S = Record<string, unknown>> {
  /** Must equal PLUGIN_API_VERSION; the host refuses anything else. */
  apiVersion: number;
  /** Stable unique id, e.g. "chronicle.chibi". Also the on-disk directory. */
  id: string;
  name: string;
  description: string;
  /** Seed state on first enable. */
  defaultState?: S;
  contributes?: PluginContributions;
  /** Called when the plugin is enabled/loaded. Throwing here disables it safely. */
  activate?: (ctx: PluginContext<S>) => void | Promise<void>;
  /** Called when disabled/unloaded — detach listeners here. */
  deactivate?: () => void;
}

/** Identity helper giving plugin authors full type inference. */
export function definePlugin<S = Record<string, unknown>>(plugin: ChroniclePlugin<S>): ChroniclePlugin<S> {
  return plugin;
}
