import React, { useState, useMemo } from 'react';
import type { Editor } from '@tiptap/react';
import { MessageSquare, Trash2, Edit2, Check, X, ChevronRight } from 'lucide-react';
import { cn } from '../lib/utils';
import { Chapter } from '../types';

interface CommentEntry {
  chapterId: string;
  chapterTitle: string;
  /** Document position of the start of the marked range. */
  from: number;
  /** Document position of the end of the marked range. */
  to: number;
  /** The text the comment is attached to. */
  quote: string;
  /** Comment body. */
  text: string;
}

interface CommentsPanelProps {
  isDarkMode: boolean;
  /** The editor for the currently open chapter, used for the live in-memory document. */
  editor: Editor | null;
  /** All chapters — so we can show the count of comments per chapter even when
   *  the user isn't actively editing them. (For now we only render comments
   *  from the open chapter to keep this honest with what we can read.) */
  chapters: Chapter[];
  currentChapterId: string;
  /** Asks the parent to switch to the named chapter so we can re-extract. */
  onSelectChapter: (id: string) => void;
}

/**
 * Sidebar Comments management.
 *
 * Reads comments from the *currently active editor* — they're inline marks
 * inside the document, and we walk the doc to surface them as a list with
 * the quoted span and the comment body. Each row offers Edit and Delete
 * actions that operate directly on the editor doc; this avoids dealing
 * with an inline tippy popup that's hard to discover on touch.
 *
 * Limitation: we only see comments in the currently open chapter, because
 * other chapters live in plain HTML strings in App state — their marks
 * aren't parsed unless we mount a TipTap instance per chapter, which would
 * be expensive. The header gives a quick "open chapter X to see its
 * comments" hint when other chapters likely contain them.
 */
