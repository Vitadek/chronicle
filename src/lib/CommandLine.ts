import { Extension } from '@tiptap/core';
import Suggestion from '@tiptap/suggestion';

export const CommandLine = Extension.create({
  name: 'commandLine',

  addOptions() {
    return {
      suggestion: {
        char: '#!',
        allowSpaces: false,
        command: ({ editor, range, props }: any) => {
          props.command({ editor, range });
        },
      },
    };
  },

  addProseMirrorPlugins() {
    return [
      Suggestion({
        editor: this.editor,
        ...this.options.suggestion,
      }),
    ];
  },
});
