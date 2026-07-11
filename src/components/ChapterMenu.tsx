import React, { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { MoreVertical, Download, FileText, Layout, Copy, Trash2 } from 'lucide-react';
import { cn } from '../lib/utils';

interface ChapterMenuProps {
  isDarkMode: boolean;
  /** Notifies the parent row when the menu opens/closes so it can raise its
   *  stacking order above sibling rows (the dropdown overflows onto them). */
  onOpenChange?: (open: boolean) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onExportDocx: () => void;
  onExportMarkdown: () => void;
  onExportHtml: () => void;
}

/**
 * Per-chapter action menu — opens off the kebab icon in the chapter row.
 *
 * Lives entirely in this component because it has its own open/close state,
 * outside-click detection, and three export options that the existing row
 * was too cramped to surface inline. Hover/focus on the kebab reveals the
 * trigger; clicking opens a pop-down panel anchored to the row's right edge.
 */
export const ChapterMenu: React.FC<ChapterMenuProps> = ({
  isDarkMode,
  onOpenChange,
  onDuplicate,
  onDelete,
  onExportDocx,
  onExportMarkdown,
  onExportHtml,
}) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Keep the parent row in sync with open/close so it can lift its z-index.
  useEffect(() => {
    onOpenChange?.(open);
  }, [open]);

  // Outside-click + Escape both close the menu. Without this the menu would
  // stay open after the user clicked away, which collides with the rest of
  // the chapter list's click handlers.
  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [open]);

  const handle = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    setOpen(false);
    fn();
  };

  return (
    <div ref={ref} className="relative">
      <button
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className={cn(
          'p-1 rounded transition-all',
          open
            ? 'opacity-100 bg-black/5 dark:bg-white/5'
            : 'opacity-0 group-hover:opacity-40 hover:opacity-100 touch:opacity-60',
        )}
        title="More actions"
      >
        <MoreVertical className="w-3.5 h-3.5" />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98 }}
            transition={{ duration: 0.12 }}
            className={cn(
              // Solid, elevated surface. Uses dark: variants (not the JS prop) so it
              // tracks the real theme, and an opaque fill that stands clearly apart
              // from the app background — never see-through.
              'absolute right-0 top-full mt-1 w-56 rounded-xl shadow-2xl border z-50 overflow-hidden',
              'bg-white text-[#1A1A1A] border-black/10',
              'dark:bg-[#38352F] dark:text-[#F1EDE4] dark:border-white/15',
            )}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="py-1">
              <div className={cn(
                'px-3 py-1.5 text-[9px] uppercase tracking-widest font-bold opacity-40',
              )}>
                Export this chapter
              </div>
              <MenuItem icon={Download} label="Manuscript (.docx)" onClick={handle(onExportDocx)} isDarkMode={isDarkMode} />
              <MenuItem icon={Layout} label="Markdown (.md)" onClick={handle(onExportMarkdown)} isDarkMode={isDarkMode} />
              <MenuItem icon={FileText} label="HTML (.html)" onClick={handle(onExportHtml)} isDarkMode={isDarkMode} />

              <div className={cn(
                'my-1 border-t',
                isDarkMode ? 'border-white/5' : 'border-black/5',
              )} />

              <MenuItem icon={Copy} label="Duplicate" onClick={handle(onDuplicate)} isDarkMode={isDarkMode} />
              <MenuItem icon={Trash2} label="Delete" onClick={handle(onDelete)} isDarkMode={isDarkMode} danger />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

interface MenuItemProps {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  onClick: (e: React.MouseEvent) => void;
  isDarkMode: boolean;
  danger?: boolean;
}

const MenuItem: React.FC<MenuItemProps> = ({ icon: Icon, label, onClick, isDarkMode, danger }) => (
  <button
    onClick={onClick}
    className={cn(
      'w-full flex items-center gap-2.5 px-3 py-2 text-xs text-left transition-colors',
      danger
        ? 'text-red-500/80 hover:text-red-500 hover:bg-red-500/5'
        : isDarkMode
          ? 'hover:bg-white/5'
          : 'hover:bg-black/[0.04]',
    )}
  >
    <Icon className="w-3.5 h-3.5 opacity-60" />
    <span>{label}</span>
  </button>
);
