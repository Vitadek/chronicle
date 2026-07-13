import React from 'react';
import { usePluginHost, usePluginSlot } from './PluginHost';
import { PluginBoundary } from './PluginBoundary';

/**
 * Renders every enabled plugin's `companion` overlay (Chibi's slot).
 *
 * Each is wrapped in its own PluginBoundary: one companion throwing during
 * render takes down only itself, not the editor — v1 had no boundary anywhere,
 * so a plugin render error white-screened the whole app.
 */
export const CompanionHost: React.FC = () => {
  const companions = usePluginSlot('companion');
  const { makeContext, reportError } = usePluginHost();

  return (
    <>
      {companions.map(({ pluginId, item: Companion }) => (
        <PluginBoundary key={pluginId} pluginId={pluginId} onError={reportError}>
          <Companion {...makeContext(pluginId)} />
        </PluginBoundary>
      ))}
    </>
  );
};
