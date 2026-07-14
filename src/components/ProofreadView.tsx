import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  ArrowLeft, ChevronLeft, ChevronRight, SpellCheck, BookMarked, List as ListIcon,
  Sparkles, Loader2, CheckCircle2, X, Trash2, Plus, Check,
} from 'lucide-react';
import { EditorContent } from '@tiptap/react';
import { cn } from '../lib/utils';
import { Chapter, ManuscriptMetadata } from '../types';
import { useChronicleEditor } from '../hooks/useChronicleEditor';
import type { GrammarMark } from '../lib/Grammar';
import { locateQuote } from '../lib/proseMirrorText';
import { aiClarityPass } from '../services/grammarAiService';
import { addWord, listWords, removeWord } from '../lib/dictionary';
import { scheduleSettingsPush } from '../lib/settingsSync';

interface ProofreadViewProps {
  metadata: ManuscriptMetadata;
  chapters: Chapter[];
  isDarkMode: boolean;
  /** AI enabled + configured + not hidden by AI_UI=off. Gates the clarity pass. */
  aiAvailable: boolean;
  onUpdateChapter: (chapterId: string, content: string) => void;
  onExit: () => void;
}

type IssueSource = 'spelling' | 'grammar' | 'clarity';

interface Issue {
  key: string;
  source: IssueSource;
  /** Doc positions; clarity rows relocate by quote at jump time. */
  from: number | null;
  to: number | null;
  text: string;
  message: string;
  replacements?: string[];
}

const SOURCE_META: Record<IssueSource, { label: string; badge: string }> = {
  spelling: { label: 'Spelling', badge: 'bg-red-500/15 text-red-500' },
  grammar: { label: 'Grammar', badge: 'bg-amber-500/15 text-amber-600 dark:text-amber-400' },
  clarity: { label: 'Clarity', badge: 'bg-purple-500/15 text-purple-500' },
};

/**
 * Proofread mode: a guided revision pass over one manuscript.
 *
 * Walks the writer through issues one at a time — spelling + grammar from the
 * live LanguageTool pipeline, plus an on-demand AI clarity pass that flags
 * clunky/unclear wording. HARD RULE: clarity rows carry no rewrites, only an
 * explanation of why a passage may read unclear (the endpoint's schema has no
 * suggestion field). Spelling rows DO offer LanguageTool's dictionary
 * corrections as one-click fixes.
 *
 * The issue card is a popup ANCHORED to the flagged text: walking the queue
 * scrolls the passage into view, tints it (ProofreadHighlight — decoration,
 * not selection, so the editor is never focused and mobile keyboards stay
 * down), and floats the card just beneath it.
 *
 * This view is also the only place the custom dictionary is edited: "Add to
 * dictionary" on a spelling row, and the Dictionary drawer for review/removal.
 * The dictionary itself applies everywhere (Grammar.ts filters misspellings).
 */
