// Named import (not default): the server bundle is CJS via esbuild, where the
// `import X from '@tiptap/starter-kit'` default-interop resolves to undefined.
import { StarterKit } from '@tiptap/starter-kit';
import { Mark } from '@tiptap/core';
import { Epigraph } from '../src/lib/Epigraph';
import { AudioMark } from '../src/lib/Audio';

/**
 * Server-side ProseMirror schema for HTML <-> Y.Doc conversion (migration +
 * HTML snapshots). It must produce the SAME schema (node/mark names + HTML
 * shapes) as the client editor so content round-trips without losing marks.
 *
 * Epigraph and Audio are imported directly — they only depend on @tiptap, so
 * they're server-safe. Comment is re-declared schema-only here because the
 * client's lib/Comment.ts imports tippy.js (browser-only); this version matches
 * its HTML shape (span[data-comment]).
 */
const ServerComment = Mark.create({
  name: 'comment',
  inclusive: false,
  addAttributes() {
    return {
      comment: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-comment'),
        renderHTML: (attrs) => (attrs.comment ? { 'data-comment': attrs.comment } : {}),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'span[data-comment]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', HTMLAttributes, 0];
  },
});

export const collabExtensions = [
  // StarterKit 3 already bundles Underline, so it is not added separately here.
  StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
  Epigraph,
  AudioMark,
  ServerComment,
];
