import { Mark, mergeAttributes } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

/**
 * Inline audio attachment.
 *
 * Used by the `/ai_listen` command and the bubble-menu "Listen" action.
 * Marks a span of text and stashes a blob URL (or a session-keyed handle)
 * so a floating play button can be rendered next to the marked text.
 *
 * Storage strategy:
 *   - The attribute value is an *opaque token* — we don't serialize the
 *     blob URL into the document HTML, because (a) blob URLs are per-tab
 *     and would dead-link, (b) we don't want audio surviving into a
 *     manuscript export.
 *   - The actual blob URL lives in a module-level Map keyed by the token.
 *     When the AI returns audio, the caller registers it; when the play
 *     widget is clicked, we look it up.
 *
 * Audio is session-scoped: it doesn't survive a reload. That's fine and
 * deliberate — re-running /ai_listen regenerates a fresh take.
 */

const audioStore = new Map<string, string>(); // token -> blob URL

export function registerAudioToken(token: string, blobUrl: string): void {
  // Revoke any prior URL associated with this token so blob memory frees.
  const old = audioStore.get(token);
  if (old && old !== blobUrl) URL.revokeObjectURL(old);
  audioStore.set(token, blobUrl);
}

export function getAudioForToken(token: string): string | undefined {
  return audioStore.get(token);
}

export function clearAudioStore(): void {
  for (const url of audioStore.values()) URL.revokeObjectURL(url);
  audioStore.clear();
}

export function newAudioToken(): string {
  return 'audio_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9);
}

export const AudioMark = Mark.create({
  name: 'audio',
  inclusive: false,

  addOptions() {
    return {
      HTMLAttributes: {
        class: 'manuscript-audio-marker',
      },
    };
  },

  addAttributes() {
    return {
      token: {
        default: null,
        parseHTML: element => element.getAttribute('data-audio-token'),
        renderHTML: attributes => {
          if (!attributes.token) return {};
          return { 'data-audio-token': attributes.token };
        },
      },
    };
  },

  parseHTML() {
    return [
      { tag: 'span[data-audio-token]' },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(this.options.HTMLAttributes, HTMLAttributes), 0];
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('audioDecorations'),
        props: {
          decorations: state => {
            const { doc } = state;
            const decorations: Decoration[] = [];

            doc.descendants((node, pos) => {
              if (!node.isBlock) return;
              let hasAudio = false;
              let token = '';
              node.descendants(child => {
                const m = child.marks.find(mk => mk.type.name === 'audio');
                if (m) {
                  hasAudio = true;
                  token = m.attrs.token;
                  return false;
                }
              });
              if (!hasAudio) return;

              const widget = document.createElement('button');
              widget.type = 'button';
              widget.className = 'audio-icon-widget';
              widget.setAttribute('data-audio-token', token);
              widget.setAttribute('title', 'Play audio (AI narration)');
              widget.innerHTML = `
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="opacity: 0.4; margin-left: 12px; display: inline-block; cursor: pointer; pointer-events: auto;">
                  <polygon points="5 3 19 12 5 21 5 3"></polygon>
                </svg>
              `;
              // Inline click handler: lookup, lazily create an Audio element,
              // toggle play/pause. We don't reuse a global audio so multiple
              // markers can be played in sequence without sharing state.
              widget.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const url = audioStore.get(token);
                if (!url) {
                  console.warn('No audio for token', token);
                  return;
                }
                // Stash a single Audio per widget to allow pause.
                let audio = (widget as any)._audio as HTMLAudioElement | undefined;
                if (!audio) {
                  audio = new Audio(url);
                  (widget as any)._audio = audio;
                  audio.addEventListener('ended', () => widget.classList.remove('playing'));
                }
                if (audio.paused) {
                  audio.play().catch(err => console.warn('audio play failed', err));
                  widget.classList.add('playing');
                } else {
                  audio.pause();
                  widget.classList.remove('playing');
                }
              });
              decorations.push(Decoration.widget(pos + node.nodeSize - 1, widget, { side: 1 }));
            });

            return DecorationSet.create(doc, decorations);
          },
        },
      }),
    ];
  },
});
