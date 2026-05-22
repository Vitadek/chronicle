import { useMemo, useEffect } from 'react';
import { useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import CharacterCount from '@tiptap/extension-character-count';
import Typography from '@tiptap/extension-typography';
import Focus from '@tiptap/extension-focus';
import Underline from '@tiptap/extension-underline';
import BubbleMenuExtension from '@tiptap/extension-bubble-menu';
import { Autocomplete } from '../lib/Autocomplete';
import { Epigraph } from '../lib/Epigraph';
import { CommentMark } from '../lib/Comment';
import { AudioMark } from '../lib/Audio';
import { CommandLine } from '../lib/CommandLine';

export interface UseChronicleEditorProps {
  content?: string;
  onUpdate?: (content: string) => void;
  placeholder?: string;
  className?: string;
  isAutocompleteEnabled?: boolean;
  commandLineOptions?: any;
}

export function useChronicleEditor({ 
  content = '', 
  onUpdate, 
  placeholder = 'Once upon a time...',
  className = 'novel-editor-content focus:outline-none min-h-[500px]',
  isAutocompleteEnabled = false,
  commandLineOptions
}: UseChronicleEditorProps) {
  const extensions = useMemo(() => [
    StarterKit.configure({
      heading: {
        levels: [1, 2, 3],
      },
    }),
    Underline,
    Placeholder.configure({
      placeholder,
    }),
    CharacterCount,
    Typography,
    Focus.configure({
      className: 'has-focus',
      mode: 'all',
    }),
    Autocomplete,
    Epigraph,
    CommentMark,
    AudioMark,
    CommandLine.configure({
      suggestion: {
        char: '#!',
        allowSpaces: true,
        ...commandLineOptions,
      },
    }),
    BubbleMenuExtension.configure({
      shouldShow: ({ state, from, to }) => {
        return from !== to && state.doc.textBetween(from, to).trim().length > 0;
      },
    }),
  ], [placeholder]);

  const editor = useEditor({
    extensions,
    content,
    onUpdate: ({ editor }) => {
      onUpdate?.(editor.getHTML());
    },
    editorProps: {
      attributes: {
        class: className,
      },
    },
  });

  useEffect(() => {
    const autocompleteStorage = (editor?.storage as any)?.autocomplete;
    if (editor && !editor.isDestroyed && autocompleteStorage) {
      autocompleteStorage.enabled = isAutocompleteEnabled;
      // Force a view update to refresh decorations
      editor.view.dispatch(editor.state.tr);
    }
  }, [isAutocompleteEnabled, editor]);

  return editor;
}