export const CommentsPanel: React.FC<CommentsPanelProps> = ({
  isDarkMode,
  editor,
  chapters,
  currentChapterId,
  onSelectChapter,
}) => {
  const [editingFrom, setEditingFrom] = useState<number | null>(null);
  const [draft, setDraft] = useState('');

  // Walk the live editor doc looking for spans with the 'comment' mark.
  // Groups contiguous nodes with the same comment text into a single entry.
  const entries: CommentEntry[] = useMemo(() => {
    if (!editor) return [];
    const out: CommentEntry[] = [];
    const currentTitle = chapters.find((c) => c.id === currentChapterId)?.title || 'Chapter';
    const { doc } = editor.state;

    let currentEntry: CommentEntry | null = null;

    doc.descendants((node, pos) => {
      if (!node.isText) return;
      const mark = node.marks.find((m) => m.type.name === 'comment');
      const commentText = mark?.attrs.comment;

      if (mark && commentText) {
        if (currentEntry && currentEntry.text === commentText && currentEntry.to === pos) {
          // Contiguous mark with same content, extend it
          currentEntry.to = pos + node.nodeSize;
          currentEntry.quote += node.text || '';
        } else {
          // New comment or non-contiguous
          currentEntry = {
            chapterId: currentChapterId,
            chapterTitle: currentTitle,
            from: pos,
            to: pos + node.nodeSize,
            quote: node.text || '',
            text: commentText,
          };
          out.push(currentEntry);
        }
      } else {
        currentEntry = null;
      }
    });
    return out;
  }, [editor, editor?.state.doc, chapters, currentChapterId]);

  // Chapters other than the open one that might contain comments. We can't
  // be sure without parsing, but we can scan their HTML strings cheaply for
  // the data-comment attribute marker that CommentMark emits.
  const otherChaptersWithComments = useMemo(() => {
    return chapters.filter((c) => c.id !== currentChapterId && /data-comment=/.test(c.content));
  }, [chapters, currentChapterId]);

  const startEdit = (entry: CommentEntry) => {
    setEditingFrom(entry.from);
    setDraft(entry.text);
  };

  const saveEdit = (entry: CommentEntry) => {
    if (!editor) return;
    editor
      .chain()
      .focus()
      .setTextSelection({ from: entry.from, to: entry.to })
      .setMark('comment', { comment: draft })
      .setTextSelection(entry.to)
      .run();
    setEditingFrom(null);
    setDraft('');
  };

  const deleteEntry = (entry: CommentEntry) => {
    if (!editor) return;
    editor
      .chain()
      .focus()
      .setTextSelection({ from: entry.from, to: entry.to })
      .unsetMark('comment')
      .setTextSelection(entry.to)
      .run();
  };

  const jumpToComment = (entry: CommentEntry) => {
    if (!editor) return;
    editor.chain().focus().setTextSelection({ from: entry.from, to: entry.to }).scrollIntoView().run();
  };

  return (
    <div className="space-y-4">
      {entries.length === 0 && otherChaptersWithComments.length === 0 && (
        <div className="px-4 py-10 flex flex-col items-center justify-center text-center">
          <MessageSquare className="w-6 h-6 opacity-20 mb-3" />
          <p className="text-[10px] uppercase tracking-widest font-bold opacity-30">No comments yet</p>
          <p className="text-[10px] opacity-30 mt-2 max-w-xs leading-relaxed">
            Select text in the editor and run <span className="font-mono">#!/comment</span> to leave an annotation.
          </p>
        </div>
      )}

      {entries.length > 0 && (
        <div className="space-y-2">
          {entries.map((entry) => (
            <div
              key={`${entry.chapterId}-${entry.from}`}
              className={cn(
                'rounded-xl p-3 border space-y-2 group',
                isDarkMode ? 'bg-white/[0.02] border-white/5' : 'bg-black/[0.02] border-black/5',
              )}
            >
              <button
                onClick={() => jumpToComment(entry)}
                className="block w-full text-left"
                title="Jump to this comment in the editor"
              >
                <p className="text-[9px] uppercase tracking-widest font-bold opacity-30 mb-1">{entry.chapterTitle}</p>
                <p className="text-xs italic opacity-70 line-clamp-2 leading-relaxed">"{entry.quote}"</p>
              </button>

              {editingFrom === entry.from ? (
                <div className="space-y-2">
                  <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    rows={3}
                    autoFocus
                    className={cn(
                      'w-full px-3 py-2 rounded-lg text-xs bg-black/5 dark:bg-white/5 border border-transparent focus:border-current/20 outline-none transition-all resize-none',
                      isDarkMode ? 'text-white' : 'text-black',
                    )}
                  />
                  <div className="flex justify-end gap-1.5">
                    <button
                      onClick={() => { setEditingFrom(null); setDraft(''); }}
                      className="px-2.5 py-1 rounded text-[10px] uppercase font-bold tracking-widest opacity-60 hover:opacity-100 transition-opacity"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={() => saveEdit(entry)}
                      className="flex items-center gap-1 px-2.5 py-1 rounded bg-current text-[10px] uppercase font-bold tracking-widest"
                      style={{ color: isDarkMode ? 'black' : 'white' }}
                    >
                      <Check className="w-2.5 h-2.5" />
                      Save
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <p className="text-xs leading-relaxed opacity-90">{entry.text || <span className="italic opacity-40">(empty)</span>}</p>
                  <div className="flex justify-end gap-1">
                    <button
                      onClick={() => startEdit(entry)}
                      className="p-1.5 rounded hover:bg-current/10 opacity-40 hover:opacity-100 transition-all"
                      title="Edit comment"
                    >
                      <Edit2 className="w-3 h-3" />
                    </button>
                    <button
                      onClick={() => deleteEntry(entry)}
                      className="p-1.5 rounded hover:bg-red-500/10 hover:text-red-500 opacity-40 hover:opacity-100 transition-all"
                      title="Delete comment"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      )}

      {otherChaptersWithComments.length > 0 && (
        <div className="space-y-2 pt-2">
          <p className="text-[9px] uppercase tracking-widest font-bold opacity-30 px-1">Other chapters with comments</p>
          {otherChaptersWithComments.map((c) => (
            <button
              key={c.id}
              onClick={() => onSelectChapter(c.id)}
              className={cn(
                'w-full flex items-center justify-between p-3 rounded-lg transition-all border opacity-70 hover:opacity-100',
                isDarkMode ? 'border-white/5 hover:bg-white/5' : 'border-black/5 hover:bg-black/5',
              )}
            >
              <span className="text-xs">{c.title}</span>
              <ChevronRight className="w-3 h-3 opacity-40" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
