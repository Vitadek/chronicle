import React from 'react';
import * as ReactJsxRuntime from 'react/jsx-runtime';
import * as ReactDOM from 'react-dom';
import * as TiptapCore from '@tiptap/core';
import * as TiptapReact from '@tiptap/react';
import * as TiptapReactMenus from '@tiptap/react/menus';
import * as TiptapState from '@tiptap/pm/state';
import * as TiptapViewNs from '@tiptap/pm/view';
import * as TiptapModel from '@tiptap/pm/model';
import * as Motion from 'motion/react';
// Keep the plugin host's deliberately-complete icon namespace out of the
// library entry graph. The query gives Rollup a distinct optional module;
// core UI imports from `lucide-react` remain normally tree-shaken.
// @ts-ignore -- Vite resolves query-suffixed ESM modules at build time.
import * as Lucide from 'lucide-react/dist/esm/lucide-react.js?plugin-host';
import * as PluginApi from '../api';
import { PLUGIN_API_VERSION, type ChroniclePlugin } from '../api';
import { authFetch } from '../../services/authService';

/**
 * Loads a compiled plugin module into the running app.
 *
 * The server builds each plugin with esbuild as **CommonJS**, leaving react,
 * @tiptap/*, motion and the plugin API **external**. We evaluate that code with
 * a `require` shim bound to the app's OWN module instances — so a plugin shares
 * exactly one React and one TipTap with the host (two Reacts would crash hooks
 * instantly). This is the Obsidian/VS Code approach; it needs no import maps and
 * no enumeration of named exports.
 *
 * `new Function` means a plugin runs with full privileges. That is the accepted
 * trust model (trust-on-install, see PLUGINS.md) — the protection is that
 * installing requires an authenticated, deliberate git URL you chose.
 */

/** The modules a plugin may `import` (esbuild marks these external). */
const HOST_MODULES: Record<string, unknown> = {
  react: React,
  // esbuild's automatic JSX transform emits require("react/jsx-runtime") in
  // every file with JSX — without this, no plugin that renders can load.
  'react/jsx-runtime': ReactJsxRuntime,
  'react/jsx-dev-runtime': ReactJsxRuntime,
  'react-dom': ReactDOM,
  '@tiptap/core': TiptapCore,
  '@tiptap/react': TiptapReact,
  '@tiptap/react/menus': TiptapReactMenus,
  '@tiptap/pm/state': TiptapState,
  '@tiptap/pm/view': TiptapViewNs,
  '@tiptap/pm/model': TiptapModel,
  'motion/react': Motion,
  'lucide-react': Lucide,
  '@chronicle/plugin-api': PluginApi,
};

function hostRequire(specifier: string): unknown {
  const mod = HOST_MODULES[specifier];
  if (!mod) {
    throw new Error(
      `Plugin required "${specifier}", which the host does not provide. ` +
      `Available: ${Object.keys(HOST_MODULES).join(', ')}. ` +
      `Bundle any other dependency into your plugin instead of importing it.`,
    );
  }
  return mod;
}

/** The app version plugins declare compatibility against (manifest.minAppVersion). */
export const APP_VERSION: string =
  ((import.meta as unknown as { env?: Record<string, string> }).env?.VITE_APP_VERSION) || '0.1.0';

/** Semver-ish "is `version` >= `min`" over dot-separated numbers. */
export function satisfiesMinVersion(version: string, min: string | undefined): boolean {
  if (!min) return true;
  const a = version.split('.').map((n) => parseInt(n, 10) || 0);
  const b = min.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return true;
}

/**
 * Fetch + evaluate one plugin's compiled bundle. Only ever called for ENABLED
 * plugins (v1 eagerly imported every installed plugin, enabled or not).
 */
export async function loadPluginModule(pluginId: string): Promise<ChroniclePlugin> {
  const res = await authFetch(`/api/plugins/${encodeURIComponent(pluginId)}/module.js`);
  if (!res.ok) {
    throw new Error(`Could not fetch plugin bundle (HTTP ${res.status}). Try re-installing it.`);
  }
  const code = await res.text();

  const module: { exports: Record<string, unknown> } = { exports: {} };
  try {
    // eslint-disable-next-line no-new-func
    const factory = new Function('module', 'exports', 'require', code);
    factory(module, module.exports, hostRequire);
  } catch (err) {
    throw new Error(`Plugin failed to evaluate: ${err instanceof Error ? err.message : String(err)}`);
  }

  const exported = (module.exports.default ?? module.exports) as ChroniclePlugin;
  if (!exported || typeof exported !== 'object' || !exported.id) {
    throw new Error('Plugin did not export a ChroniclePlugin (use `export default definePlugin({...})`).');
  }
  if (exported.apiVersion !== PLUGIN_API_VERSION) {
    throw new Error(
      `Plugin targets API v${exported.apiVersion}, this Chronicle provides v${PLUGIN_API_VERSION}. ` +
      `Update the plugin (or Chronicle).`,
    );
  }
  return exported;
}
