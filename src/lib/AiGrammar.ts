// Decoration layer for the on-demand AI grammar pass. Unlike TenseShift/Grammar
// (which lint live on a debounce), this holds a snapshot of marks set
// imperatively after the user runs an AI pass — purple wavy underlines distinct
// from the live red/blue grammar squiggles. The fetch + position-mapping lives
// in the UI (IssuesPane); this just renders whatever spans it's handed.

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

export interface AiMark {
  from: number;
  to: number;
  message: string;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    aiGrammar: {
      setAiMarks: (marks: AiMark[]) => ReturnType;
      clearAiMarks: () => ReturnType;
    };
  }
}

const aiGrammarKey = new PluginKey<DecorationSet>('aiGrammar');

export const AiGrammar = Extension.create({
  name: 'aiGrammar',

  addCommands() {
    return {
      setAiMarks:
        (marks: AiMark[]) =>
        ({ state, dispatch }) => {
          if (!dispatch) return true;
          const decos = marks
            .filter((m) => m.to > m.from)
            .map((m) => Decoration.inline(m.from, m.to, { class: 'ai-grammar', title: m.message }));
          dispatch(state.tr.setMeta(aiGrammarKey, DecorationSet.create(state.doc, decos)));
          return true;
        },
      clearAiMarks:
        () =>
        ({ state, dispatch }) => {
          if (dispatch) dispatch(state.tr.setMeta(aiGrammarKey, DecorationSet.empty));
          return true;
        },
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: aiGrammarKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, old) {
            const meta = tr.getMeta(aiGrammarKey) as DecorationSet | undefined;
            if (meta) return meta;
            return old.map(tr.mapping, tr.doc);
          },
        },
        props: {
          decorations(state) {
            return aiGrammarKey.getState(state);
          },
        },
      }),
    ];
  },
});
