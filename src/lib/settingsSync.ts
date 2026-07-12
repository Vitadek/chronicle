import { authFetch } from '../services/authService';

/**
 * Server-backed persistence for user preferences.
 *
 * localStorage stays the fast, synchronous store every component reads, but
 * browsers evict it (Safari after 7 idle days, "clear site data", a new
 * device/browser) — which read as "my settings reset after the update". This
 * module mirrors the preference keys to /api/settings per user:
 *
 *  - hydrateSettingsFromServer() runs in main.tsx BEFORE React renders, so
 *    every `useState(() => localStorage.getItem(...))` initializer naturally
 *    picks up the server copy. No per-setting plumbing.
 *  - scheduleSettingsPush() debounces a PUT of the current snapshot; App
 *    calls it whenever a preference state changes.
 *
 * Pushes are disabled until a hydrate has SUCCEEDED, so a fresh browser that
 * couldn't authenticate yet can never clobber the server copy with defaults.
 * Conflict policy is last-write-wins per load: server wins at boot, the
 * user's live edits win afterwards.
 */

/**
 * The preference keys that sync. Deliberately excluded:
 *  - chronicle_token / chronicle_oidc_* — auth material, never leaves the device
 *  - chronicle_ai_config_v* — may hold API keys; the UI promises those stay local
 *  - chronicle_ai_ui_hidden — cache of the server's own AI_UI flag
 *  - chronicle_chars_/plotnodes_/plotedges_/ai_outline_* — per-manuscript data,
 *    persisted through the manuscript store
 *  - chronicle_sync_since / chronicle_migrated_v* — machine-local cursors
 */
export const SYNCED_SETTINGS_KEYS = [
  'chronicle_theme',
  'chronicle_autocomplete',
  'chronicle_autocorrect',
  'chronicle_tense_check',
  'chronicle_grammar_check',
  'chronicle_issues_panel',
  'chronicle_thesaurus',
  'chronicle_zen_mode',
  'chronicle_first_line_indent',
  'chronicle_ai_enabled',
  'chronicle_ai_bubble_menu',
  'chronicle_touch_controls',
  'chronicle_manuscript_font',
  'chronicle_export_settings',
  'chronicle_import_help_hidden',
  'chronicle_user_profile',
] as const;

let hydrated = false;

/** Pull the server copy into localStorage. Call before the app renders. */
export async function hydrateSettingsFromServer(): Promise<void> {
  try {
    const res = await authFetch('/api/settings');
    if (!res.ok) return; // unauthenticated / older server: local values stand
    const data = await res.json();
    const settings = data?.settings;
    if (settings && typeof settings === 'object') {
      for (const key of SYNCED_SETTINGS_KEYS) {
        const v = (settings as Record<string, unknown>)[key];
        if (typeof v === 'string') localStorage.setItem(key, v);
      }
    }
    // A successful GET — even one with no stored settings yet — proves we're
    // authenticated and the endpoint exists, so pushing is now safe.
    hydrated = true;
  } catch {
    // Offline or server unreachable: keep local values, keep pushes disabled.
  }
}

function buildSnapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of SYNCED_SETTINGS_KEYS) {
    const v = localStorage.getItem(key);
    if (v !== null) out[key] = v;
  }
  return out;
}

let pushTimer: ReturnType<typeof setTimeout> | null = null;

/** Debounced push of the current preference snapshot to the server. */
export function scheduleSettingsPush(delayMs = 1500): void {
  if (!hydrated) return;
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    void authFetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: buildSnapshot() }),
    }).catch(() => {
      // Transient failure: the next change re-pushes; localStorage still holds
      // the truth for this device meanwhile.
    });
  }, delayMs);
}
