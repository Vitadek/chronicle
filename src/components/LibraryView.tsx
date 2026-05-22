import React, { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { Book, Plus, Trash2, Clock, BookOpen, User, X, Settings } from 'lucide-react';
import { ManuscriptMetadata } from '../types';
import { manuscriptService } from '../services/manuscriptService';
import { loadCoverBlobUrl } from '../services/coverService';
import { cn } from '../lib/utils';
import { formatWordCount } from '../lib/wordCount';

interface LibraryViewProps {
  onSelectManuscript: (id: string) => void;
  onCreateNew: () => void;
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

export function LibraryView({ onSelectManuscript, onCreateNew, onOpenSettings, isDarkMode, refreshSignal }: LibraryViewProps) {
  const [manuscripts, setManuscripts] = useState<ManuscriptMetadata[]>([]);
  const [loading, setLoading] = useState(true);
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

  return (
    <div className={cn(
      "min-h-screen w-full flex flex-col items-center py-24 px-6",
      isDarkMode ? "bg-manuscript-dark text-[#F1EDE4]" : "bg-manuscript-light text-black"
    )}>
      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-5xl"
      >
        <div className="flex items-center justify-between mb-16 border-b border-current/10 pb-8">
          <div>
            <h1 className="text-4xl font-serif italic mb-2">The Library</h1>
            <p className="text-xs uppercase tracking-[0.2em] opacity-40 font-bold">Your Collected Manuscripts</p>
          </div>
          
          <div className="flex items-center gap-4">
            <button 
              onClick={onOpenSettings}
              className={cn(
                "p-3 rounded-2xl transition-all hover:bg-current/5",
                isDarkMode ? "text-[#F1EDE4]/60 hover:text-[#F1EDE4]" : "text-black/60 hover:text-black"
              )}
              title="Global Settings"
            >
              <Settings className="w-6 h-6" />
            </button>
            <button 
              onClick={onCreateNew}
              className={cn(
                "flex items-center gap-3 px-6 py-3 rounded-2xl transition-all shadow-xl hover:scale-[1.02] active:scale-[0.98]",
                isDarkMode ? "bg-[#F1EDE4] text-black" : "bg-black text-white"
              )}
            >
              <Plus className="w-5 h-5" />
              <span className="text-xs uppercase tracking-widest font-bold">New Manuscript</span>
            </button>
          </div>
        </div>

        {loading ? (
          <div className="flex flex-col items-center justify-center py-24 animate-pulse">
            <BookOpen className="w-8 h-8 opacity-10 mb-4" />
            <p className="text-[10px] uppercase tracking-widest opacity-20 font-bold">Recalling Manuscripts...</p>
          </div>
        ) : manuscripts.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <div className="w-20 h-20 rounded-full bg-current/5 flex items-center justify-center mb-8">
              <Book className="w-8 h-8 opacity-20" />
            </div>
            <h2 className="text-xl font-serif italic mb-4">Your library is currently empty</h2>
            <p className="text-xs opacity-40 mb-10 max-w-sm leading-relaxed">
              Every great story begins with a single page. Start your next journey by creating a new manuscript.
            </p>
            <button 
              onClick={onCreateNew}
              className="text-xs uppercase tracking-widest font-bold border-b border-current/20 pb-1 hover:opacity-100 opacity-60 transition-opacity"
            >
              Begin a New Work
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
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
                    "group relative p-8 rounded-3xl border cursor-pointer transition-all hover:shadow-2xl",
                    isConfirming
                      ? "border-red-500/30 bg-red-500/5"
                      : "border-current/5",
                    !isConfirming && (isDarkMode ? "hover:bg-white/5" : "hover:bg-black/5"),
                  )}
                >
                  <div className="flex flex-col h-full">
                    <div className="flex items-start justify-between mb-8">
                      <CoverThumb filename={m.coverArt} className="w-12 h-16 shrink-0" />
                      {isConfirming ? (
                        <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                          <button
                            onClick={(e) => handleConfirmDelete(e, m.id)}
                            className="px-3 py-1.5 bg-red-500 text-white text-[10px] font-bold uppercase tracking-widest rounded-lg hover:bg-red-600 transition-colors"
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
                            <X className="w-4 h-4" />
                          </button>
                        </div>
                      ) : (
                        // Always visible (opacity-40), darkens on hover. The
                        // previous opacity-0/group-hover pattern hid this
                        // entirely on touch devices.
                        <button 
                          onClick={(e) => {
                            e.stopPropagation();
                            setConfirmDeleteId(m.id);
                          }}
                          className="p-2 opacity-40 hover:opacity-100 hover:text-red-500 transition-all"
                          aria-label="Delete manuscript"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </div>

                    <h3 className="text-xl font-serif italic mb-2 line-clamp-2">{m.title}</h3>
                    <div className="flex items-center gap-2 mb-8 opacity-40">
                      <User className="w-3 h-3" />
                      <span className="text-[10px] uppercase font-bold tracking-widest">{m.author || 'Anonymous'}</span>
                    </div>

                    <div className="mt-auto pt-6 border-t border-current/5 flex items-center justify-between">
                      <div className="flex items-center gap-2 opacity-30 text-[9px] uppercase font-bold tracking-widest">
                        <Clock className="w-3 h-3" />
                        <span>{new Date(m.lastModified).toLocaleDateString()}</span>
                      </div>
                      
                      {!!m.wordCount && (
                        <span className="text-[9px] uppercase font-bold tracking-widest opacity-30">
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
        <div className="absolute inset-0 bg-[url('https://www.transparenttextures.com/patterns/natural-paper.png')] dark:invert" />
      </div>
    </div>
  );
}
