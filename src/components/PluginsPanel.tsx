import React, { useState } from 'react';
import {
  Box, Trash2, Loader2, GitBranch, RefreshCw, Pin, PinOff, AlertTriangle, Plus, HardDrive,
} from 'lucide-react';
import { cn } from '../lib/utils';
import { usePluginHost } from '../plugins/host/PluginHost';
import { PluginBoundary } from '../plugins/host/PluginBoundary';
import { pluginService, type InstalledPlugin, type PluginCommit } from '../services/pluginService';

/** `core:grammar` → "Grammar Check", for the "Replaces the built-in …" line. */
const CORE_FEATURE_NAMES: Record<string, string> = {
  'core:grammar': 'Grammar Check',
  'core:tense': 'Tense Check',
  'core:autocorrect': 'Autocorrect',
  'core:outliner': 'Outline pane',
  'core:proofreader': 'Proofread mode',
  'core:thesaurus': 'Thesaurus',
  'core:issues': 'Issues Panel',
};
const coreFeatureName = (cap: string) => CORE_FEATURE_NAMES[cap] ?? cap;

/**
 * A capability string, in plain English.
 *
 * `host:*` needs a real explanation — "needs host:languagetool" tells a user
 * nothing. Free tags (`checker`) are shown as-is, because they're the plugin
 * author's own vocabulary and we have nothing better to call them.
 */
const HOST_CAPABILITY_NAMES: Record<string, string> = {
  'host:languagetool': 'the LanguageTool sidecar',
  'host:ai': 'AI to be configured and enabled',
  'host:gemini': 'a Gemini API key',
};
const capabilityName = (cap: string) =>
  HOST_CAPABILITY_NAMES[cap] ?? (cap.startsWith('core:') ? `the built-in ${coreFeatureName(cap)}` : `a plugin providing "${cap}"`);

/**
 * The plugin manager (Global Settings → Plugins).
 *
 * Plugins are git repos: paste a URL, the server clones and compiles it. Updates
 * are explicit — check, read the incoming commit subjects, then update — and any
 * plugin can be pinned to a tag/commit so an upstream change never lands
 * mid-draft. Seeded plugins (shipped in the image) work offline and appear here
 * alongside the rest; there is only one class of plugin.
 *
 * Requirements (manifest `requires`/`wants`/`conflicts`/`replaces`) are resolved
 * SERVER-side; this renders that verdict and never re-derives it.
 */
