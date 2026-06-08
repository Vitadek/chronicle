import { useMemo, useEffect, useRef } from 'react';
import { useEditor } from '@tiptap/react';
import Focus from '@tiptap/extension-focus';
import BubbleMenuExtension from '@tiptap/extension-bubble-menu';
import { Autocomplete } from '../lib/Autocomplete';
import { CommandLine } from '../lib/CommandLine';
import { TenseShift, type TenseShiftHit } from '../lib/TenseShift';
import { Grammar, type GrammarMark } from '../lib/Grammar';
import { buildCoreExtensions, EDITOR_KEYBOARD_ATTRS } from '../lib/editorExtensions';

export interface UseChronicleEditorProps {
  content?: string;
  onUpdate?: (content: string) => void;
  placeholder?: string;
  className?: string;
  isAutocompleteEnabled?: boolean;
  commandLineOptions?: any;
  /** When true, suppress touch-hostile affordances (the caret-anchored
   *  autocomplete ghost-text). Keyboard-control attributes below are set
   *  unconditionally since desktop browsers ignore the mobile-only ones. */
  isTouchUI?: boolean;
  /** Live wavy-underline flagging of sentences that drift from a paragraph's
   *  dominant narrative tense (local, deterministic — see lib/TenseShift.ts). */
  isTenseCheckEnabled?: boolean;
  /** Receives the current set of tense-shift hits after each recompute. */
  onTenseShifts?: (hits: TenseShiftHit[]) => void;
  /** Live grammar/style squiggles via the local Harper engine (lib/Grammar.ts). */
  isGrammarCheckEnabled?: boolean;
  /** Receives the current set of grammar marks after each recompute. */
  onGrammarMarks?: (marks: GrammarMark[]) => void;
}

export function useChronicleEditor({ 
  content = '', 
  onUpdate, 
  placeholder = 'Once upon a time...',
  className = 'novel-editor-content focus:outline-none min-h-[500px]',
  isAutocompleteEnabled = false,
  commandLineOptions,
  isTouchUI = false,
  isTenseCheckEnabled = false,
  onTenseShifts,
  isGrammarCheckEnabled = false,
  onGrammarMarks
}: UseChronicleEditorProps) {
  // Core prose + marks come from the shared module so the mobile editor bundle
  // stays in sync (smart quotes, no-stray-space, marks). The web-only
  // interactive layer (focus dimming, autocomplete ghost-text, the #! command
  // portal, selection bubble) is layered on top here.
  // Keep the latest onTenseShifts callback in a ref so the extensions array
  // (rebuilt only when placeholder changes) always calls the current one.
  const onTenseShiftsRef = useRef(onTenseShifts);
  onTenseShiftsRef.current = onTenseShifts;
  const onGrammarMarksRef = useRef(onGrammarMarks);
  onGrammarMarksRef.current = onGrammarMarks;

  const extensions = useMemo(() => [
    ...buildCoreExtensions({ placeholder }),
    Focus.configure({
      className: 'has-focus',
      mode: 'all',
    }),
    TenseShift.configure({
      enabled: false, // toggled at runtime via the effect below
      onShifts: (hits) => onTenseShiftsRef.current?.(hits),
    }),
    Grammar.configure({
      enabled: false, // toggled at runtime via the effect below
      onMarks: (marks) => onGrammarMarksRef.current?.(marks),
    }),
    Autocomplete,
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
        // Shared keyboard-control attributes (see lib/editorExtensions.ts):
        // make Chronicle's Typography the single source of smart punctuation
        // and stop the OS keyboard from injecting a stray space after quotes.
        ...EDITOR_KEYBOARD_ATTRS,
      },
    },
  });

  useEffect(() => {
    const autocompleteStorage = (editor?.storage as any)?.autocomplete;
    if (editor && !editor.isDestroyed && autocompleteStorage) {
      // The ghost-text suggestion is a widget decoration rendered at the
      // caret. On touch keyboards that disrupts IME composition, and it can't
      // be accepted anyway (there's no Tab key), so force it off in touch UI.
      autocompleteStorage.enabled = isAutocompleteEnabled && !isTouchUI;
      // Force a view update to refresh decorations
      editor.view.dispatch(editor.state.tr);
    }
  }, [isAutocompleteEnabled, isTouchUI, editor]);

  useEffect(() => {
    if (editor && !editor.isDestroyed) {
      editor.commands.setTenseCheck(isTenseCheckEnabled);
    }
  }, [isTenseCheckEnabled, editor]);

  useEffect(() => {
    if (editor && !editor.isDestroyed) {
      editor.commands.setGrammarCheck(isGrammarCheckEnabled);
    }
  }, [isGrammarCheckEnabled, editor]);

  return editor;
}

