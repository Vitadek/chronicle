import { Mark, mergeAttributes } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import tippy from 'tippy.js';
import 'tippy.js/dist/tippy.css';
import 'tippy.js/animations/shift-away.css';

export const CommentMark = Mark.create({
  name: 'comment',
  inclusive: false,

  addOptions() {
    return {
      HTMLAttributes: {
        class: 'manuscript-comment-marker',
      },
    };
  },

  addAttributes() {
    return {
      comment: {
        default: null,
        parseHTML: element => element.getAttribute('data-comment'),
        renderHTML: attributes => {
          return {
            'data-comment': attributes.comment,
          };
        },
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'span[data-comment]',
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(this.options.HTMLAttributes, HTMLAttributes), 0];
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('commentDecorations'),
        props: {
          decorations: state => {
            const { doc } = state;
            const decorations: Decoration[] = [];
            
            doc.descendants((node, pos) => {
              if (node.isBlock) {
                const commentRanges: { text: string; from: number; to: number }[] = [];
                let currentRange: { text: string; from: number; to: number } | null = null;

                node.descendants((child, childPos) => {
                  if (!child.isText) return;
                  const mark = child.marks.find(m => m.type.name === 'comment');
                  const commentText = mark?.attrs.comment;
                  const childFrom = pos + childPos + 1;
                  const childTo = childFrom + child.nodeSize;

                  if (mark && commentText) {
                    if (currentRange && currentRange.text === commentText && currentRange.to === childFrom) {
                      currentRange.to = childTo;
                    } else {
                      currentRange = { text: commentText, from: childFrom, to: childTo };
                      commentRanges.push(currentRange);
                    }
                  } else {
                    currentRange = null;
                  }
                });

                commentRanges.forEach(range => {
                  const widget = document.createElement('span');
                  widget.className = 'comment-icon-widget';
                  widget.style.cursor = 'pointer';
                  
                  // Helper to trigger the edit UI
                  const triggerEdit = (e: Event) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const event = new CustomEvent('edit-comment', {
                      detail: {
                        from: range.from,
                        to: range.to,
                        comment: range.text,
                        text: doc.textBetween(range.from, range.to)
                      }
                    });
                    window.dispatchEvent(event);
                  };

                  // Double click for the full popup
                  widget.addEventListener('dblclick', triggerEdit);

                  // Single click/tap tooltip to "see what the comment said"
                  tippy(widget, {
                    content: range.text || '(empty comment)',
                    placement: 'top',
                    animation: 'shift-away',
                    theme: 'manuscript',
                    maxWidth: 300,
                  });
                  
                  widget.innerHTML = `
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="opacity: 0.3; margin-left: 4px; margin-right: 4px; display: inline-block; pointer-events: none;">
                      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
                    </svg>
                  `;
                  decorations.push(Decoration.widget(range.to, widget, { side: 1 }));
                });
              }
            });

            return DecorationSet.create(doc, decorations);
          },
        },
      }),
    ];
  },
});
