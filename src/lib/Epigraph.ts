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
        tag: 'blockquote[data-type="epigraph"]',
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
