// Ghost-text word completion ("shadow text"): as you type, the best
// completion for the current partial word renders as dimmed text after the
// caret. Tab accepts it, Escape dismisses it, typing anything else just
// ignores it. Touch UI keeps it disabled (no Tab, and the widget disturbs
// IME composition) — see useChronicleEditor.
//
// Candidates and ranking live in autocomplete/engine.ts: the document's own
// vocabulary and word pairs first, then a 25k-word frequency-ranked English
// list (lazy-loaded on first use so the main bundle doesn't carry it). No AI,
// no network, no debounce — the lookup is synchronous and cheap enough to run
// inside every transaction.

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { CompletionEngine } from './autocomplete/engine';

export interface AutocompleteOptions {
  enabled: boolean;
}

interface ActiveSuggestion {
  /** Caret position the ghost is anchored to. */
  pos: number;
  prefix: string;
  suffix: string;
  word: string;
  prevWord: string | null;
}

interface AutocompleteState {
  active: ActiveSuggestion | null;
  /** `${pos}:${prefix}` the user Escape-dismissed; muted until the prefix changes. */
  dismissed: string | null;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    autocomplete: {
      /** Accept the current ghost suggestion (Tab). */
      completeWord: () => ReturnType;
      /** Dismiss the current ghost suggestion (Escape). */
      dismissSuggestion: () => ReturnType;
    };
  }
}

const autocompleteKey = new PluginKey<AutocompleteState>('autocomplete');

