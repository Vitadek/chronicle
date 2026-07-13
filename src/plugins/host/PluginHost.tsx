import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { Editor } from '@tiptap/react';
import type {
  ChroniclePlugin,
  PluginContext,
  PluginContributions,
  PluginFinding,
  PluginServices,
} from '../api';
import { loadPluginModule } from './loader';
import { pluginService, type InstalledPlugin } from '../../services/pluginService';
import { lintText } from '../../lib/grammar/languagetool';
import { buildCoreExtensions, EDITOR_KEYBOARD_ATTRS } from '../../lib/editorExtensions';
import { getAiResponse } from '../../services/aiService';
import type { AiConfig } from '../../services/aiConfig';

/** A plugin that loaded successfully, with its live contributions. */
export interface LoadedPlugin {
  info: InstalledPlugin;
  plugin: ChroniclePlugin;
}

/** The app values plugins see. Published by App via usePublishPluginRuntime. */
export interface PluginRuntime {
  manuscriptId: string | null;
  editor: Editor | null;
  aiConfig: AiConfig | null;
  aiAvailable: boolean;
  onToast?: (message: string, kind?: 'info' | 'error') => void;
}

interface PluginHostValue {
  /** Everything installed on disk (enabled or not) — drives the Settings list. */
  installed: InstalledPlugin[];
  /** Only the enabled plugins whose module loaded and activated cleanly. */
  loaded: LoadedPlugin[];
  /** id → message for plugins that failed to load, activate, or render. */
  errors: Record<string, string>;
  isLoading: boolean;
  refresh: () => Promise<void>;
  setEnabled: (id: string, enabled: boolean) => Promise<void>;
  /** Report a runtime failure (used by PluginBoundary). */
  reportError: (id: string, message: string) => void;
  /** Build the context a contribution runs with. */
  makeContext: (pluginId: string) => PluginContext;
  /** App publishes its live editor/manuscript/AI values here. */
  publishRuntime: (runtime: PluginRuntime) => void;
  /** Full-page view routing (a plugin's `views` slot). */
  activeView: { pluginId: string; viewId: string; manuscriptId: string | null } | null;
  openView: (pluginId: string, viewId: string, manuscriptId: string | null) => void;
  closeView: () => void;
}

const HostContext = createContext<PluginHostValue | null>(null);

export const usePluginHost = (): PluginHostValue => {
  const ctx = useContext(HostContext);
  if (!ctx) throw new Error('usePluginHost must be used within PluginHost');
  return ctx;
};

/**
 * Collect one slot across every loaded plugin, tagged with its owner so hosts
 * can wrap each contribution in a PluginBoundary.
 *
 *   const tabs = usePluginSlot('sidebarTabs');  // → [{ pluginId, item }, …]
 */
export function usePluginSlot<K extends keyof PluginContributions>(
  slot: K,
): { pluginId: string; item: NonNullable<PluginContributions[K]> extends (infer U)[] ? U : NonNullable<PluginContributions[K]> }[] {
  const { loaded } = usePluginHost();
  return useMemo(() => {
    const out: { pluginId: string; item: any }[] = [];
    for (const { plugin } of loaded) {
      const contributed = plugin.contributes?.[slot];
      if (!contributed) continue;
      if (Array.isArray(contributed)) {
        for (const item of contributed) out.push({ pluginId: plugin.id, item });
      } else {
        out.push({ pluginId: plugin.id, item: contributed });
      }
    }
    return out;
  }, [loaded, slot]);
}

/**
 * Wraps the whole app ONCE (see App.tsx). It deliberately takes no live props:
 * the app publishes its editor/manuscript/AI values through
 * `usePublishPluginRuntime`. If the host took them as props it would have to sit
 * inside App's branch returns — remounting, and so re-fetching and re-activating
 * every plugin, on each navigation.
 */
