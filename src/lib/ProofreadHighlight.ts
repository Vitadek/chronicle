// Decoration layer for Proofread mode's "current issue" emphasis. A single
// highlighted span set imperatively as the user walks the queue — distinct
// from the passive squiggles (which mark every issue) and independent of the
// native selection, so we never have to focus the editor to show it (focusing
// would pop the keyboard on mobile).

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    proofreadHighlight: {
      /** Highlight the span being addressed; replaces any previous one. */
      setProofreadHighlight: (from: number, to: number) => ReturnType;
      clearProofreadHighlight: () => ReturnType;
    };
  }
}

const key = new PluginKey<DecorationSet>('proofreadHighlight');

export const ProofreadHighlight = Extension.create({
  name: 'proofreadHighlight',

  addCommands() {
    return {
      setProofreadHighlight:
        (from: number, to: number) =>
        ({ state, dispatch }) => {
          if (!dispatch) return true;
          const deco = to > from
            ? [Decoration.inline(from, to, { class: 'proofread-current' })]
            : [];
          dispatch(state.tr.setMeta(key, DecorationSet.create(state.doc, deco)));
          return true;
        },
      clearProofreadHighlight:
        () =>
        ({ state, dispatch }) => {
          if (dispatch) dispatch(state.tr.setMeta(key, DecorationSet.empty));
          return true;
        },
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, old) {
            const meta = tr.getMeta(key) as DecorationSet | undefined;
            if (meta) return meta;
            return old.map(tr.mapping, tr.doc);
          },
        },
        props: {
          decorations(state) {
            return key.getState(state);
          },
        },
      }),
    ];
  },
});
