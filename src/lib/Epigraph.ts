import { Node, mergeAttributes, textblockTypeInputRule } from '@tiptap/core';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    epigraph: {
      /**
       * Set an epigraph node
       */
      setEpigraph: () => ReturnType,
      /**
       * Toggle an epigraph node
       */
      toggleEpigraph: () => ReturnType,
    }
  }
}

export const Epigraph = Node.create({
  name: 'epigraph',
  group: 'block',
  content: 'inline*',
  
  parseHTML() {
    return [
      {
        // Priority above StarterKit's blockquote (default 50) so an epigraph
        // blockquote parses back to an epigraph node — keeping data-type — on
        // HTML reload / Y.Doc round-trip instead of degrading to a blockquote.
        tag: 'blockquote[data-type="epigraph"]',
        priority: 100,
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return ['blockquote', mergeAttributes(HTMLAttributes, { 'data-type': 'epigraph' }), 0];
  },

  addCommands() {
    return {
      setEpigraph:
        () =>
        ({ commands }) => {
          return commands.setNode(this.name);
        },
      toggleEpigraph:
        () =>
        ({ commands }) => {
          return commands.toggleNode(this.name, 'paragraph');
        },
    };
  },

  addInputRules() {
    return [
      textblockTypeInputRule({
        find: /^\s*```epigraph\s$/,
        type: this.type,
      }),
    ];
  },
});
