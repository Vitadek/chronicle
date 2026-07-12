import React, { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { Book, Plus, Trash2, Clock, BookOpen, User, X, Settings, Upload, SpellCheck } from 'lucide-react';
import { ManuscriptMetadata, Manuscript } from '../types';
import { manuscriptService } from '../services/manuscriptService';
import { loadCoverBlobUrl } from '../services/coverService';
import { cn } from '../lib/utils';
import { formatWordCount } from '../lib/wordCount';
import { ImportDialog } from './ImportDialog';

interface LibraryViewProps {
  onSelectManuscript: (id: string) => void;
  onCreateNew: () => void;
  /** Persist an imported manuscript (server create). Must throw on failure so
   *  the import dialog can show the error instead of a silent success. */
  onImportManuscript: (manuscript: Manuscript) => Promise<void> | void;
  /** Open the manuscript in Proofread mode (guided spelling/grammar/clarity pass). */
  onProofreadManuscript: (id: string) => void;
  onOpenSettings: () => void;
  isDarkMode: boolean;
  /** Bumped by the parent when remote sync has new data. Triggers a refetch. */
  refreshSignal?: number;
}

/**
 * Resolves a stored cover filename into a renderable blob URL.
 * Falls back to a placeholder icon when missing or while loading.
 */
function CoverThumb({ filename, className }: { filename?: string; className?: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!filename) {
      setUrl(null);
      return;
    }
    loadCoverBlobUrl(filename).then((u) => {
      if (!cancelled) setUrl(u);
    });
    return () => { cancelled = true; };
  }, [filename]);

  if (url) {
    return (
      <img
        src={url}
        alt="Cover"
        className={cn("object-cover rounded-2xl shadow-md", className)}
      />
    );
  }
  return (
    <div className={cn("rounded-2xl bg-current/5 flex items-center justify-center", className)}>
      <BookOpen className="w-5 h-5 opacity-40" />
    </div>
  );
}

