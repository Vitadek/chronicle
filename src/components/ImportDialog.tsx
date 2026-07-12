import React, { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, Upload, Loader2, CheckCircle2, XCircle, Info, AlertTriangle, BookOpen, FileText } from 'lucide-react';
import { cn } from '../lib/utils';
import { Manuscript } from '../types';
import type { ImportLogEntry } from '../lib/importService';

interface ImportDialogProps {
  isOpen: boolean;
  onClose: () => void;
  isDarkMode: boolean;
  /** Persist the parsed manuscript (App creates it server-side). Throws on failure. */
  onImportManuscript: (manuscript: Manuscript) => Promise<void> | void;
  /** Open the freshly imported manuscript in the editor. */
  onOpenManuscript: (id: string) => void;
}

type Phase =
  | { name: 'pick' }
  | { name: 'busy'; filename: string }
  | { name: 'done'; manuscript: Manuscript; log: ImportLogEntry[] }
  | { name: 'failed'; error: string; log: ImportLogEntry[] };

/**
 * Import flow: explains what Chronicle can ingest and how chapters are
 * detected, runs the parser, then reports success (with a log of what was
 * decided) or failure (with why). Parsing lives in src/lib/importService.ts,
 * dynamic-imported so mammoth/jszip stay out of the main bundle.
 */
