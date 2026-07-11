import { Extension, InputRule } from '@tiptap/core';

/**
 * AutoCorrect — light, native-feeling text fixes applied while typing:
 *
 *   1. Word replacements: `im ` → `I'm `, `dont ` → `don't `, `teh ` → `the `, …
 *      Fired only when a word-boundary character (space / punctuation) is typed
 *      after the word, so a completed word is corrected but mid-typing is not
 *      (`im ` corrects; `image` does not).
 *   2. Sentence-start capitalization: the first lowercase letter of a sentence
 *      (block start, after `.!?…`, or after an opening quote/paren) is upcased.
 *
 * Both are implemented as ProseMirror input rules — the same mechanism
 * `@tiptap/extension-typography` uses for smart quotes / em dashes — which means
 * each correction is reversible with a single Backspace immediately after it
 * fires, with no extra keymap wiring (see plan: "unless I backspace on it").
 *
 * The default word list is deliberately CONSERVATIVE: only words whose lowercase
 * form is not itself a valid English word are included, so genuine prose is never
 * silently rewritten (e.g. `ill`, `id`, `were`, `well` are intentionally absent).
 *
 * Registered once in lib/editorExtensions.ts → buildCoreExtensions, so every
 * editor surface (web, collab, mobile bundle) gets it. Toggleable at runtime via
 * the `setAutoCorrect` command, mirroring Grammar/TenseShift's `enabled` pattern.
 */

export interface AutoCorrectOptions {
  enabled: boolean;
  capitalizeSentences: boolean;
  /** lowercase (canonical) wrong form → corrected form. Matched case-insensitively. */
  replacements: Record<string, string>;
  /** lowercase tokens after which a following letter is NOT treated as a sentence start. */
  abbreviations: string[];
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    autocorrect: {
      /** Enable/disable autocorrect at runtime without rebuilding the editor. */
      setAutoCorrect: (enabled: boolean) => ReturnType;
    };
  }
}

const DEFAULT_REPLACEMENTS: Record<string, string> = {
  // "I" and its unambiguous contractions
  i: 'I',
  im: "I'm",
  ive: "I've",
  "i'm": "I'm",
  "i've": "I've",
  "i'll": "I'll",
  "i'd": "I'd",
  // contractions whose apostrophe-less form is not a common word
  dont: "don't",
  cant: "can't",
  wont: "won't",
  didnt: "didn't",
  doesnt: "doesn't",
  isnt: "isn't",
  wasnt: "wasn't",
  werent: "weren't",
  wouldnt: "wouldn't",
  couldnt: "couldn't",
  shouldnt: "shouldn't",
  havent: "haven't",
  hasnt: "hasn't",
  hadnt: "hadn't",
  arent: "aren't",
  youre: "you're",
  theyre: "they're",
  thats: "that's",
  theres: "there's",
  weve: "we've",
  youve: "you've",
  // common typos
  teh: 'the',
  adn: 'and',
  recieve: 'receive',
};

const DEFAULT_ABBREVIATIONS = [
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc',
  'e.g', 'i.e', 'a.m', 'p.m',
];

// Apostrophe class matches both straight (') and curly (’) — Typography rewrites
// straight apostrophes to curly ones as you type, so word forms may contain either.
const APOSTROPHE = "['’]";

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Characters that legitimately precede a word (so we don't match inside a larger
// word, e.g. "im" inside "swim") and characters that terminate one (the trigger).
const WORD_LEAD = '(^|[\\s"\'“‘(\\[])';
const WORD_TRIGGER = '([\\s.,!?;:)\\]"\'“”‘’])$';

export const AutoCorrect = Extension.create<AutoCorrectOptions>({
  name: 'autocorrect',

  addOptions() {
    return {
      enabled: true,
      capitalizeSentences: true,
      replacements: DEFAULT_REPLACEMENTS,
      abbreviations: DEFAULT_ABBREVIATIONS,
    };
  },

  addStorage() {
    return {
      enabled: this.options.enabled,
    };
  },

  addCommands() {
    return {
      setAutoCorrect:
        (enabled: boolean) =>
        ({ state, dispatch }) => {
          this.storage.enabled = enabled;
          if (dispatch) dispatch(state.tr);
          return true;
        },
    };
  },

  addInputRules() {
    const ext = this;
    const rules: InputRule[] = [];

    // 1. Word replacements — one rule per entry.
    for (const [wrong, right] of Object.entries(ext.options.replacements)) {
      const wrongPattern = escapeRegExp(wrong).replace(/'/g, APOSTROPHE);
      const find = new RegExp(`${WORD_LEAD}(${wrongPattern})${WORD_TRIGGER}`, 'i');
      rules.push(
        new InputRule({
          find,
          handler: ({ state, range, match }) => {
            if (!ext.storage.enabled) return null;
            const lead = match[1] ?? '';
            const word = match[2] ?? '';
            const trigger = match[3] ?? '';
            // Already correct — let the default insertion happen untouched.
            if (word === right) return null;
            // range = [start of lead, insertion point]; the trigger char is not
            // yet in the doc, so we re-insert it after the corrected word.
            state.tr.insertText(lead + right + trigger, range.from, range.to);
            return undefined;
          },
        }),
      );
    }

    // 2. Sentence-start capitalization — a single lowercase letter that opens a
    // sentence. Boundary alternatives: block start | sentence punctuation + space
    // | opening quote/paren (dialogue). Only group 1 (boundary) and group 2
    // (letter) capture; the alternation internals are non-capturing.
    if (ext.options.capitalizeSentences) {
      const capFind =
        /(^|(?:[.!?…]["'”’)\]]?\s+)|(?:["“]\s?))([a-z])$/;
      rules.push(
        new InputRule({
          find: capFind,
          handler: ({ state, range, match }) => {
            if (!ext.storage.enabled) return null;
            const boundary = match[1] ?? '';
            const letter = match[2] ?? '';
            const upper = letter.toUpperCase();
            if (upper === letter) return null;

            // Abbreviation guard: skip if the sentence "boundary" is really the
            // period of a known abbreviation (Dr., e.g., …), so we don't capitalize
            // mid-sentence.
            if (/[.!?…]/.test(boundary)) {
              const before = state.doc.textBetween(
                Math.max(0, range.from - 15),
                range.from,
                undefined,
                '',
              );
              const wb = before
                .match(/([A-Za-z.]+)$/)?.[1]
                ?.replace(/\.+$/, '')
                .toLowerCase();
              if (wb && ext.options.abbreviations.includes(wb)) return null;
            }

            // The letter isn't in the doc yet; replace the in-doc boundary with
            // boundary + uppercased letter.
            state.tr.insertText(boundary + upper, range.from, range.to);
            return undefined;
          },
        }),
      );
    }

    return rules;
  },
});
