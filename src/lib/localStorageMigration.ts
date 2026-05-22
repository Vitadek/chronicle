/**
 * One-shot localStorage key migration: scribe_* → chronicle_*.
 *
 * Runs once per browser (gated by a sentinel key). The product was
 * previously named "Scribe", and all prefs / sync cursors / AI configs
 * sit under that prefix in users' browsers. After this migration, only
 * the chronicle_* keys exist; the scribe_* originals are removed.
 *
 * Safe to call from main.tsx before React mounts so any component that
 * reads localStorage during render sees the migrated values.
 */

const SENTINEL = 'chronicle_migrated_v1';

export function migrateLocalStorageKeys(): void {
  if (typeof localStorage === 'undefined') return;
  if (localStorage.getItem(SENTINEL) === '1') return;

  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('scribe_')) keys.push(k);
    }
    for (const oldKey of keys) {
      const newKey = 'chronicle_' + oldKey.slice('scribe_'.length);
      // Don't clobber a chronicle_* value that already exists (e.g. if the
      // user used a fresh browser then re-imported old keys somehow).
      if (localStorage.getItem(newKey) === null) {
        const value = localStorage.getItem(oldKey);
        if (value !== null) localStorage.setItem(newKey, value);
      }
      localStorage.removeItem(oldKey);
    }
    localStorage.setItem(SENTINEL, '1');
  } catch {
    // localStorage can throw in private mode; skip migration silently.
  }
}