export const PluginsPanel: React.FC<{ isDarkMode: boolean }> = ({ isDarkMode }) => {
  const { installed, loaded, errors, isLoading, refresh, setEnabled, makeContext, reportError } = usePluginHost();

  const [gitUrl, setGitUrl] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  /** "Installed — but it can't run yet, and here's why." Not an error: the
   *  install worked. Cleared on the next install attempt. */
  const [installNotice, setInstallNotice] = useState<{ name: string; reasons: string[]; blocking: boolean } | null>(null);
  const [updates, setUpdates] = useState<Record<string, PluginCommit[]>>({});

  const install = async () => {
    const url = gitUrl.trim();
    if (!url) return;
    setBusy('install');
    setInstallError(null);
    setInstallNotice(null);
    try {
      const result = await pluginService.install({ url });
      setGitUrl('');
      await refresh();
      // A plugin can clone, compile and install perfectly and STILL be unable
      // to run — the Proofreader needs the LanguageTool sidecar answering. Say
      // that here, at the moment of the action, instead of leaving the user to
      // deduce it from a toggle that quietly won't move.
      if (result.missingReasons.length > 0) {
        setInstallNotice({ name: result.plugin.name, reasons: result.missingReasons, blocking: true });
      } else if (result.unmetWantsReasons.length > 0) {
        setInstallNotice({ name: result.plugin.name, reasons: result.unmetWantsReasons, blocking: false });
      }
    } catch (err) {
      setInstallError(err instanceof Error ? err.message : 'Install failed');
    } finally {
      setBusy(null);
    }
  };

  const checkUpdates = async (id: string) => {
    setBusy(id);
    try {
      const { incoming } = await pluginService.checkUpdates(id);
      setUpdates((prev) => ({ ...prev, [id]: incoming }));
    } catch (err) {
      setInstallError(err instanceof Error ? err.message : 'Check failed');
    } finally {
      setBusy(null);
    }
  };

  const update = async (id: string) => {
    setBusy(id);
    try {
      await pluginService.update(id);
      setUpdates((prev) => ({ ...prev, [id]: [] }));
      await refresh();
    } catch (err) {
      setInstallError(err instanceof Error ? err.message : 'Update failed');
    } finally {
      setBusy(null);
    }
  };

  const pin = async (p: InstalledPlugin) => {
    setBusy(p.id);
    try {
      // Toggle: pin to the current commit, or release the pin.
      await pluginService.pin(p.id, p.pinnedRef ? null : (p.commit ?? null));
      await refresh();
    } catch (err) {
      setInstallError(err instanceof Error ? err.message : 'Pin failed');
    } finally {
      setBusy(null);
    }
  };

  const uninstall = async (p: InstalledPlugin) => {
    if (!window.confirm(`Remove "${p.name}"? Its files and settings will be deleted.`)) return;
    setBusy(p.id);
    try {
      await pluginService.uninstall(p.id);
      await refresh();
    } catch (err) {
      // Includes the dependency refusal ("Issues Panel depends on it").
      setInstallError(err instanceof Error ? err.message : 'Uninstall failed');
    } finally {
      setBusy(null);
    }
  };

  /**
   * Toggle a plugin. The server enforces the dependency rules and rejects with a
   * message naming exactly what's wrong — an unmet requirement, a conflict, or
   * another plugin that depends on this one — so surface it instead of letting
   * the rejection vanish.
   */
  const toggle = async (p: InstalledPlugin) => {
    setBusy(p.id);
    setInstallError(null);
    try {
      await setEnabled(p.id, !p.enabled);
    } catch (err) {
      setInstallError(err instanceof Error ? err.message : 'Failed to toggle plugin');
    } finally {
      setBusy(null);
    }
  };

  /** A plugin's display name, for messages that reference another plugin. */
  const nameOf = (id: string): string => installed.find((p) => p.id === id)?.name ?? id;

  /** What a loaded plugin actually contributes — shown so you know its reach. */
  const slotsFor = (id: string): string[] => {
    const entry = loaded.find((l) => l.plugin.id === id);
    if (!entry?.plugin.contributes) return [];
    return Object.entries(entry.plugin.contributes)
      .filter(([, v]) => v && (!Array.isArray(v) || v.length > 0))
      .map(([k]) => k);
  };

  return (
    <section className="space-y-6">
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.2em] font-bold opacity-40">
        <Box className="w-3 h-3" />
        <span>Plugins</span>
      </div>

      {/* Install from git */}
      <div className="rounded-2xl border border-black/5 dark:border-white/5 p-5 space-y-3">
        <p className="text-[10px] uppercase tracking-widest font-bold opacity-30">Install from git</p>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={gitUrl}
            onChange={(e) => setGitUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void install(); }}
            placeholder="https://github.com/user/chronicle-plugin.git"
            className={cn(
              'flex-1 px-3 py-2.5 rounded-xl text-xs bg-black/[0.03] dark:bg-white/[0.08] border border-black/5 dark:border-white/5 focus:border-black/10 dark:focus:border-white/20 outline-none transition-all',
              isDarkMode ? 'text-white' : 'text-black',
            )}
          />
          <button
            onClick={install}
            disabled={!gitUrl.trim() || busy === 'install'}
            className={cn(
              'flex items-center gap-1.5 px-3 py-2.5 rounded-xl text-[10px] uppercase font-black tracking-widest transition-all disabled:opacity-30',
              isDarkMode ? 'bg-white text-black' : 'bg-black text-white',
            )}
          >
            {busy === 'install' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
            Install
          </button>
        </div>
        <p className="text-[10px] leading-relaxed opacity-40 italic">
          Chronicle clones the repo and compiles it on the server — plugin authors need no build tooling.
          Plugins run with full access to the app, so only install repos you trust.
        </p>
        {installError && (
          <p className="px-3 py-2 bg-red-500/10 text-red-500 text-[10px] rounded-xl border border-red-500/20">
            {installError}
          </p>
        )}

        {/* Installed, but it can't run (or can't run fully) on this instance. */}
        {installNotice && (
          <div
            className={cn(
              'flex items-start gap-2 px-3 py-2.5 rounded-xl border',
              installNotice.blocking
                ? 'bg-amber-500/10 border-amber-500/20 text-amber-600 dark:text-amber-400'
                : 'bg-black/[0.04] dark:bg-white/[0.06] border-transparent opacity-70',
            )}
          >
            <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
            <div className="min-w-0 space-y-1">
              <p className="text-[10px] font-bold">
                {installNotice.name} installed —{' '}
                {installNotice.blocking
                  ? 'but it can’t be enabled on this instance yet.'
                  : 'with some features unavailable.'}
              </p>
              {installNotice.reasons.map((reason) => (
                <p key={reason} className="text-[10px] leading-relaxed">{reason}</p>
              ))}
            </div>
            <button
              onClick={() => setInstallNotice(null)}
              className="ml-auto shrink-0 text-[9px] uppercase font-black tracking-widest opacity-50 hover:opacity-100 transition-opacity"
            >
              Dismiss
            </button>
          </div>
        )}
      </div>

      {/* Installed */}
      <div className="space-y-3">
        {isLoading && (
          <p className="text-[10px] opacity-30 italic px-4 flex items-center gap-2">
            <Loader2 className="w-3 h-3 animate-spin" /> Loading plugins…
          </p>
        )}
        {!isLoading && installed.length === 0 && (
          <p className="text-[10px] opacity-30 italic px-4">No plugins installed.</p>
        )}

        {installed.map((p) => {
          const error = errors[p.id];
          const incoming = updates[p.id];
          const slots = slotsFor(p.id);
          const isBusy = busy === p.id;
          // The server's verdict — it refuses the enable itself, this just keeps
          // the UI from offering a button that's guaranteed to fail.
          const blocked = p.status.missing;
          const cannotEnable = blocked.length > 0 || p.status.conflictsWith.length > 0;

          return (
            <div
              key={p.id}
              className={cn(
                'px-4 py-4 rounded-2xl border transition-all group/item',
                error
                  ? 'bg-red-500/5 border-red-500/20'
                  : p.enabled
                    ? 'bg-blue-500/5 border-blue-500/10'
                    : 'bg-black/5 dark:bg-white/5 border-transparent opacity-70',
              )}
            >
              <div className="flex items-start gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h4 className={cn('text-xs font-bold', isDarkMode ? 'text-white' : 'text-black')}>{p.name}</h4>
                    <span className="text-[9px] font-mono opacity-30">v{p.version}</span>
                    <span className="flex items-center gap-1 text-[9px] uppercase font-bold tracking-widest opacity-30">
                      {p.source === 'git' ? <GitBranch className="w-2.5 h-2.5" /> : <HardDrive className="w-2.5 h-2.5" />}
                      {p.source}
                    </span>
                    {p.commit && <span className="text-[9px] font-mono opacity-30">{p.commit}</span>}
                    {p.pinnedRef && (
                      <span className="flex items-center gap-1 text-[9px] uppercase font-bold tracking-widest text-amber-500">
                        <Pin className="w-2.5 h-2.5" /> pinned
                      </span>
                    )}
                  </div>
                  <p className="text-[10px] leading-relaxed opacity-40 mt-1">{p.description}</p>

                  {slots.length > 0 && (
                    <p className="text-[9px] opacity-30 mt-1.5 font-mono">contributes: {slots.join(' · ')}</p>
                  )}

                  {p.replaces.length > 0 && (
                    <p className="text-[9px] opacity-40 mt-1.5">
                      Replaces the built-in {p.replaces.map(coreFeatureName).join(' and ')}
                      {p.enabled ? '' : ' when enabled'}.
                    </p>
                  )}

                  {/* Unmet HARD requirements: the plugin cannot run. The server
                      refuses to enable it, so say why rather than letting the
                      user click a button that 409s. */}
                  {blocked.length > 0 && (
                    <div className="flex items-start gap-1.5 mt-2 text-[10px] text-amber-500 leading-relaxed">
                      <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
                      <div className="space-y-0.5">
                        <p>Needs {blocked.map(capabilityName).join(', ')}.</p>
                        {/* HOW to satisfy it — which URL was probed, which env
                            var to set. The Enable button is (rightly) disabled
                            here, so this is the only place the user can learn
                            what to actually do about it. */}
                        {(p.missingReasons ?? []).map((reason) => (
                          <p key={reason} className="opacity-80">{reason}</p>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Unmet SOFT requirements: it runs, just not at full strength. */}
                  {p.status.unmetWants.length > 0 && blocked.length === 0 && (
                    <div className="text-[10px] opacity-40 mt-2 leading-relaxed space-y-0.5">
                      {/* "missing", not "no": the capability names read as noun
                          phrases ("a Gemini API key"), and "no a Gemini API key"
                          is what that sentence used to say. */}
                      <p>Limited — missing {p.status.unmetWants.map(capabilityName).join(' and ')}.</p>
                      {(p.unmetWantsReasons ?? []).map((reason) => (
                        <p key={reason}>{reason}</p>
                      ))}
                    </div>
                  )}

                  {p.status.conflictsWith.length > 0 && (
                    <p className="flex items-start gap-1.5 mt-2 text-[10px] text-amber-500 leading-relaxed">
                      <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
                      <span>
                        Conflicts with{' '}
                        {[...new Set(p.status.conflictsWith.map((c) => nameOf(c.pluginId)))].join(', ')} — they do
                        the same job. Disable one.
                      </span>
                    </p>
                  )}

                  {error && (
                    <p className="flex items-start gap-1.5 mt-2 text-[10px] text-red-500 leading-relaxed">
                      <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
                      {error}
                    </p>
                  )}

                  {incoming && incoming.length > 0 && (
                    <div className="mt-2 space-y-1 rounded-xl bg-black/[0.04] dark:bg-white/[0.05] p-2.5">
                      <p className="text-[9px] uppercase tracking-widest font-bold opacity-40">
                        {incoming.length} new commit{incoming.length === 1 ? '' : 's'}
                      </p>
                      {incoming.slice(0, 5).map((c) => (
                        <p key={c.oid} className="text-[10px] opacity-60 truncate">
                          <span className="font-mono opacity-50">{c.oid}</span> {c.message}
                        </p>
                      ))}
                      <button
                        onClick={() => update(p.id)}
                        disabled={isBusy}
                        className="mt-1 px-2.5 py-1 rounded-lg text-[9px] uppercase font-black tracking-widest bg-blue-500 text-white hover:bg-blue-600 transition-colors disabled:opacity-50"
                      >
                        Update
                      </button>
                    </div>
                  )}
                  {incoming && incoming.length === 0 && (
                    <p className="text-[10px] opacity-30 mt-2 italic">Up to date.</p>
                  )}

                  {/* The plugin's own settings (the `settingsPanel` slot) —
                      e.g. Grammar Check's custom dictionary. */}
                  {p.enabled && (() => {
                    const Panel = loaded.find((l) => l.plugin.id === p.id)?.plugin.contributes?.settingsPanel;
                    if (!Panel) return null;
                    return (
                      <div className="mt-3 pt-3 border-t border-black/5 dark:border-white/5">
                        <PluginBoundary pluginId={p.id} onError={reportError}>
                          <Panel {...makeContext(p.id)} />
                        </PluginBoundary>
                      </div>
                    );
                  })()}
                </div>

                <div className="flex flex-col items-end gap-2 shrink-0">
                  <button
                    onClick={() => toggle(p)}
                    // An already-enabled plugin must stay clickable even when
                    // blocked — otherwise a conflict or a dead LanguageTool would
                    // trap it in the "on" position with no way to turn it off.
                    disabled={isBusy || !!p.buildError || (!p.enabled && cannotEnable)}
                    title={!p.enabled && cannotEnable ? 'Requirements not met — see above' : undefined}
                    className={cn(
                      'px-3 py-1.5 rounded-lg text-[9px] uppercase font-black tracking-widest transition-all disabled:opacity-30',
                      p.enabled
                        ? 'bg-blue-500 text-white shadow-lg shadow-blue-500/20'
                        : 'bg-black/10 dark:bg-white/10 opacity-40 hover:opacity-100',
                    )}
                  >
                    {p.enabled ? 'Enabled' : 'Enable'}
                  </button>

                  <div className="flex items-center gap-0.5">
                    {p.source === 'git' && (
                      <>
                        <button
                          onClick={() => checkUpdates(p.id)}
                          disabled={isBusy || !!p.pinnedRef}
                          className="p-1.5 rounded opacity-30 hover:opacity-100 disabled:opacity-10 transition-all"
                          title={p.pinnedRef ? 'Pinned — unpin to check for updates' : 'Check for updates'}
                        >
                          {isBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                        </button>
                        <button
                          onClick={() => pin(p)}
                          disabled={isBusy}
                          className="p-1.5 rounded opacity-30 hover:opacity-100 transition-all"
                          title={p.pinnedRef ? `Unpin (currently ${p.pinnedRef})` : 'Pin to the current commit'}
                        >
                          {p.pinnedRef ? <PinOff className="w-3 h-3" /> : <Pin className="w-3 h-3" />}
                        </button>
                      </>
                    )}
                    <button
                      onClick={() => uninstall(p)}
                      disabled={isBusy}
                      className="p-1.5 rounded opacity-30 hover:opacity-100 hover:text-red-500 transition-all"
                      title="Uninstall"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
};
