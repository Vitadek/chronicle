import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import CharacterCount from '@tiptap/extension-character-count';
import Typography from '@tiptap/extension-typography';
import Underline from '@tiptap/extension-underline';
import { Epigraph } from './Epigraph';
import { CommentMark } from './Comment';
import { AudioMark } from './Audio';
import Collaboration from '@tiptap/extension-collaboration';
import type { AnyExtension } from '@tiptap/core';
import type { Doc as YDoc } from 'yjs';

/**
 * Keyboard-control attributes applied to the editor's contenteditable.
 *
 * Chronicle's Typography extension is the SINGLE source of smart punctuation
 * (curly quotes, em dashes, ellipses). Letting the OS keyboard also
 * autocorrect/auto-punctuate fights those input rules and drops a stray space
 * after quotes on mobile. We turn the keyboard's active text rewriting off,
 * keep spellcheck on (passive red squiggles, never mutates text), and keep
 * sentence auto-capitalization (only changes case).
 *
 * Shared by the web editor (src/hooks/useChronicleEditor.ts) and the mobile
 * slim editor bundle so both surfaces behave identically.
 */
export const EDITOR_KEYBOARD_ATTRS = {
  autocapitalize: 'sentences',
  autocorrect: 'off',
  autocomplete: 'off',
  spellcheck: 'true',
} as const;

export interface CoreExtensionOptions {
  placeholder?: string;
  /**
   * When provided, the editor binds to this shared Y.Doc for real-time
   * collaboration: StarterKit's undo/redo is disabled (Collaboration brings its
   * own Yjs-aware history) and the Collaboration extension is appended. Content
   * then comes from the Y.Doc, not the `content` prop. Used by the web
   * CollabEditor and (later) the mobile bundle's bridge provider.
   */
  collabDocument?: YDoc;
}

/**
 * The prose core shared by every Chronicle editor surface: StarterKit, smart
 * typography, underline, placeholder, word counting, and the inline marks
 * (epigraph / comment / audio).
 *
 * The web-only interactive layer — Focus dimming, the Autocomplete ghost-text,
 * the `#!` CommandLine portal, and the selection BubbleMenu — is added on top
 * in useChronicleEditor. The mobile bundle leaves those out and drives the
 * equivalent affordances from native Flutter UI over the JS bridge.
 */
export function buildCoreExtensions(
  { placeholder = 'Once upon a time...', collabDocument }: CoreExtensionOptions = {},
): AnyExtension[] {
  const extensions: AnyExtension[] = [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      // Collaboration owns undo/redo via the Yjs undo manager; the two must
      // not both be active or history desyncs from the shared doc.
      ...(collabDocument ? { undoRedo: false } : {}),
    }),
    Underline,
    Placeholder.configure({ placeholder }),
    CharacterCount,
    Typography,
    Epigraph,
    CommentMark,
    AudioMark,
  ];
  if (collabDocument) {
    extensions.push(Collaboration.configure({ document: collabDocument }));
  }
  return extensions;
}
