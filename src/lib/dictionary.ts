import { scheduleSettingsPush } from './settingsSync';

/**
 * The user's custom spelling dictionary — proper nouns and worldbuilding words
 * the checker should never flag ("Kaelen", "aetherium", …).
 *
 * Stored as a JSON string array under `chronicle_dictionary` in localStorage
 * and mirrored to /api/settings (see settingsSync.ts), so it survives updates
 * and follows the user across devices. Matching is case-insensitive.
 *
 * Consumed by src/lib/Grammar.ts (misspelling hits for dictionary words are
 * dropped everywhere), but EDITED only from the Proofread view's dictionary
 * drawer — that's a product decision, not a technical constraint.
 */

const KEY = 'chronicle_dictionary';

function load(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((w) => typeof w === 'string') : [];
  } catch {
    return [];
  }
}

function save(words: string[]): void {
  localStorage.setItem(KEY, JSON.stringify(words));
  scheduleSettingsPush();
}

/** Lowercased membership set for fast filtering in the grammar pass. */
export function getDictionary(): Set<string> {
  return new Set(load().map((w) => w.toLowerCase()));
}

/** Words in their original casing, sorted, for the management UI. */
export function listWords(): string[] {
  return load().sort((a, b) => a.localeCompare(b));
}

export function addWord(word: string): void {
  const w = word.trim();
  if (!w) return;
  const words = load();
  if (words.some((x) => x.toLowerCase() === w.toLowerCase())) return;
  words.push(w);
  save(words);
}

export function removeWord(word: string): void {
  const lower = word.toLowerCase();
  save(load().filter((x) => x.toLowerCase() !== lower));
}