export function LibraryView({ onSelectManuscript, onCreateNew, onImportManuscript, onProofreadManuscript, onOpenSettings, isDarkMode, refreshSignal }: LibraryViewProps) {
  const [manuscripts, setManuscripts] = useState<ManuscriptMetadata[]>([]);
  const [loading, setLoading] = useState(true);
  const [showImportDialog, setShowImportDialog] = useState(false);
  // Two-step delete confirmation. The native confirm() dialog feels jarring
  // against this UI, and on touch devices an opacity-0 hover-only trash icon
  // is functionally invisible.
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  useEffect(() => {
    loadLibrary();
  }, [refreshSignal]);

  const loadLibrary = async () => {
    try {
      const list = await manuscriptService.list();
      setManuscripts(list.sort((a, b) => b.lastModified - a.lastModified));
    } catch (error) {
      console.error(error);
    } finally {
      setLoading(false);
    }
  };

  const handleConfirmDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    try {
      await manuscriptService.delete(id);
      setConfirmDeleteId(null);
      await loadLibrary();
    } catch (error) {
      console.error(error);
      alert('Failed to delete manuscript');
    }
  };

  /**
   * Persist an imported manuscript (parsing happened in the dialog via
   * src/lib/importService.ts), then refresh the shelf so it appears behind
   * the dialog's success screen. Rethrows so the dialog can show failures.
   */
  const handleImported = async (manuscript: Manuscript) => {
    await onImportManuscript(manuscript);
    await loadLibrary();
  };

  return (
    <div className={cn(
      "min-h-screen-dvh w-full flex flex-col items-center py-12 sm:py-24 px-4 sm:px-6 overflow-x-hidden",
      isDarkMode ? "bg-manuscript-dark text-[#F1EDE4]" : "bg-manuscript-light text-black"
    )}>
      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-5xl"
      >
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between mb-10 sm:mb-16 border-b border-black/10 dark:border-white/10 pb-6 sm:pb-8 gap-6 sm:gap-4">
          <div>
            <h1 className="text-3xl sm:text-4xl font-serif mb-1 sm:mb-2">The Library</h1>
            <p className="text-[10px] sm:text-xs uppercase tracking-[0.2em] opacity-40 font-bold">Your Collected Manuscripts</p>
          </div>
          
          <div className="flex items-center flex-wrap gap-2 sm:gap-4 w-full sm:w-auto">
            <button 
              onClick={onOpenSettings}
              className={cn(
                "p-2.5 sm:p-3 rounded-xl sm:rounded-2xl transition-all hover:bg-black/5 dark:hover:bg-white/5",
                isDarkMode ? "text-[#F1EDE4]/60 hover:text-[#F1EDE4]" : "text-black/60 hover:text-black"
              )}
              title="Global Settings"
            >
              <Settings className="w-5 h-5 sm:w-6 sm:h-6" />
            </button>

            <button
              onClick={() => setShowImportDialog(true)}
              className={cn(
                "flex flex-1 sm:flex-none items-center justify-center gap-2 sm:gap-3 px-4 sm:px-6 py-2.5 sm:py-3 rounded-xl sm:rounded-2xl transition-all border border-black/10 dark:border-white/10 hover:bg-black/5 dark:hover:bg-white/5",
                isDarkMode ? "text-[#F1EDE4]" : "text-black"
              )}
            >
              <Upload className="w-4 h-4 sm:w-5 sm:h-5" />
              <span className="text-[10px] sm:text-xs uppercase tracking-widest font-bold">Import</span>
            </button>

            <button 
              onClick={onCreateNew}
              className={cn(
                "flex flex-1 sm:flex-none items-center justify-center gap-2 sm:gap-3 px-4 sm:px-6 py-2.5 sm:py-3 rounded-xl sm:rounded-2xl transition-all shadow-xl hover:scale-[1.02] active:scale-[0.98]",
                isDarkMode ? "bg-[#F1EDE4] text-black" : "bg-black text-white"
              )}
            >
              <Plus className="w-4 h-4 sm:w-5 sm:h-5" />
              <span className="text-[10px] sm:text-xs uppercase tracking-widest font-bold text-nowrap">New Work</span>
            </button>
          </div>
        </div>

        {loading ? (
          <div className="flex flex-col items-center justify-center py-24 animate-pulse">
            <BookOpen className="w-8 h-8 opacity-10 mb-4" />
            <p className="text-[10px] uppercase tracking-widest opacity-20 font-bold">Recalling Manuscripts...</p>
          </div>
        ) : manuscripts.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-center px-6">
            <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-full bg-black/5 dark:bg-white/5 flex items-center justify-center mb-8 mx-auto">
              <Book className="w-6 h-6 sm:w-8 sm:h-8 opacity-20" />
            </div>
            <h2 className="text-xl font-serif mb-4">Your library is currently empty</h2>
            <p className="text-xs opacity-40 mb-10 max-w-sm mx-auto leading-relaxed">
              Every great story begins with a single page. Start your next journey by creating a new manuscript.
            </p>
            <button 
              onClick={onCreateNew}
              className="text-xs uppercase tracking-widest font-bold border-b border-black/20 dark:border-white/20 pb-1 hover:opacity-100 opacity-60 transition-opacity"
            >
              Begin a New Work
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 sm:gap-8">
            {manuscripts.map((m) => {
              const isConfirming = confirmDeleteId === m.id;
              return (
                <motion.div
                  key={m.id}
                  layoutId={m.id}
                  onClick={() => {
                    if (isConfirming) return;
                    onSelectManuscript(m.id);
                  }}
                  className={cn(
                    "group relative p-6 sm:p-8 rounded-2xl sm:rounded-3xl border cursor-pointer transition-all hover:shadow-2xl overflow-hidden",
                    isConfirming
                      ? "border-red-500/30 bg-red-500/5"
                      : "border-black/5 dark:border-white/5",
                    !isConfirming && (isDarkMode ? "hover:bg-white/5" : "hover:bg-black/5"),
                  )}
                >
                  <div className="flex flex-col h-full relative z-10">
                    <div className="flex items-start justify-between mb-6 sm:mb-8">
                      <CoverThumb filename={m.coverArt} className="w-10 h-14 sm:w-12 sm:h-16 shrink-0" />
                      {isConfirming ? (
                        <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                          <button
                            onClick={(e) => handleConfirmDelete(e, m.id)}
                            className="px-3 py-1.5 bg-red-500 text-white text-[9px] sm:text-[10px] font-bold uppercase tracking-widest rounded-lg hover:bg-red-600 transition-colors"
                          >
                            Delete
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setConfirmDeleteId(null);
                            }}
                            className="p-1.5 rounded-lg hover:bg-black/10 dark:hover:bg-white/10 transition-colors"
                            aria-label="Cancel"
                          >
                            <X className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                          </button>
                        </div>
                      ) : (
                        <div className="flex items-center">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              onProofreadManuscript(m.id);
                            }}
                            className="p-2 opacity-40 hover:opacity-100 hover:text-blue-500 transition-all"
                            aria-label="Proofread manuscript"
                            title="Proofread — guided spelling, grammar & clarity pass"
                          >
                            <SpellCheck className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setConfirmDeleteId(m.id);
                            }}
                            className="p-2 opacity-40 hover:opacity-100 hover:text-red-500 transition-all"
                            aria-label="Delete manuscript"
                          >
                            <Trash2 className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                          </button>
                        </div>
                      )}
                    </div>

                    <h3 className="text-lg sm:text-xl font-literata font-semibold normal-case mb-2 line-clamp-2 leading-tight">{m.title || 'Untitled Manuscript'}</h3>
                    <div className="flex items-center gap-2 mb-6 sm:mb-8 opacity-40">
                      <User className="w-3 h-3" />
                      <span className="text-[9px] sm:text-[10px] uppercase font-bold tracking-widest truncate">{m.author || 'Anonymous'}</span>
                    </div>

                    <div className="mt-auto pt-5 sm:pt-6 border-t border-black/5 dark:border-white/5 flex items-center justify-between">
                      <div className="flex items-center gap-2 opacity-30 text-[8px] sm:text-[9px] uppercase font-bold tracking-widest">
                        <Clock className="w-3 h-3" />
                        <span>{new Date(m.lastModified).toLocaleDateString()}</span>
                      </div>
                      
                      {!!m.wordCount && (
                        <span className="text-[8px] sm:text-[9px] uppercase font-bold tracking-widest opacity-30">
                          {formatWordCount(m.wordCount)} Words
                        </span>
                      )}
                    </div>
                  </div>
                </motion.div>
              );
            })}
          </div>
        )}
      </motion.div>

      {/* Decorative background elements */}
      <div className="fixed inset-0 pointer-events-none opacity-[0.03] dark:opacity-[0.05] z-[-1]">
        <div className="absolute inset-0 bg-[url('https://www.transparenttextures.com/patterns/natural-paper.png')]" />
      </div>

      <ImportDialog
        isOpen={showImportDialog}
        onClose={() => setShowImportDialog(false)}
        isDarkMode={isDarkMode}
        onImportManuscript={handleImported}
        onOpenManuscript={onSelectManuscript}
      />
    </div>
  );
}