export const PluginHost: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [installed, setInstalled] = useState<InstalledPlugin[]>([]);
  const [loaded, setLoaded] = useState<LoadedPlugin[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [activeView, setActiveView] = useState<PluginHostValue['activeView']>(null);

  // Live values the plugin context reads at call time — the context object is
  // handed to plugin code that may hold it across renders.
  const liveRef = useRef<PluginRuntime>({
    manuscriptId: null,
    editor: null,
    aiConfig: null,
    aiAvailable: false,
  });
  const publishRuntime = useCallback((runtime: PluginRuntime) => {
    liveRef.current = runtime;
  }, []);

  // Local mirror of plugin state so `state.get()` is synchronous for plugins.
  const stateRef = useRef<Record<string, unknown>>({});
  const manuscriptStateRef = useRef<Record<string, unknown>>({});

  const reportError = useCallback((id: string, message: string) => {
    setErrors((prev) => (prev[id] === message ? prev : { ...prev, [id]: message }));
  }, []);

  // The findings bus. Lives in refs (not state) so a checker publishing on
  // every keystroke doesn't re-render the whole app — subscribers (panels) opt
  // into re-rendering themselves.
  const findingsRef = useRef<Record<string, PluginFinding[]>>({});
  const findingsListeners = useRef(new Set<(all: Record<string, PluginFinding[]>) => void>());

  const services = useMemo<PluginServices>(() => ({
    findings: {
      publish: (source, list) => {
        findingsRef.current = { ...findingsRef.current, [source]: list };
        for (const fn of findingsListeners.current) {
          try {
            fn(findingsRef.current);
          } catch {
            /* a broken subscriber must not break the publisher */
          }
        }
      },
      subscribe: (listener) => {
        findingsListeners.current.add(listener);
        return () => findingsListeners.current.delete(listener);
      },
      snapshot: () => findingsRef.current,
    },
    editor: {
      // The safe path: core extensions are merged in for the plugin, so a
      // plugin editor cannot be built on the wrong schema (which would silently
      // eat comments/audio/epigraph attrs on save). See PluginServices.editor.
      createEditorOptions: ({ content, placeholder, extensions, onUpdate, attributes }) => ({
        extensions: [
          ...buildCoreExtensions({ placeholder: placeholder ?? '' }),
          ...(extensions ?? []),
        ],
        content: content ?? '',
        onUpdate: onUpdate
          ? ({ editor }: { editor: Editor }) => onUpdate(editor.getHTML())
          : undefined,
        editorProps: {
          attributes: {
            class: 'novel-editor-content focus:outline-none',
            ...EDITOR_KEYBOARD_ATTRS,
            ...(attributes ?? {}),
          },
        },
      }),
      coreExtensions: (opts) => buildCoreExtensions({ placeholder: opts?.placeholder ?? '' }),
    },
    grammar: {
      lint: (text: string) => lintText(text),
    },
    ai: {
      get available() {
        return liveRef.current.aiAvailable;
      },
      respond: async (prompt: string, system?: string) => {
        const cfg = liveRef.current.aiConfig;
        if (!liveRef.current.aiAvailable || !cfg) {
          throw new Error('AI is not available on this instance.');
        }
        const result = await getAiResponse(prompt, cfg, system);
        return typeof result === 'string' ? result : JSON.stringify(result);
      },
    },
    settings: {
      get: (key: string) => localStorage.getItem(`chronicle_plugin_${key}`),
      set: (key: string, value: string) => localStorage.setItem(`chronicle_plugin_${key}`, value),
    },
    toast: (message: string, kind?: 'info' | 'error') => {
      const fn = liveRef.current.onToast;
      if (fn) fn(message, kind);
      else console.log(`[plugin] ${message}`);
    },
  }), []);

  const makeContext = useCallback((pluginId: string): PluginContext => {
    const persist = (next: unknown, scope: string | null) => {
      void pluginService.setState(pluginId, next, scope).catch((e) => reportError(pluginId, String(e)));
    };
    return {
      get manuscriptId() {
        return liveRef.current.manuscriptId;
      },
      get editor() {
        return liveRef.current.editor;
      },
      state: {
        get: () => (stateRef.current[pluginId] ?? {}) as Record<string, unknown>,
        set: (next) => {
          stateRef.current[pluginId] = next;
          persist(next, null);
        },
        getForManuscript: () => {
          const m = liveRef.current.manuscriptId;
          return (manuscriptStateRef.current[`${pluginId}:${m}`] ?? {}) as Record<string, unknown>;
        },
        setForManuscript: (next) => {
          const m = liveRef.current.manuscriptId;
          manuscriptStateRef.current[`${pluginId}:${m}`] = next;
          persist(next, m);
        },
      },
      services,
    };
  }, [services, reportError]);

  /** Fetch the installed list, then load ONLY the enabled ones. */
  const refresh = useCallback(async () => {
    try {
      const list = await pluginService.list();
      setInstalled(list);

      // Seed the synchronous state mirror from the server records.
      for (const p of list) {
        try {
          stateRef.current[p.id] = p.state ? JSON.parse(p.state) : {};
        } catch {
          stateRef.current[p.id] = {};
        }
      }

      const enabled = list.filter((p) => p.enabled && !p.buildError);
      const results: LoadedPlugin[] = [];
      const nextErrors: Record<string, string> = {};

      // Lazy by design: a disabled plugin's bundle is never fetched (v1
      // eagerly imported every installed plugin regardless of its toggle).
      await Promise.all(
        enabled.map(async (info) => {
          try {
            const plugin = await loadPluginModule(info.id);
            // A throw in activate() disables the plugin instead of the app.
            await plugin.activate?.(makeContext(info.id));
            results.push({ info, plugin });
          } catch (err) {
            nextErrors[info.id] = err instanceof Error ? err.message : String(err);
          }
        }),
      );

      // Surface build failures from the server alongside load failures.
      for (const p of list) {
        if (p.buildError) nextErrors[p.id] = p.buildError;
      }

      setLoaded(results);
      setErrors(nextErrors);
    } catch (err) {
      console.error('Failed to load plugins:', err);
    } finally {
      setIsLoading(false);
    }
  }, [makeContext]);

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Give each plugin a chance to detach listeners when the host unmounts.
  useEffect(() => {
    return () => {
      for (const { plugin } of loaded) {
        try {
          plugin.deactivate?.();
        } catch {
          /* a failing teardown must not break unmount */
        }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setEnabled = useCallback(async (id: string, enabled: boolean) => {
    if (!enabled) {
      // Deactivate before dropping it, so listeners/timers are released.
      const entry = loaded.find((l) => l.plugin.id === id);
      try {
        entry?.plugin.deactivate?.();
      } catch {
        /* ignore */
      }
      // Close its view if it owned the one on screen.
      setActiveView((v) => (v?.pluginId === id ? null : v));
    }
    await pluginService.setEnabled(id, enabled);
    setErrors((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    await refresh();
  }, [loaded, refresh]);

  const openView = useCallback((pluginId: string, viewId: string, mId: string | null) => {
    setActiveView({ pluginId, viewId, manuscriptId: mId });
  }, []);
  const closeView = useCallback(() => setActiveView(null), []);

  const value = useMemo<PluginHostValue>(() => ({
    installed,
    loaded,
    errors,
    isLoading,
    refresh,
    setEnabled,
    reportError,
    makeContext,
    publishRuntime,
    activeView,
    openView,
    closeView,
  }), [installed, loaded, errors, isLoading, refresh, setEnabled, reportError, makeContext, publishRuntime, activeView, openView, closeView]);

  return <HostContext.Provider value={value}>{children}</HostContext.Provider>;
};

/**
 * Called once by App to keep the host's view of the world current. Runs on every
 * render (no dep array) because `editor` and `manuscriptId` change frequently
 * and plugin callbacks must never see a stale one.
 */
export function usePublishPluginRuntime(runtime: PluginRuntime): void {
  const { publishRuntime } = usePluginHost();
  useEffect(() => {
    publishRuntime(runtime);
  });
}
