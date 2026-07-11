import React, { useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, Layout, Check, FileArchive, FileText, Settings2 } from 'lucide-react';
import { cn } from '../lib/utils';
import { Chapter, ExportSettings } from '../types';
import { MarkdownFrontMatterFields } from './MarkdownFrontMatterFields';

type MarkdownSettings = ExportSettings['markdown'];

interface MarkdownExportDialogProps {
  isOpen: boolean;
  onClose: () => void;
  isDarkMode: boolean;
  /** Full, ordered chapter list. Position (index + 1) is the Hugo weight. */
  chapters: Chapter[];
  /** Saved Markdown/front-matter defaults. When `promptBeforeExport` is set,
   *  the dialog shows an editable copy so they can be tweaked per export. */
  markdownSettings: MarkdownSettings;
  /** Fired with the selected chapter ids (in manuscript order) and the
   *  front-matter settings to use for this export (edited copy, or the
   *  defaults unchanged when the per-export editor is off). */
  onExport: (selectedIds: string[], markdown: MarkdownSettings) => void;
}

/**
 * Chapter picker for Markdown export. One selected chapter downloads a single
 * `.md`; two or more download a `.zip` of one Markdown file per chapter — the
 * shape a Hugo section expects, each file carrying its own front matter and a
 * `weight` equal to the chapter's number so pages sort in reading order.
 *
 * When the saved settings have `promptBeforeExport` on, an editable front-matter
 * section is shown so the fields can be overridden for this one export without
 * touching the saved defaults.
 */
