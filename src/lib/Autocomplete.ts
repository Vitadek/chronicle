import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

export interface AutocompleteOptions {
  enabled: boolean;
  dictionary: string[];
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    autocomplete: {
      /**
       * Complete the word
       */
      completeWord: () => ReturnType;
    };
  }
}

export const Autocomplete = Extension.create<AutocompleteOptions>({
  name: 'autocomplete',

  addOptions() {
    return {
      enabled: true,
      dictionary: [
        'the', 'quick', 'brown', 'fox', 'jumps', 'over', 'lazy', 'dog',
        'manuscript', 'chapter', 'silence', 'whisper', 'forest', 'ancient',
        'history', 'yesterday', 'tomorrow', 'sequence', 'consequence',
        'beautiful', 'dangerous', 'mysterious', 'forgotten', 'twilight',
        'shadow', 'starlight', 'midnight', 'horizon', 'journey', 'adventure',
        'echo', 'rhythm', 'melody', 'harmony', 'symphony', 'threshold',
        'luminescent', 'ethereal', 'ephemeral', 'eternal', 'infinite',
        'protagonist', 'antagonist', 'metaphor', 'allegory', 'paradox'
      ],
    };
  },

  addStorage() {
    return {
      enabled: true,
      suggestion: '',
    };
  },

  addCommands() {
    return {
      completeWord: () => ({ state, dispatch }) => {
        const { selection } = state;
        const { $from } = selection;
        const suggestion = this.storage.suggestion;

        if (!suggestion || !dispatch) {
          return false;
        }

        const from = $from.pos;
        dispatch(state.tr.insertText(suggestion, from));
        this.storage.suggestion = '';
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
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('autocomplete'),
        props: {
          decorations: (state) => {
            const { editor } = this;
            if (!this.storage.enabled || !editor.isEditable) {
              this.storage.suggestion = '';
              return DecorationSet.empty;
            }

            const { selection } = state;
            if (!selection.empty) {
              this.storage.suggestion = '';
              return DecorationSet.empty;
            }

            const { $from } = selection;

            // Only suggest at the END of a word. If the caret sits inside a
            // word (clicked or arrowed into "for|est"), the next character is
            // a word character \u2014 suggesting there is noise, not help.
            const nextChar = $from.parent.textBetween(
              $from.parentOffset,
              Math.min($from.parentOffset + 1, $from.parent.content.size),
              undefined,
              '\ufffc'
            );
            if (/^\w/.test(nextChar)) {
              this.storage.suggestion = '';
              return DecorationSet.empty;
            }

            // Get the current line text
            const textBefore = $from.parent.textBetween(
              0,
              $from.parentOffset,
              undefined,
              '\ufffc'
            );

            // Match the last word being typed
            const match = textBefore.match(/(\w+)$/);
            if (!match) {
              this.storage.suggestion = '';
              return DecorationSet.empty;
            }

            const wordPart = match[1].toLowerCase();
            if (wordPart.length < 2) {
              this.storage.suggestion = '';
              return DecorationSet.empty;
            }

            // Simple dictionary match
            const fullDictionary = this.options.dictionary;

            const suggestion = fullDictionary.find(
              (word) => word.toLowerCase().startsWith(wordPart) && word.toLowerCase() !== wordPart
            );

            if (!suggestion) {
              this.storage.suggestion = '';
              return DecorationSet.empty;
            }

            const suffix = suggestion.slice(wordPart.length);
            this.storage.suggestion = suffix;

            const span = document.createElement('span');
            span.className = 'autocomplete-suggestion';
            span.textContent = suffix;
            
            // Explicitly set styles to ensure visibility against theme
            span.style.opacity = '0.4';
            span.style.fontStyle = 'italic';
            span.style.pointerEvents = 'none';
            span.style.userSelect = 'none';
            span.style.color = 'currentColor';

            return DecorationSet.create(state.doc, [
              Decoration.widget($from.pos, span, { side: 1 }),
            ]);
          },
        },
      }),
    ];
  },
});
