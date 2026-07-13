import React from 'react';
import { usePluginHost, usePluginSlot } from './PluginHost';
import { PluginBoundary } from './PluginBoundary';

/**
 * Renders the plugin full-page view currently routed to (the `views` slot).
 * Returns null when none is open, so App can render it unconditionally.
 *
 * This is the slot a migrated Proofreader would occupy: LibraryView's card
 * action calls openView(pluginId, viewId, manuscriptId), and this takes over
 * the screen until the view calls close().
 */
export const PluginViewHost: React.FC = () => {
  const { activeView, closeView, makeContext, reportError } = usePluginHost();
  const views = usePluginSlot('views');

  if (!activeView) return null;

  const match = views.find(
    (v) => v.pluginId === activeView.pluginId && v.item.id === activeView.viewId,
  );
  if (!match) return null;

  // The view is opened FOR a manuscript (a library card action passes one),
  // which is not necessarily the manuscript currently open in the editor —
  // from the Library nothing is open at all. The routed id wins.
  const base = makeContext(activeView.pluginId);
  const ctx = {
    ...base,
    manuscriptId: activeView.manuscriptId ?? base.manuscriptId,
    close: closeView,
  };

  return (
    <PluginBoundary pluginId={activeView.pluginId} onError={reportError}>
      <div className="fixed inset-0 z-[120]">{match.item.render(ctx)}</div>
    </PluginBoundary>
  );
};