export const ImportDialog: React.FC<ImportDialogProps> = ({
  isOpen,
  onClose,
  isDarkMode,
  onImportManuscript,
  onOpenManuscript,
}) => {
  const [phase, setPhase] = useState<Phase>({ name: 'pick' });
  // "Never show again" for the format explanation. Persisted; a small link
  // brings it back (which also clears the preference — it's a plain toggle).
  const [hideHelp, setHideHelp] = useState(() => {
    return localStorage.getItem('chronicle_import_help_hidden') === 'true';
  });
  const toggleHelp = () => {
    setHideHelp((prev) => {
      localStorage.setItem('chronicle_import_help_hidden', String(!prev));
      return !prev;
    });
  };
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Fresh start each open; Escape closes (except mid-import).
  useEffect(() => {
    if (isOpen) setPhase({ name: 'pick' });
  }, [isOpen]);
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && phase.name !== 'busy') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen, phase.name, onClose]);

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (!file) return;

    setPhase({ name: 'busy', filename: file.name });
    try {
      const { importManuscriptFile, ImportError } = await import('../lib/importService');
      try {
        const { manuscript, log } = await importManuscriptFile(file);
        await onImportManuscript(manuscript);
        setPhase({ name: 'done', manuscript, log });
      } catch (err) {
        if (err instanceof ImportError) {
          setPhase({ name: 'failed', error: err.message, log: err.log });
        } else {
          setPhase({
            name: 'failed',
            error: err instanceof Error ? err.message : 'Import failed for an unknown reason.',
            log: [],
          });
        }
      }
    } catch {
      setPhase({ name: 'failed', error: 'Could not load the import module. Check your connection and retry.', log: [] });
    }
  };

  const LogList = ({ log }: { log: ImportLogEntry[] }) => (
    <div className="space-y-1.5 rounded-xl bg-black/[0.04] dark:bg-white/[0.05] p-3 max-h-40 overflow-y-auto custom-scrollbar">
      {log.map((entry, i) => (
        <div key={i} className="flex items-start gap-2 text-[10px] leading-relaxed">
          {entry.level === 'error' ? (
            <XCircle className="w-3 h-3 mt-0.5 shrink-0 text-red-500" />
          ) : entry.level === 'warn' ? (
            <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0 text-amber-500" />
          ) : (
            <Info className="w-3 h-3 mt-0.5 shrink-0 opacity-40" />
          )}
          <span className={cn(entry.level === 'error' ? 'text-red-500' : entry.level === 'warn' ? 'opacity-80' : 'opacity-60')}>
            {entry.message}
          </span>
        </div>
      ))}
    </div>
  );

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={phase.name === 'busy' ? undefined : onClose}
            className="fixed inset-0 bg-black/40 backdrop-blur-md z-[110]"
          />
          <div className="fixed inset-0 z-[111] flex items-center justify-center p-4 pointer-events-none">
            <motion.div
              initial={{ opacity: 0, scale: 0.96, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 8 }}
              transition={{ type: 'spring', damping: 26, stiffness: 260 }}
              className={cn(
                'pointer-events-auto w-full max-w-lg rounded-3xl shadow-2xl border flex flex-col max-h-[85vh] overflow-hidden',
                isDarkMode ? 'bg-[#232220] text-white border-white/10' : 'bg-[#fdfbf7] text-black border-black/10',
              )}
            >
              {/* Header */}
              <div className="flex items-start justify-between px-6 pt-6 pb-4 shrink-0">
                <div className="flex items-center gap-3">
                  <Upload className="w-5 h-5 opacity-50" />
                  <div>
                    <h3 className="text-sm font-bold uppercase tracking-widest">Import Manuscript</h3>
                    <p className="text-[10px] opacity-40 mt-1">.docx · Markdown · HTML · zip of Markdown</p>
                  </div>
                </div>
                {phase.name !== 'busy' && (
                  <button onClick={onClose} className="p-1.5 -mr-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 transition-colors">
                    <X className="w-4 h-4" />
                  </button>
                )}
              </div>

              <div className="px-6 pb-6 overflow-y-auto custom-scrollbar">
                {phase.name === 'pick' && (
                  <div className="space-y-5">
                    {!hideHelp ? (
                      <div className="space-y-3 text-[11px] leading-relaxed">
                        <p className="text-[10px] uppercase tracking-widest font-bold opacity-40">How chapters are detected</p>
                        <Row title="Word (.docx)">
                          Each <b>Heading 1/2</b> starts a new chapter; the heading text becomes the chapter title.
                          Contact lines and word counts before the first heading are skipped. No headings → one big chapter.
                        </Row>
                        <Row title="Markdown (.md)">
                          <code>## Headings</code> split chapters. Chronicle's own exports round-trip: YAML front matter
                          (title, author), <code># Title</code> and <code>By Author</code> lines are all recognized.
                        </Row>
                        <Row title="HTML (.html)">
                          Chronicle HTML exports import back exactly. Other HTML splits on <code>&lt;h1&gt;/&lt;h2&gt;</code> headings.
                        </Row>
                        <Row title="Zip of Markdown (.zip)">
                          Chronicle's multi-chapter Markdown export — each .md file becomes one chapter, in filename order.
                        </Row>
                        <p className="opacity-40 italic text-[10px]">
                          EPUB can't be imported — it's a one-way export. Bring the same book in as .docx, .md, or .html instead.
                        </p>

                        <button
                          onClick={toggleHelp}
                          className="flex items-center gap-2 pt-1 group text-left"
                        >
                          <span className={cn(
                            'w-3.5 h-3.5 rounded border flex items-center justify-center transition-all',
                            isDarkMode ? 'border-white/25 group-hover:border-white/50' : 'border-black/20 group-hover:border-black/40',
                          )} />
                          <span className="text-[10px] opacity-40 group-hover:opacity-70 transition-opacity">
                            Never show this explanation again
                          </span>
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={toggleHelp}
                        className="text-[10px] opacity-30 hover:opacity-70 transition-opacity underline underline-offset-2"
                      >
                        Show format help
                      </button>
                    )}

                    <input
                      type="file"
                      ref={fileInputRef}
                      onChange={handleFile}
                      accept=".docx,.md,.markdown,.html,.htm,.zip"
                      className="hidden"
                    />
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      className={cn(
                        'w-full flex items-center justify-center gap-2 px-4 py-3.5 rounded-xl text-[10px] uppercase font-black tracking-widest transition-all shadow-lg hover:scale-[1.01] active:scale-95',
                        isDarkMode ? 'bg-white text-black' : 'bg-black text-white',
                      )}
                    >
                      <FileText className="w-4 h-4" />
                      Choose a file
                    </button>
                  </div>
                )}

                {phase.name === 'busy' && (
                  <div className="flex flex-col items-center gap-4 py-10">
                    <Loader2 className="w-6 h-6 animate-spin opacity-60" />
                    <p className="text-[11px] opacity-60">Importing {phase.filename}…</p>
                  </div>
                )}

                {phase.name === 'done' && (
                  <div className="space-y-4">
                    <div className="flex items-center gap-3">
                      <CheckCircle2 className="w-6 h-6 text-emerald-500 shrink-0" />
                      <div className="min-w-0">
                        <p className="text-sm font-bold truncate">“{phase.manuscript.metadata.title}”</p>
                        <p className="text-[10px] opacity-50">
                          {phase.manuscript.chapters.length} chapter{phase.manuscript.chapters.length === 1 ? '' : 's'} imported
                          {phase.manuscript.metadata.author ? ` · by ${phase.manuscript.metadata.author}` : ''}
                        </p>
                      </div>
                    </div>
                    <LogList log={phase.log} />
                    <div className="flex items-center gap-3">
                      <button
                        onClick={onClose}
                        className={cn(
                          'flex-1 px-4 py-3 rounded-xl text-[10px] uppercase font-black tracking-widest transition-all',
                          isDarkMode ? 'bg-white/5 hover:bg-white/10' : 'bg-black/5 hover:bg-black/10',
                        )}
                      >
                        Stay in library
                      </button>
                      <button
                        onClick={() => {
                          onClose();
                          onOpenManuscript(phase.manuscript.metadata.id);
                        }}
                        className={cn(
                          'flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-[10px] uppercase font-black tracking-widest transition-all shadow-lg hover:scale-[1.02] active:scale-95',
                          isDarkMode ? 'bg-white text-black' : 'bg-black text-white',
                        )}
                      >
                        <BookOpen className="w-3.5 h-3.5" />
                        Open it
                      </button>
                    </div>
                  </div>
                )}

                {phase.name === 'failed' && (
                  <div className="space-y-4">
                    <div className="flex items-start gap-3">
                      <XCircle className="w-6 h-6 text-red-500 shrink-0" />
                      <div>
                        <p className="text-sm font-bold">Import failed</p>
                        <p className="text-[11px] opacity-70 leading-relaxed mt-1">{phase.error}</p>
                      </div>
                    </div>
                    {phase.log.length > 0 && <LogList log={phase.log} />}
                    <button
                      onClick={() => setPhase({ name: 'pick' })}
                      className={cn(
                        'w-full px-4 py-3 rounded-xl text-[10px] uppercase font-black tracking-widest transition-all',
                        isDarkMode ? 'bg-white/10 hover:bg-white/20' : 'bg-black/5 hover:bg-black/10',
                      )}
                    >
                      Try another file
                    </button>
                  </div>
                )}
              </div>
            </motion.div>
          </div>
        </>
      )}
    </AnimatePresence>
  );
};

/** Format-explainer row: bold label + description. */
const Row: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className="flex gap-3">
    <span className="font-bold shrink-0 w-28 opacity-70">{title}</span>
    <span className="opacity-60">{children}</span>
  </div>
);