// The word being typed (letters with in-word apostrophes), and the word
// before it, from the text preceding the caret.
const PREFIX_RE = /([A-Za-z]+(?:['’][A-Za-z]+)*)$/;
const PREV_WORD_RE = /([A-Za-z]+(?:['’][A-Za-z]+)*)[^A-Za-z'’]*$/;

const dismissKeyOf = (s: ActiveSuggestion) => `${s.pos}:${s.prefix.toLowerCase()}`;

/** Where the caret sits in a completable spot, compute the suggestion. */
function compute(state: EditorState, engine: CompletionEngine): ActiveSuggestion | null {
  const { selection } = state;
  if (!selection.empty) return null;
  const { $from } = selection;
  if (!$from.parent.isTextblock) return null;

  // Only suggest at the END of a word. If the caret sits inside a word
  // (clicked or arrowed into "for|est"), the next character is a word
  // character — suggesting there is noise, not help.
  const nextChar = $from.parent.textBetween(
    $from.parentOffset,
    Math.min($from.parentOffset + 1, $from.parent.content.size),
    undefined,
    '￼',
  );
  if (/^[\w'’]/.test(nextChar)) return null;

  const textBefore = $from.parent.textBetween(0, $from.parentOffset, undefined, '￼');
  const prefixMatch = textBefore.match(PREFIX_RE);
  if (!prefixMatch) return null;
  const prefix = prefixMatch[1];

  const prevMatch = textBefore.slice(0, -prefix.length).match(PREV_WORD_RE);
  const prevWord = prevMatch ? prevMatch[1] : null;

  const found = engine.suggest(prefix, prevWord);
  if (!found) return null;
  return { pos: $from.pos, prefix, suffix: found.suffix, word: found.word, prevWord };
}

export const Autocomplete = Extension.create<AutocompleteOptions>({
  name: 'autocomplete',

  addOptions() {
    return { enabled: true };
  },

  addStorage() {
    return {
      // Poked directly by useChronicleEditor (with an empty transaction to
      // refresh) — keep the shape stable.
      enabled: true,
      /** The suffix currently offered, '' when none. */
      suggestion: '',
      engine: new CompletionEngine(),
    };
  },

  addCommands() {
    return {
      completeWord:
        () =>
        ({ state, dispatch }) => {
          if (!this.storage.enabled) return false;
          const active = autocompleteKey.getState(state)?.active ?? null;
          if (!active || state.selection.from !== active.pos) return false;
          if (dispatch) {
            dispatch(state.tr.insertText(active.suffix, active.pos));
            // Credit the acceptance right away; the debounced rescan would
            // pick it up from the text anyway, this just closes the gap.
            (this.storage.engine as CompletionEngine).noteAccepted(active.prevWord, active.word);
          }
          return true;
        },
      dismissSuggestion:
        () =>
        ({ state, dispatch }) => {
          const active = autocompleteKey.getState(state)?.active ?? null;
          if (!active) return false;
          if (dispatch) dispatch(state.tr.setMeta(autocompleteKey, { dismiss: true }));
          return true;
        },
    };
  },

  addKeyboardShortcuts() {
    return {
      Tab: () => {
        if (!this.storage.enabled) return false;
        return this.editor.commands.completeWord();
      },
      Escape: () => {
        if (!this.storage.enabled) return false;
        return this.editor.commands.dismissSuggestion();
      },
    };
  },

  addProseMirrorPlugins() {
    const ext = this;
    const engine = ext.storage.engine as CompletionEngine;

    return [
      new Plugin<AutocompleteState>({
        key: autocompleteKey,
        state: {
          init: () => ({ active: null, dismissed: null }),
          apply(tr, prev, _old, newState): AutocompleteState {
            const meta = tr.getMeta(autocompleteKey) as { dismiss?: boolean } | undefined;
            if (meta?.dismiss && prev.active) {
              return { active: null, dismissed: dismissKeyOf(prev.active) };
            }
            if (!tr.docChanged && !tr.selectionSet && !meta) return prev;

            const active = compute(newState, engine);
            if (!active) return { active: null, dismissed: prev.dismissed };
            // Muted by Escape: stays hidden until the prefix (or spot) changes.
            if (prev.dismissed === dismissKeyOf(active)) {
              return { active: null, dismissed: prev.dismissed };
            }
            return { active, dismissed: null };
          },
        },

        view(view) {
          // The document tables rebuild on a debounce — a full rescan is
          // single-digit ms, so edits refresh the vocabulary within a second
          // without ever blocking a keystroke.
          let scanTimer: ReturnType<typeof setTimeout> | null = null;
          const scheduleScan = () => {
            if (scanTimer) clearTimeout(scanTimer);
            scanTimer = setTimeout(() => {
              scanTimer = null;
              if (view.isDestroyed) return;
              engine.scanDocument(docText(view.state));
            }, 700);
          };

          // The 25k-word dictionary loads once, on demand, as its own chunk.
          // Until it lands (or if it never does), document words still work.
          let dictRequested = false;
          const maybeLoadDictionary = () => {
            if (dictRequested || engine.dictionaryLoaded || !ext.storage.enabled) return;
            dictRequested = true;
            import('./autocomplete/wordlist')
              .then((m) => {
                engine.loadDictionary(m.WORDLIST);
                if (!view.isDestroyed) {
                  view.dispatch(view.state.tr.setMeta(autocompleteKey, { refresh: true }));
                }
              })
              .catch(() => {
                dictRequested = false; // network hiccup on a lazy chunk: retry on next enable
              });
          };

          engine.scanDocument(docText(view.state));
          maybeLoadDictionary();

          return {
            update(updatedView, prevState) {
              if (!prevState.doc.eq(updatedView.state.doc)) scheduleScan();
              maybeLoadDictionary();
            },
            destroy() {
              if (scanTimer) clearTimeout(scanTimer);
            },
          };
        },

        props: {
          decorations: (state) => {
            const pluginState = autocompleteKey.getState(state);
            const active = pluginState?.active ?? null;
            const visible = active && ext.storage.enabled && ext.editor.isEditable;
            // Mirror for the keyboard path & anything peeking at storage.
            ext.storage.suggestion = visible ? active.suffix : '';
            if (!visible) return DecorationSet.empty;

            return DecorationSet.create(state.doc, [
              Decoration.widget(
                active.pos,
                () => {
                  const span = document.createElement('span');
                  span.className = 'autocomplete-suggestion';
                  span.textContent = active.suffix;
                  return span;
                },
                { side: 1, key: `autocomplete:${active.pos}:${active.suffix}` },
              ),
            ]);
          },
        },
      }),
    ];
  },
});

/** Document plain text with block boundaries kept as separators. */
function docText(state: EditorState): string {
  return state.doc.textBetween(0, state.doc.content.size, '\n', '￼');
}