export const MarkdownExportDialog: React.FC<MarkdownExportDialogProps> = ({
  isOpen,
  onClose,
  isDarkMode,
  chapters,
  markdownSettings,
  onExport,
}) => {
  // Default to all chapters selected — the common case is "export the book".
  const [selected, setSelected] = useState<Set<string>>(() => new Set(chapters.map((c) => c.id)));
  // Per-export, editable copy of the front-matter settings (only surfaced when
  // promptBeforeExport is on). Re-seeded from the saved defaults each open.
  const [mdOverride, setMdOverride] = useState<MarkdownSettings>(markdownSettings);

  // Re-seed when the dialog is (re)opened or the chapter set changes, so a
  // newly added chapter isn't silently excluded on the next open.
  useEffect(() => {
    if (isOpen) {
      setSelected(new Set(chapters.map((c) => c.id)));
      setMdOverride(markdownSettings);
    }
  }, [isOpen, chapters, markdownSettings]);

  // Escape closes, matching the rest of the app's dismissible surfaces.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  const count = selected.size;
  const allSelected = count === chapters.length && count > 0;

  const orderedSelectedIds = useMemo(
    () => chapters.filter((c) => selected.has(c.id)).map((c) => c.id),
    [chapters, selected],
  );

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const selectAll = () => setSelected(new Set(chapters.map((c) => c.id)));
  const clear = () => setSelected(new Set());

  const showFrontMatter = markdownSettings.promptBeforeExport;

  const handleExport = () => {
    if (count === 0) return;
    onExport(orderedSelectedIds, showFrontMatter ? mdOverride : markdownSettings);
    onClose();
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
          <div className="fixed inset-0 z-[111] flex items-center justify-center p-4 pointer-events-none">
            <motion.div
              initial={{ opacity: 0, scale: 0.96, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 8 }}
              transition={{ type: 'spring', damping: 26, stiffness: 260 }}
              className={cn(
                'pointer-events-auto w-full max-w-md rounded-3xl shadow-2xl border flex flex-col max-h-[80vh] overflow-hidden',
                isDarkMode ? 'bg-[#232220] text-white border-white/10' : 'bg-[#fdfbf7] text-black border-black/10',
              )}
            >
              {/* Header */}
              <div className="flex items-start justify-between px-6 pt-6 pb-4">
                <div className="flex items-center gap-3">
                  <Layout className="w-5 h-5 opacity-50" />
                  <div>
                    <h3 className="text-sm font-bold uppercase tracking-widest">Export Markdown</h3>
                    <p className="text-[10px] opacity-40 mt-1 leading-relaxed">
                      One chapter &rarr; a single .md. Multiple &rarr; a .zip of one file per chapter.
                    </p>
                  </div>
                </div>
                <button
                  onClick={onClose}
                  className="p-1.5 -mr-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Select-all row */}
              <div className="flex items-center justify-between px-6 py-2 border-y border-black/5 dark:border-white/5">
                <span className="text-[10px] uppercase tracking-widest font-bold opacity-40">
                  {count} of {chapters.length} selected
                </span>
                <button
                  onClick={allSelected ? clear : selectAll}
                  className="text-[10px] uppercase tracking-widest font-black opacity-60 hover:opacity-100 transition-opacity"
                >
                  {allSelected ? 'Clear' : 'Select all'}
                </button>
              </div>

              {/* Chapter list */}
              <div className="flex-1 overflow-y-auto px-3 py-3 custom-scrollbar">
                {chapters.length === 0 && (
                  <p className="text-[11px] opacity-40 italic px-3 py-6 text-center">No chapters to export.</p>
                )}
                {chapters.map((chapter, i) => {
                  const isChecked = selected.has(chapter.id);
                  return (
                    <button
                      key={chapter.id}
                      onClick={() => toggle(chapter.id)}
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
                            : isDarkMode
                              ? 'border-white/25'
                              : 'border-black/20',
                        )}
                      >
                        {isChecked && <Check className="w-3 h-3 text-white" strokeWidth={3} />}
                      </div>
                      <span className="text-[10px] font-mono opacity-30 tabular-nums w-6 shrink-0">
                        {String(i + 1).padStart(2, '0')}
                      </span>
                      <span className="text-xs truncate flex-1">{chapter.title || 'Untitled'}</span>
                    </button>
                  );
                })}
              </div>

              {/* Per-export front-matter editor (only when enabled in settings) */}
              {showFrontMatter && (
                <div className="shrink-0 max-h-[40vh] overflow-y-auto border-t border-black/5 dark:border-white/5 px-6 py-4 space-y-5 custom-scrollbar">
                  <div className="flex items-center gap-2 text-[10px] uppercase tracking-widest font-bold opacity-40">
                    <Settings2 className="w-3 h-3" />
                    <span>Front matter · this export</span>
                  </div>
                  <MarkdownFrontMatterFields
                    value={mdOverride}
                    onChange={(patch) => setMdOverride((prev) => ({ ...prev, ...patch }))}
                    isDarkMode={isDarkMode}
                  />
                </div>
              )}

              {/* Footer */}
              <div className="flex items-center gap-3 px-6 py-4 border-t border-black/5 dark:border-white/5">
                <button
                  onClick={onClose}
                  className={cn(
                    'flex-1 px-4 py-3 rounded-xl text-[10px] uppercase font-black tracking-widest transition-all',
                    isDarkMode ? 'bg-white/5 hover:bg-white/10' : 'bg-black/5 hover:bg-black/10',
                  )}
                >
                  Cancel
                </button>
                <button
                  onClick={handleExport}
                  disabled={count === 0}
                  className={cn(
                    'flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-[10px] uppercase font-black tracking-widest transition-all shadow-lg',
                    count === 0
                      ? 'opacity-30 cursor-not-allowed bg-black/10 dark:bg-white/10'
                      : isDarkMode
                        ? 'bg-white text-black hover:scale-[1.02] active:scale-95'
                        : 'bg-black text-white hover:scale-[1.02] active:scale-95',
                  )}
                >
                  {count > 1 ? <FileArchive className="w-3.5 h-3.5" /> : <FileText className="w-3.5 h-3.5" />}
                  {count > 1 ? `Export .zip (${count})` : 'Export .md'}
                </button>
              </div>
            </motion.div>
          </div>
        </>
      )}
    </AnimatePresence>
  );
};