export function ProofreadView({
  metadata,
  chapters,
  isDarkMode,
  aiAvailable,
  onUpdateChapter,
  onExit,
}: ProofreadViewProps) {
  const [chapterIndex, setChapterIndex] = useState(0);
  // Which chapters this pass covers. null = the picker is showing (entry
  // state, or reopened from the header). Defaults to all selected.
  const [selectedIds, setSelectedIds] = useState<Set<string> | null>(null);
  const [pickerDraft, setPickerDraft] = useState<Set<string>>(() => new Set(chapters.map((c) => c.id)));
  const [showList, setShowList] = useState(() => {
    return localStorage.getItem('chronicle_proofread_list') === 'true';
  });
  const [showDictionary, setShowDictionary] = useState(false);
  // Bumped whenever the dictionary changes so the open chapter re-lints.
  const [dictVersion, setDictVersion] = useState(0);

  // The walk only covers the chosen chapters, in manuscript order.
  const activeChapters = useMemo(
    () => (selectedIds ? chapters.filter((c) => selectedIds.has(c.id)) : []),
    [chapters, selectedIds],
  );
  const chapter = activeChapters[Math.min(chapterIndex, Math.max(activeChapters.length - 1, 0))];

  const toggleList = () => {
    setShowList((prev) => {
      localStorage.setItem('chronicle_proofread_list', String(!prev));
      scheduleSettingsPush();
      return !prev;
    });
  };

  return (
    <div
      className={cn(
        'min-h-screen-dvh w-full flex flex-col',
        isDarkMode ? 'bg-manuscript-dark text-[#F1EDE4]' : 'bg-manuscript-light text-black',
      )}
    >
      {/* Header */}
      <div className="shrink-0 flex items-center justify-between gap-3 px-4 sm:px-8 py-4 border-b border-black/12 dark:border-white/15">
        <div className="flex items-center gap-3 min-w-0">
          <button
            onClick={onExit}
            className="p-2 -ml-2 rounded-xl hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
            title="Back to library"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <SpellCheck className="w-4 h-4 opacity-30 shrink-0 hidden sm:block" />
          <div className="min-w-0">
            <p className="text-[9px] uppercase tracking-[0.2em] font-bold opacity-40">Proofread</p>
            <h1 className="text-sm font-literata font-semibold truncate">{metadata.title || 'Untitled Manuscript'}</h1>
          </div>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {/* Chapter stepper (over the SELECTED chapters) */}
          {selectedIds && (
            <div className="flex items-center gap-1 mr-2">
              <button
                onClick={() => setChapterIndex((i) => Math.max(0, i - 1))}
                disabled={chapterIndex === 0}
                className="p-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-20 transition-all"
                title="Previous chapter"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <button
                onClick={() => {
                  // Reopen the picker, seeded with the current selection.
                  setPickerDraft(new Set(selectedIds));
                  setSelectedIds(null);
                }}
                className="text-[10px] uppercase tracking-widest font-bold opacity-50 hover:opacity-100 whitespace-nowrap tabular-nums transition-opacity"
                title="Choose chapters"
              >
                Ch {chapterIndex + 1}/{activeChapters.length}
              </button>
              <button
                onClick={() => setChapterIndex((i) => Math.min(activeChapters.length - 1, i + 1))}
                disabled={chapterIndex >= activeChapters.length - 1}
                className="p-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-20 transition-all"
                title="Next chapter"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          )}

          <button
            onClick={toggleList}
            className={cn(
              'p-2 rounded-xl border transition-all',
              showList
                ? (isDarkMode ? 'bg-white/10 border-white/15 text-white' : 'bg-black/10 border-black/15 text-black')
                : 'border-transparent opacity-50 hover:opacity-100 hover:bg-black/5 dark:hover:bg-white/5',
            )}
            title={showList ? 'Hide issue list' : 'Show issue list'}
          >
            <ListIcon className="w-4 h-4" />
          </button>
          <button
            onClick={() => setShowDictionary(true)}
            className="p-2 rounded-xl border border-transparent opacity-50 hover:opacity-100 hover:bg-black/5 dark:hover:bg-white/5 transition-all"
            title="Custom dictionary"
          >
            <BookMarked className="w-4 h-4" />
          </button>
        </div>
      </div>

      {selectedIds === null ? (
        <ChapterPicker
          chapters={chapters}
          draft={pickerDraft}
          onChangeDraft={setPickerDraft}
          isDarkMode={isDarkMode}
          onStart={() => {
            setSelectedIds(new Set(pickerDraft));
            setChapterIndex(0);
          }}
        />
      ) : chapter ? (
        <ProofreadChapter
          key={chapter.id}
          chapter={chapter}
          chapterLabel={chapter.title || `Chapter ${chapterIndex + 1}`}
          isDarkMode={isDarkMode}
          aiAvailable={aiAvailable}
          showList={showList}
          dictVersion={dictVersion}
          onDictionaryAdd={(word) => {
            addWord(word);
            setDictVersion((v) => v + 1);
          }}
          onUpdateContent={(html) => onUpdateChapter(chapter.id, html)}
          hasNextChapter={chapterIndex < activeChapters.length - 1}
          onNextChapter={() => setChapterIndex((i) => Math.min(activeChapters.length - 1, i + 1))}
        />
      ) : (
        <div className="flex-1 flex items-center justify-center opacity-40 text-sm">No chapters to proofread.</div>
      )}

      <DictionaryDrawer
        isOpen={showDictionary}
        onClose={() => setShowDictionary(false)}
        isDarkMode={isDarkMode}
        onChanged={() => setDictVersion((v) => v + 1)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chapter picker — shown on entry (and via the header's chapter label):
// choose which chapters this pass covers, with a select-all/clear toggle.
// ---------------------------------------------------------------------------

interface ChapterPickerProps {
  chapters: Chapter[];
  draft: Set<string>;
  onChangeDraft: (next: Set<string>) => void;
  isDarkMode: boolean;
  onStart: () => void;
}

function ChapterPicker({ chapters, draft, onChangeDraft, isDarkMode, onStart }: ChapterPickerProps) {
  const allSelected = draft.size === chapters.length && chapters.length > 0;

  const toggle = (id: string) => {
    const next = new Set(draft);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChangeDraft(next);
  };

  return (
    <div className="flex-1 flex items-start sm:items-center justify-center p-4 overflow-y-auto custom-scrollbar">
      <motion.div
        initial={{ opacity: 0, y: 8, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        className={cn(
          'w-full max-w-md rounded-3xl border shadow-2xl flex flex-col max-h-[75vh] overflow-hidden',
          isDarkMode ? 'bg-[#2b2926] border-white/10' : 'bg-white border-black/10',
        )}
      >
        <div className="px-6 pt-6 pb-4">
          <h3 className="text-sm font-bold uppercase tracking-widest">Which chapters?</h3>
          <p className="text-[10px] opacity-40 mt-1 leading-relaxed">
            The pass walks the selected chapters in order. You can change this
            any time from the chapter counter in the header.
          </p>
        </div>

        <div className="flex items-center justify-between px-6 py-2 border-y border-black/12 dark:border-white/15">
          <span className="text-[10px] uppercase tracking-widest font-bold opacity-40">
            {draft.size} of {chapters.length} selected
          </span>
          <button
            onClick={() => onChangeDraft(allSelected ? new Set() : new Set(chapters.map((c) => c.id)))}
            className="text-[10px] uppercase tracking-widest font-black opacity-60 hover:opacity-100 transition-opacity"
          >
            {allSelected ? 'Deselect all' : 'Select all'}
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-3 py-3 custom-scrollbar">
          {chapters.map((c, i) => {
            const isChecked = draft.has(c.id);
            return (
              <button
                key={c.id}
                onClick={() => toggle(c.id)}
                className={cn(
                  'w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-colors',
                  isChecked ? 'bg-blue-500/10' : 'hover:bg-black/5 dark:hover:bg-white/5',
                )}
              >
                <div
                  className={cn(
                    'w-4 h-4 rounded shrink-0 border flex items-center justify-center transition-all',
                    isChecked
                      ? 'bg-blue-500 border-blue-500'
                      : isDarkMode ? 'border-white/25' : 'border-black/20',
                  )}
                >
                  {isChecked && <Check className="w-3 h-3 text-white" strokeWidth={3} />}
                </div>
                <span className="text-[10px] font-mono opacity-30 tabular-nums w-6 shrink-0">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <span className="text-xs truncate flex-1">{c.title || 'Untitled'}</span>
              </button>
            );
          })}
        </div>

        <div className="px-6 py-4 border-t border-black/12 dark:border-white/15">
          <button
            onClick={onStart}
            disabled={draft.size === 0}
            className={cn(
              'w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-[10px] uppercase font-black tracking-widest transition-all shadow-lg',
              draft.size === 0
                ? 'opacity-30 cursor-not-allowed bg-black/10 dark:bg-white/10'
                : isDarkMode
                  ? 'bg-white text-black hover:scale-[1.02] active:scale-95'
                  : 'bg-black text-white hover:scale-[1.02] active:scale-95',
            )}
          >
            <SpellCheck className="w-3.5 h-3.5" />
            Start proofreading{draft.size > 0 ? ` (${draft.size} chapter${draft.size === 1 ? '' : 's'})` : ''}
          </button>
        </div>
      </motion.div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-chapter pass: owns the editor, the issue queue, and the walk.
// ---------------------------------------------------------------------------

interface ProofreadChapterProps {
  chapter: Chapter;
  chapterLabel: string;
  isDarkMode: boolean;
  aiAvailable: boolean;
  showList: boolean;
  dictVersion: number;
  onDictionaryAdd: (word: string) => void;
  onUpdateContent: (html: string) => void;
  hasNextChapter: boolean;
  onNextChapter: () => void;
}

function ProofreadChapter({
  chapter,
  chapterLabel,
  isDarkMode,
  aiAvailable,
  showList,
  dictVersion,
  onDictionaryAdd,
  onUpdateContent,
  hasNextChapter,
  onNextChapter,
}: ProofreadChapterProps) {
  const [grammarMarks, setGrammarMarks] = useState<GrammarMark[]>([]);
  const [clarityIssues, setClarityIssues] = useState<{ quote: string; message: string }[]>([]);
  const [clarityRan, setClarityRan] = useState(false);
  const [clarityLoading, setClarityLoading] = useState(false);
  const [clarityError, setClarityError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const [currentKey, setCurrentKey] = useState<string | null>(null);
  // Issues the user actively dealt with (fix applied, ignored, added to
  // dictionary) — resolution is progress, and the UI should say so.
  const [resolvedCount, setResolvedCount] = useState(0);
  // First lint hasn't landed yet — full "checking" overlay instead of "clean".
  const [linted, setLinted] = useState(false);
  // An edit happened and the (debounced) re-lint is in flight.
  const [relinting, setRelinting] = useState(false);
  // Popup anchor: offset from the top of the prose wrapper, in px.
  const [popupTop, setPopupTop] = useState<number | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const lintedRef = useRef(false);

  const editor = useChronicleEditor({
    content: chapter.content || '<p></p>',
    className: 'novel-editor-content focus:outline-none min-h-[300px]',
    placeholder: ' ',
    // Proofreading is about the existing text — no ghost-text, no autocorrect
    // rewriting under the reader's feet.
    isAutocompleteEnabled: false,
    isAutoCorrectEnabled: false,
    isGrammarCheckEnabled: true,
    onGrammarMarks: (marks, reason) => {
      setGrammarMarks(marks);
      // 'cleared' fires when the checker toggles off (e.g. the dictionary
      // re-lint bounce) — that is NOT a finished lint. Treating it as one
      // made a fresh chapter flash "clean" until the real result landed.
      if (reason !== 'cleared') {
        setLinted(true);
        lintedRef.current = true;
        setRelinting(false);
      }
    },
    onUpdate: (html) => {
      onUpdateContent(html);
      // The Grammar extension re-lints on a debounce after any doc change;
      // reflect that in the UI so a fix visibly "rechecks".
      setRelinting(true);
    },
  });

  // LanguageTool is the single checker in this view: disable the browser's
  // native squiggles so dictionary words are truly clean here (the OS
  // dictionary can't see our custom one).
  useEffect(() => {
    if (editor && !editor.isDestroyed) {
      editor.view.dom.setAttribute('spellcheck', 'false');
    }
  }, [editor]);

  // Dictionary changed (add from a card, or edits in the drawer): force a
  // re-lint so flags appear/disappear accordingly. The Grammar extension only
  // recomputes on doc change or enable-toggle, so bounce the toggle. Skip
  // until the first lint has landed — bouncing during the initial check would
  // clear it for nothing.
  useEffect(() => {
    if (dictVersion === 0 || !lintedRef.current || !editor || editor.isDestroyed) return;
    setRelinting(true);
    editor.commands.setGrammarCheck(false);
    editor.commands.setGrammarCheck(true);
  }, [dictVersion, editor]);

  const issueKey = (source: IssueSource, text: string, message: string) =>
    `${source}|${text}|${message}`;

  // The walk queue: grammar marks (split spelling vs grammar) + located
  // clarity rows, in document order, minus dismissals.
  const queue = useMemo<Issue[]>(() => {
    const rows: Issue[] = [];
    for (const m of grammarMarks) {
      const source: IssueSource = m.kind === 'misspelling' ? 'spelling' : 'grammar';
      const key = issueKey(source, m.text, m.message);
      if (dismissed.has(key)) continue;
      rows.push({ key, source, from: m.from, to: m.to, text: m.text, message: m.message, replacements: m.replacements });
    }
    for (const c of clarityIssues) {
      const key = issueKey('clarity', c.quote, c.message);
      if (dismissed.has(key)) continue;
      const loc = editor && !editor.isDestroyed ? locateQuote(editor, c.quote) : null;
      rows.push({ key, source: 'clarity', from: loc?.from ?? null, to: loc?.to ?? null, text: c.quote, message: c.message });
    }
    rows.sort((a, b) => (a.from ?? Number.MAX_SAFE_INTEGER) - (b.from ?? Number.MAX_SAFE_INTEGER));
    return rows;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grammarMarks, clarityIssues, dismissed]);

  const currentIndex = Math.max(0, queue.findIndex((r) => r.key === currentKey));
  const current = queue[currentIndex] ?? null;

  // Keep a valid current selection as the queue shifts under us (fixes,
  // dismissals, re-lints after edits).
  useEffect(() => {
    if (queue.length === 0) {
      if (currentKey !== null) setCurrentKey(null);
      return;
    }
    if (!queue.some((r) => r.key === currentKey)) {
      setCurrentKey(queue[0].key);
    }
  }, [queue, currentKey]);

  /** Resolve the doc span for an issue (clarity relocates by quote). */
  const spanFor = useCallback((issue: Issue): { from: number; to: number } | null => {
    if (!editor || editor.isDestroyed) return null;
    if (issue.source === 'clarity') return locateQuote(editor, issue.text);
    return issue.from != null && issue.to != null ? { from: issue.from, to: issue.to } : null;
  }, [editor]);

  /**
   * Anchor the walk to an issue: tint the span (decoration — never focuses,
   * so no mobile keyboard), scroll it to the upper third of the viewport
   * (leaving room for the popup beneath), and place the popup under its line.
   */
  const anchorTo = useCallback((issue: Issue, scroll: boolean) => {
    const span = spanFor(issue);
    if (!editor || editor.isDestroyed || !span) {
      setPopupTop(null);
      return;
    }
    editor.commands.setProofreadHighlight(span.from, span.to);

    const wrapper = wrapperRef.current;
    const scroller = scrollRef.current;
    if (!wrapper || !scroller) return;
    // coordsAtPos is viewport-relative; convert into wrapper-local offsets.
    const startCoords = editor.view.coordsAtPos(span.from);
    const endCoords = editor.view.coordsAtPos(Math.min(span.to, editor.state.doc.content.size));
    const wrapperRect = wrapper.getBoundingClientRect();
    const topInWrapper = startCoords.top - wrapperRect.top;
    const bottomInWrapper = endCoords.bottom - wrapperRect.top;

    setPopupTop(bottomInWrapper + 10);
    if (scroll) {
      scroller.scrollTo({
        top: Math.max(0, topInWrapper - scroller.clientHeight * 0.28),
        behavior: 'smooth',
      });
    }
  }, [editor, spanFor]);

  const jumpTo = useCallback((issue: Issue) => {
    setCurrentKey(issue.key);
    anchorTo(issue, true);
  }, [anchorTo]);

  const goTo = useCallback((index: number) => {
    const target = queue[Math.max(0, Math.min(queue.length - 1, index))];
    if (target) jumpTo(target);
  }, [queue, jumpTo]);

  // Re-anchor (without scrolling) whenever the current issue or its position
  // changes — e.g. after a re-lint shifted spans, on first lint, or when the
  // queue advanced because the current row was fixed/dismissed.
  useEffect(() => {
    if (!current) {
      setPopupTop(null);
      if (editor && !editor.isDestroyed) editor.commands.clearProofreadHighlight();
      return;
    }
    // Wait a frame so layout (fonts, decorations) is settled before measuring.
    const raf = requestAnimationFrame(() => anchorTo(current, false));
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.key, current?.from, current?.to, linted]);

  // First issue after the initial lint: scroll to it so the walk visibly starts.
  const firstAnchorDone = useRef(false);
  useEffect(() => {
    if (!firstAnchorDone.current && linted && current) {
      firstAnchorDone.current = true;
      anchorTo(current, true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linted, current?.key]);

  // Keyboard: arrows walk the queue, Enter advances — but never while the
  // user is typing in the editor or an input (arrows must move the caret).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      if (e.key === 'ArrowRight' || e.key === 'Enter') {
        e.preventDefault();
        goTo(currentIndex + 1);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        goTo(currentIndex - 1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goTo, currentIndex]);

  /**
   * Resolve one or more rows: count them as progress, drop them from the
   * queue, and advance the walk to the next surviving issue (searching
   * forward from the resolved position, then backward) — resolving should
   * feel like pressing Next, not like starting over at issue 1.
   */
  const resolve = useCallback((keys: Set<string>) => {
    setResolvedCount((c) => c + keys.size);
    setDismissed((prev) => {
      const next = new Set(prev);
      keys.forEach((k) => next.add(k));
      return next;
    });
    const fromIndex = queue.findIndex((r) => r.key === currentKey);
    const following = queue.find((r, i) => i > fromIndex && !keys.has(r.key));
    const preceding = [...queue].reverse().find((r) => queue.indexOf(r) < fromIndex && !keys.has(r.key));
    const next = following ?? preceding ?? null;
    if (next) {
      jumpTo(next);
    } else {
      setCurrentKey(null);
    }
  }, [queue, currentKey, jumpTo]);

  const dismiss = (issue: Issue) => resolve(new Set([issue.key]));

  const applyReplacement = (issue: Issue, replacement: string) => {
    if (!editor || editor.isDestroyed) return;
    const span = spanFor(issue);
    if (!span) return;
    // No .focus(): the chip click applies the fix without popping the
    // on-screen keyboard on touch devices.
    editor.chain().setTextSelection(span).insertContent(replacement).run();
    // The doc change re-lints automatically (debounced); resolve the row now
    // so the walk moves on immediately instead of waiting for the recompute.
    resolve(new Set([issue.key]));
  };

  const addToDictionary = (issue: Issue) => {
    const word = issue.text.trim();
    if (!word) return;
    onDictionaryAdd(word);
    // Every queued row flagging this word is resolved at once — it's a known
    // name now.
    const keys = new Set<string>(
      queue
        .filter((r) => r.source === 'spelling' && r.text.trim().toLowerCase() === word.toLowerCase())
        .map((r) => r.key),
    );
    resolve(keys);
  };

  const runClarity = async () => {
    if (!editor || editor.isDestroyed) return;
    setClarityLoading(true);
    setClarityError(null);
    try {
      const issues = await aiClarityPass(editor.state.doc.textContent);
      setClarityIssues(issues);
      setClarityRan(true);
      // Paint the purple squiggles for whatever we can locate.
      const marks = issues
        .map((i) => {
          const loc = locateQuote(editor, i.quote);
          return loc ? { from: loc.from, to: loc.to, message: i.message } : null;
        })
        .filter((m): m is { from: number; to: number; message: string } => m !== null);
      editor.commands.setAiMarks(marks);
    } catch (err) {
      setClarityError(err instanceof Error ? err.message : 'Clarity pass failed');
    } finally {
      setClarityLoading(false);
    }
  };

  return (
    <div className="flex-1 flex min-h-0">
      {/* Manuscript with the anchored issue popup */}
      <div className="flex-1 flex flex-col min-h-0 min-w-0">
        {/* Progress row */}
        <div className="shrink-0 flex items-center gap-3 px-4 sm:px-8 py-3">
          <span className="text-[10px] uppercase tracking-widest font-bold opacity-40 whitespace-nowrap tabular-nums">
            {queue.length === 0
              ? (linted ? (resolvedCount > 0 ? `${resolvedCount} resolved` : 'No issues') : 'Checking…')
              : `Issue ${currentIndex + 1} of ${queue.length}${resolvedCount > 0 ? ` · ${resolvedCount} resolved` : ''}`}
          </span>
          <div className="flex-1 h-1 rounded-full bg-black/5 dark:bg-white/10 overflow-hidden">
            {/* Progress = everything dealt with (resolved) + position in what
                remains, over the session total — resolving visibly advances. */}
            <div
              className="h-full rounded-full bg-blue-500/60 transition-all duration-300"
              style={{
                width: queue.length === 0
                  ? (linted ? '100%' : '0%')
                  : `${((resolvedCount + currentIndex + 1) / (resolvedCount + queue.length)) * 100}%`,
              }}
            />
          </div>
          {relinting && linted && (
            <span className="flex items-center gap-1.5 text-[9px] uppercase tracking-widest font-bold opacity-40 whitespace-nowrap">
              <Loader2 className="w-3 h-3 animate-spin" /> Rechecking
            </span>
          )}
          {aiAvailable && (
            <button
              onClick={runClarity}
              disabled={clarityLoading}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[9px] uppercase font-black tracking-widest transition-all whitespace-nowrap',
                isDarkMode ? 'bg-purple-500/15 text-purple-300 hover:bg-purple-500/25' : 'bg-purple-500/10 text-purple-600 hover:bg-purple-500/20',
                clarityLoading && 'opacity-50 cursor-wait',
              )}
              title="AI reads the chapter and flags wording that may be unclear. It never writes suggestions."
            >
              {clarityLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
              <span className="hidden sm:inline">{clarityRan ? 'Re-run clarity pass' : 'Run clarity pass'}</span>
              <span className="sm:hidden">Clarity</span>
            </button>
          )}
        </div>

        {/* Manuscript text + anchored popup */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 sm:px-8 custom-scrollbar relative">
          <div ref={wrapperRef} className="relative max-w-2xl mx-auto pb-56">
            <h2 className="text-lg font-literata font-semibold opacity-60 mb-6">{chapterLabel}</h2>
            <EditorContent editor={editor} />

            {/* The issue popup, floating right under the flagged line. */}
            <AnimatePresence>
              {current && popupTop != null && (
                <motion.div
                  key={current.key}
                  initial={{ opacity: 0, y: 6, scale: 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 6, scale: 0.98 }}
                  transition={{ duration: 0.15 }}
                  style={{ top: popupTop }}
                  className={cn(
                    'absolute left-1/2 -translate-x-1/2 z-30 w-[min(92%,26rem)] rounded-2xl border shadow-2xl p-4',
                    isDarkMode ? 'bg-[#2b2926] border-white/10 text-[#F1EDE4]' : 'bg-white border-black/10 text-black',
                  )}
                >
                  <div className="flex items-center gap-2 flex-wrap mb-1.5">
                    <span className={cn('px-2 py-0.5 rounded-md text-[9px] uppercase font-black tracking-widest', SOURCE_META[current.source].badge)}>
                      {SOURCE_META[current.source].label}
                    </span>
                    <span className="text-xs font-mono font-bold truncate min-w-0">“{current.text}”</span>
                  </div>
                  <p className="text-[11px] leading-relaxed opacity-70 mb-2.5">{current.message}</p>

                  <div className="flex items-center gap-1.5 flex-wrap">
                    {current.source === 'spelling' && (current.replacements ?? []).map((r) => (
                      <button
                        key={r}
                        onClick={() => applyReplacement(current, r)}
                        className={cn(
                          'px-2.5 py-1.5 rounded-lg text-[11px] font-bold transition-all border',
                          isDarkMode
                            ? 'bg-white/10 border-white/10 hover:bg-white/20'
                            : 'bg-black/5 border-black/10 hover:bg-black/10',
                        )}
                      >
                        {r}
                      </button>
                    ))}
                    {current.source === 'spelling' && (
                      <button
                        onClick={() => addToDictionary(current)}
                        className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-[10px] font-bold border border-transparent opacity-60 hover:opacity-100 hover:bg-black/5 dark:hover:bg-white/5 transition-all"
                        title="Never flag this word again (proper nouns, worldbuilding words)"
                      >
                        <Plus className="w-3 h-3" /> Dictionary
                      </button>
                    )}
                    {current.source === 'clarity' && (
                      <span className="text-[9px] italic opacity-40 basis-full">
                        No rewrite offered — edit the passage in place if you agree.
                      </span>
                    )}
                    <button
                      onClick={() => dismiss(current)}
                      className="px-2 py-1.5 rounded-lg text-[10px] font-bold border border-transparent opacity-60 hover:opacity-100 hover:bg-black/5 dark:hover:bg-white/5 transition-all"
                    >
                      {current.source === 'clarity' ? 'Done' : 'Ignore'}
                    </button>

                    <div className="ml-auto flex items-center gap-1">
                      <button
                        onClick={() => goTo(currentIndex - 1)}
                        disabled={currentIndex === 0}
                        className="p-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-20 transition-all"
                        title="Previous issue (←)"
                      >
                        <ChevronLeft className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => goTo(currentIndex + 1)}
                        disabled={currentIndex >= queue.length - 1}
                        className={cn(
                          'flex items-center gap-1 px-3 py-1.5 rounded-lg text-[10px] uppercase font-black tracking-widest transition-all disabled:opacity-20',
                          isDarkMode ? 'bg-white text-black' : 'bg-black text-white',
                        )}
                        title="Next issue (→ or Enter)"
                      >
                        Next <ChevronRight className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Initial-lint overlay: unmistakable "the checker is working". */}
            {!linted && (
              <div className="absolute inset-0 z-20 flex items-start justify-center pt-24 pointer-events-none">
                <div className={cn(
                  'flex items-center gap-3 px-5 py-3.5 rounded-2xl border shadow-xl',
                  isDarkMode ? 'bg-[#2b2926] border-white/10' : 'bg-white border-black/10',
                )}>
                  <Loader2 className="w-4 h-4 animate-spin opacity-60" />
                  <span className="text-[11px] font-bold uppercase tracking-widest opacity-70">
                    Checking spelling &amp; grammar…
                  </span>
                </div>
              </div>
            )}

            {/* Clean state: floats where the popup would be. */}
            {linted && queue.length === 0 && (
              <div className="sticky bottom-6 z-30 flex justify-center pt-8">
                <div className={cn(
                  'flex items-center gap-3 px-5 py-3.5 rounded-2xl border shadow-xl',
                  isDarkMode ? 'bg-[#2b2926] border-white/10' : 'bg-white border-black/10',
                )}>
                  <CheckCircle2 className="w-5 h-5 text-emerald-500" />
                  <div>
                    <p className="text-xs font-bold">Chapter clean</p>
                    <p className="text-[10px] opacity-40">
                      No {clarityRan ? 'spelling, grammar, or clarity' : 'spelling or grammar'} issues found.
                    </p>
                  </div>
                  {hasNextChapter && (
                    <button
                      onClick={onNextChapter}
                      className={cn(
                        'ml-2 flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-[10px] uppercase font-black tracking-widest transition-all',
                        isDarkMode ? 'bg-white text-black' : 'bg-black text-white',
                      )}
                    >
                      Next chapter <ChevronRight className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>
            )}

            {clarityError && (
              <div className="sticky bottom-2 z-30 flex justify-center">
                <p className="px-4 py-2 rounded-xl bg-red-500/10 border border-red-500/20 text-[10px] text-red-500">{clarityError}</p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Optional issue list panel */}
      {showList && (
        <div className="w-72 shrink-0 border-l border-black/12 dark:border-white/15 overflow-y-auto custom-scrollbar p-3 space-y-4">
          {(['spelling', 'grammar', 'clarity'] as IssueSource[]).map((source) => {
            const rows = queue.filter((r) => r.source === source);
            if (rows.length === 0 && !(source === 'clarity' && clarityRan)) return null;
            return (
              <div key={source}>
                <div className="flex items-center justify-between px-2 mb-1.5">
                  <span className="text-[9px] uppercase tracking-[0.2em] font-bold opacity-40">{SOURCE_META[source].label}</span>
                  <span className="text-[9px] font-mono opacity-30 tabular-nums">{rows.length}</span>
                </div>
                <div className="space-y-1">
                  {rows.map((r) => (
                    <button
                      key={r.key}
                      onClick={() => jumpTo(r)}
                      className={cn(
                        'w-full text-left px-2.5 py-2 rounded-lg transition-colors',
                        r.key === current?.key
                          ? 'bg-blue-500/10'
                          : 'hover:bg-black/5 dark:hover:bg-white/5',
                      )}
                    >
                      <p className="text-[11px] font-mono truncate">“{r.text}”</p>
                      <p className="text-[9px] opacity-40 truncate">{r.message}</p>
                    </button>
                  ))}
                  {rows.length === 0 && (
                    <p className="px-2.5 text-[10px] italic opacity-30">None found.</p>
                  )}
                </div>
              </div>
            );
          })}
          {queue.length === 0 && linted && (
            <p className="px-2 text-[10px] italic opacity-30">Nothing left in this chapter.</p>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dictionary drawer — THE editing surface for the custom dictionary.
// ---------------------------------------------------------------------------

interface DictionaryDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  isDarkMode: boolean;
  onChanged: () => void;
}

function DictionaryDrawer({ isOpen, onClose, isDarkMode, onChanged }: DictionaryDrawerProps) {
  // Re-read on every render while open; the list is tiny.
  const words = listWords();
  const [draft, setDraft] = useState('');

  const add = () => {
    const w = draft.trim();
    if (!w) return;
    addWord(w);
    setDraft('');
    onChanged();
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/40 backdrop-blur-md z-[110]"
          />
          <motion.div
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 26, stiffness: 260 }}
            className={cn(
              'fixed inset-y-0 right-0 w-full sm:w-[380px] z-[111] shadow-2xl flex flex-col p-6 sm:p-8',
              isDarkMode ? 'bg-manuscript-dark text-[#F1EDE4]' : 'bg-manuscript-light text-black',
            )}
          >
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-2">
                <BookMarked className="w-4 h-4 opacity-40" />
                <h3 className="text-sm font-bold uppercase tracking-widest">Dictionary</h3>
                <span className="text-[10px] font-mono opacity-30 tabular-nums">{words.length}</span>
              </div>
              <button onClick={onClose} className="p-2 rounded-xl hover:bg-black/5 dark:hover:bg-white/5 transition-colors">
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-[10px] leading-relaxed opacity-40 mb-4">
              Words here are never flagged as misspellings — anywhere in Chronicle.
              Perfect for character names and worldbuilding terms. Synced to your server.
            </p>

            <div className="flex items-center gap-2 mb-4">
              <input
                type="text"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') add(); }}
                placeholder="Add a word…"
                className={cn(
                  'flex-1 px-3 py-2.5 rounded-xl text-xs bg-black/[0.03] dark:bg-white/[0.08] border border-black/12 dark:border-white/15 focus:border-black/10 dark:focus:border-white/20 outline-none transition-all',
                  isDarkMode ? 'text-white' : 'text-black',
                )}
              />
              <button
                onClick={add}
                disabled={!draft.trim()}
                className={cn(
                  'p-2.5 rounded-xl transition-all disabled:opacity-30',
                  isDarkMode ? 'bg-white text-black' : 'bg-black text-white',
                )}
                title="Add word"
              >
                <Plus className="w-4 h-4" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto custom-scrollbar space-y-1">
              {words.length === 0 && (
                <p className="text-[11px] italic opacity-30 px-1 py-4">
                  Empty. Add words here, or use “Dictionary” on a spelling issue.
                </p>
              )}
              {words.map((w) => (
                <div
                  key={w}
                  className="group flex items-center justify-between px-3 py-2 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                >
                  <span className="text-xs font-mono">{w}</span>
                  <button
                    onClick={() => { removeWord(w); onChanged(); }}
                    className="p-1 rounded opacity-0 group-hover:opacity-40 hover:!opacity-100 hover:text-red-500 transition-all"
                    title={`Remove "${w}"`}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
