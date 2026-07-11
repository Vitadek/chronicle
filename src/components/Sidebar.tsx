import React, { useState, useRef, useMemo, useEffect } from 'react';
import { Book, Plus, MoreVertical, Menu, X, Trash2, Settings, ChevronLeft, Moon, Sun, Cloud, Layout, Copy, GripVertical, FileText, List, Search, Upload, Check, Download, Briefcase, User, Info, Library, Sparkles, AlignLeft, Bot, Smartphone, Clock, SpellCheck, CaseSensitive } from 'lucide-react';
import { cn } from '../lib/utils';
import { motion, AnimatePresence } from 'motion/react';
import { Chapter, ManuscriptMetadata, UserProfile, ExportSettings, DEFAULT_EXPORT_SETTINGS } from '../types';
import { exportToManuscriptDocx, exportToMarkdown, exportToHtml, exportChaptersAsMarkdownZip } from '../lib/exportService';
import { exportToEpub } from '../lib/epubExport';
import { MarkdownExportDialog } from './MarkdownExportDialog';
import { countWords, readingMinutes, formatWordCount } from '../lib/wordCount';
import { MarkdownRenderer } from './MarkdownRenderer';
import { CoverArtUpload } from './CoverArtUpload';
import { AiSettingsPanel } from './AiSettingsPanel';
import { ChapterMenu } from './ChapterMenu';
import { OutlinePane } from './OutlinePane';
import { IssuesPane } from './IssuesPane';
import type { TenseShiftHit } from '../lib/TenseShift';
import type { GrammarMark } from '../lib/Grammar';
import type { Editor } from '@tiptap/react';
import type { Character, PlotNode, PlotEdge } from '../types';
import type { AiConfig, AiProvider } from '../services/aiConfig';
import type { ProviderStatus } from '../services/aiService';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

interface SidebarProps {
  isOpen: boolean;
  onToggle: () => void;
  isDarkMode: boolean;
  onToggleTheme: () => void;
  chapters: Chapter[];
  currentChapterId: string;
  onSelectChapter: (id: string) => void;
  onAddChapter: () => void;
  onDeleteChapter: (id: string) => void;
  onDuplicateChapter: (id: string) => void;
  onReorderChapters: (chapters: Chapter[]) => void;
  isAutocompleteEnabled: boolean;
  onToggleAutocomplete: () => void;
  isTenseCheckEnabled: boolean;
  onToggleTenseCheck: () => void;
  isGrammarCheckEnabled: boolean;
  onToggleGrammarCheck: () => void;
  isAutoCorrectEnabled: boolean;
  onToggleAutoCorrect: () => void;
  isIssuesPanelEnabled: boolean;
  onToggleIssuesPanel: () => void;
  tenseHits: TenseShiftHit[];
  grammarMarks: GrammarMark[];
  isThesaurusEnabled: boolean;
  onToggleThesaurus: () => void;
  isZenModeEnabled: boolean;
  onToggleZenMode: () => void;
  /** First-line indent for body paragraphs in the editor. SMF default ON. */
  isFirstLineIndentEnabled: boolean;
  onToggleFirstLineIndent: () => void;
  touchControlsMode: 'auto' | 'on' | 'off';
  onChangeTouchControls: (mode: 'auto' | 'on' | 'off') => void;
  /** Whether the AI agent menu is available in the editor. */
  isAiEnabled: boolean;
  onToggleAiEnabled: () => void;
  /**
   * Full AI config: provider, key, model, custom-model lists. Null when
   * the user hasn't set up AI yet (Settings shows the wizard).
   */
  aiConfig?: AiConfig | null;
  onUpdateAiConfig?: (cfg: AiConfig | null) => void;
  serverAiProviders?: Partial<Record<AiProvider, ProviderStatus>>;
  onRevalidateAi?: () => Promise<void> | void;
  /** Whether AI actions (Review, Listen) show up in the selection bubble menu. */
  isAiBubbleMenuEnabled?: boolean;
  onToggleAiBubbleMenu?: () => void;
  manuscriptFont: string;
  onChangeFont: (font: string) => void;
  metadata: ManuscriptMetadata;
  onUpdateMetadata: (metadata: Partial<ManuscriptMetadata>) => void;
  userProfile: UserProfile;
  onUpdateUserProfile: (profile: Partial<UserProfile>) => void;
  currentChapterContent?: string;
  /** Permanently delete the current manuscript. Parent navigates back to the library. */
  onDeleteManuscript?: () => void;
  /** Navigate back to the Library view (clears current manuscript selection). */
  onReturnToLibrary?: () => void;
  /** Per-format export preferences (HTML theme, Hugo front matter, EPUB cover/rights). */
  exportSettings?: ExportSettings;
  /**
   * AI-generated outline. When non-empty, the Outline pane shows this in
   * addition to the structural headings. Lives in App state so it persists
   * across sidebar opens/closes within a session.
   */
  aiOutlineMarkdown?: string;
  isAiOutlineLoading?: boolean;
  onClearAiOutline?: () => void;
  onUpdateSynopsis?: (text: string) => void;
  /** Live TipTap editor instance for the open chapter; used by the Comments panel
   *  to walk the doc and apply mark edits in-place. */
  editor?: Editor | null;
  /** Outline data: characters and plot graph. Owned by App.tsx so it
   *  persists per-manuscript and survives sidebar opens/closes. */
  characters?: Character[];
  plotNodes?: PlotNode[];
  plotEdges?: PlotEdge[];
  onAddCharacter?: () => void;
  onUpdateCharacter?: (id: string, patch: Partial<Character>) => void;
  onDeleteCharacter?: (id: string) => void;
  onAddPlotNode?: (kind: 'event' | 'comment') => void;
  onUpdatePlotNode?: (id: string, patch: Partial<PlotNode>) => void;
  onDeletePlotNode?: (id: string) => void;
  onAddPlotEdge?: (from: string, to: string) => void;
  onDeletePlotEdge?: (id: string) => void;
  className?: string;
}

interface SortableChapterProps {
  chapter: Chapter;
  isDarkMode: boolean;
  currentChapterId: string;
  onSelectChapter: (id: string) => void;
  onDeleteChapter: (id: string) => void;
  onDuplicateChapter: (id: string) => void;
  /** Called when the user picks an export format from the chapter row menu. */
  onExportChapter: (id: string, format: 'docx' | 'md' | 'html') => void;
  confirmDeleteId: string | null;
  setConfirmDeleteId: (id: string | null) => void;
}

const SortableChapter: React.FC<SortableChapterProps> = ({
  chapter,
  isDarkMode,
  currentChapterId,
  onSelectChapter,
  onDeleteChapter,
  onDuplicateChapter,
  onExportChapter,
  confirmDeleteId,
  setConfirmDeleteId,
}) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: chapter.id });

  // When the row's action menu is open, lift the whole row above its siblings.
  // Each row is its own stacking context (dnd-kit transform + z-index), so the
  // menu's own z-index can't escape the row — the row itself must outrank the
  // rows below it, or the next chapter paints over the open dropdown.
  const [menuOpen, setMenuOpen] = useState(false);

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 10 : menuOpen ? 40 : 1,
  };

  const wordCount = useMemo(() => countWords(chapter.content), [chapter.content]);
  const minutes = useMemo(() => readingMinutes(wordCount), [wordCount]);

  return (
    <div
      ref={setNodeRef}
      style={style}
      onClick={() => {
        if (confirmDeleteId === chapter.id) return;
        onSelectChapter(chapter.id);
      }}
      className={cn(
        "w-full text-left group px-4 py-3 rounded-xl transition-all duration-300 flex items-center justify-between cursor-pointer relative",
        chapter.id === currentChapterId 
          ? (isDarkMode ? "bg-white/5 text-white" : "bg-black/5 text-black") 
          : "hover:bg-black/5 dark:hover:bg-white/5 hover:text-black dark:hover:text-white",
        confirmDeleteId === chapter.id && "bg-red-500/10 border-red-500/20",
        isDragging && "opacity-50 scale-95"
      )}
    >
      <div className="flex items-center gap-3 overflow-hidden">
        <div 
          {...attributes} 
          {...listeners} 
          className="cursor-grab active:cursor-grabbing p-1 -ml-1 opacity-0 group-hover:opacity-40 hover:opacity-100 touch:opacity-50 transition-opacity"
          onClick={(e) => e.stopPropagation()}
        >
          <GripVertical className="w-3.5 h-3.5" />
        </div>
        <div className="flex flex-col gap-1 overflow-hidden">
          <span className={cn("text-sm font-medium leading-none truncate", !chapter.title && "opacity-40 italic")}>{chapter.title || 'Untitled Chapter'}</span>
          <span className="text-[9px] uppercase tracking-wider opacity-40 flex items-center gap-2">
            <span>{formatWordCount(wordCount)} words</span>
            <span className="opacity-50">·</span>
            <span>{minutes} min</span>
          </span>
        </div>
      </div>
      
      <div className="flex items-center gap-1">
        {confirmDeleteId === chapter.id ? (
          <div className="flex items-center gap-1">
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDeleteChapter(chapter.id);
                setConfirmDeleteId(null);
              }}
              className="px-2 py-1 bg-red-500 text-white text-[10px] font-bold rounded-md hover:bg-red-600 transition-colors"
            >
              DELETE
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                setConfirmDeleteId(null);
              }}
              className="p-1 rounded-md hover:bg-black/10 dark:hover:bg-white/10"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        ) : (
          <ChapterMenu
            isDarkMode={isDarkMode}
            onOpenChange={setMenuOpen}
            onDuplicate={() => onDuplicateChapter(chapter.id)}
            onDelete={() => setConfirmDeleteId(chapter.id)}
            onExportDocx={() => onExportChapter(chapter.id, 'docx')}
            onExportMarkdown={() => onExportChapter(chapter.id, 'md')}
            onExportHtml={() => onExportChapter(chapter.id, 'html')}
          />
        )}
      </div>
    </div>
  );
};

export const Sidebar: React.FC<SidebarProps> = ({ 
  isOpen, 
  onToggle, 
  isDarkMode, 
  onToggleTheme,
  chapters,
  currentChapterId,
  onSelectChapter,
  onAddChapter,
  onDeleteChapter,
  onDuplicateChapter,
  onReorderChapters,
  isAutocompleteEnabled,
  onToggleAutocomplete,
  isTenseCheckEnabled,
  onToggleTenseCheck,
  isGrammarCheckEnabled,
  onToggleGrammarCheck,
  isAutoCorrectEnabled,
  onToggleAutoCorrect,
  isIssuesPanelEnabled,
  onToggleIssuesPanel,
  tenseHits,
  grammarMarks,
  isThesaurusEnabled,
  onToggleThesaurus,
  isZenModeEnabled,
  onToggleZenMode,
  isFirstLineIndentEnabled,
  onToggleFirstLineIndent,
  touchControlsMode,
  onChangeTouchControls,
  isAiEnabled,
  onToggleAiEnabled,
  aiConfig,
  onUpdateAiConfig,
  serverAiProviders,
  onRevalidateAi,
  isAiBubbleMenuEnabled,
  onToggleAiBubbleMenu,
  manuscriptFont,
  onChangeFont,
  metadata,
  onUpdateMetadata,
  userProfile,
  onUpdateUserProfile,
  currentChapterContent,
  onDeleteManuscript,
  onReturnToLibrary,
  exportSettings = DEFAULT_EXPORT_SETTINGS,
  aiOutlineMarkdown,
  isAiOutlineLoading,
  onClearAiOutline,
  editor,
  characters,
  plotNodes,
  plotEdges,
  onAddCharacter,
  onUpdateCharacter,
  onDeleteCharacter,
  onAddPlotNode,
  onUpdatePlotNode,
  onDeletePlotNode,
  onAddPlotEdge,
  onDeletePlotEdge,
  className 
}) => {
  const [view, setView] = useState<'chapters' | 'outline' | 'issues' | 'settings' | 'export' | 'profile'>('chapters');

  // If the Issues panel is switched off while it's the active tab, fall back.
  useEffect(() => {
    if (!isIssuesPanelEnabled && view === 'issues') setView('chapters');
  }, [isIssuesPanelEnabled, view]);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [isExporting, setIsExporting] = useState<'docx' | 'md' | 'html' | 'epub' | null>(null);
  const [showMarkdownDialog, setShowMarkdownDialog] = useState(false);
  const [confirmDeleteManuscript, setConfirmDeleteManuscript] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Manuscript-wide totals, recomputed only when chapter content changes.
  // Cheap given typical chapter counts, and useMemo means we don't redo it
  // for unrelated re-renders (theme toggles, sidebar opens, etc).
  const manuscriptTotals = useMemo(() => {
    const words = chapters.reduce((sum, c) => sum + countWords(c.content), 0);
    return { words, minutes: readingMinutes(words), chapterCount: chapters.length };
  }, [chapters]);

  const handleExportDocx = async () => {
    try {
      setIsExporting('docx');
      await exportToManuscriptDocx(metadata, chapters);
    } catch (error) {
      console.error("Export failed:", error);
    } finally {
      setIsExporting(null);
    }
  };

  /**
   * Markdown export from the chapter picker. A single selected chapter emits
   * one `.md`; multiple emit a `.zip` of one file per chapter. Either way the
   * Hugo `weight` is the chapter's real position in the manuscript (1-based),
   * so a partial selection still sorts correctly on the static site.
   */
  const handleExportMarkdownSelection = async (
    selectedIds: string[],
    markdown: ExportSettings['markdown'],
  ) => {
    const idSet = new Set(selectedIds);
    // Pair each selected chapter with its manuscript position (the weight).
    const picked = chapters
      .map((chapter, index) => ({ chapter, number: index + 1 }))
      .filter(({ chapter }) => idSet.has(chapter.id));
    if (picked.length === 0) return;

    try {
      setIsExporting('md');
      if (picked.length === 1) {
        exportToMarkdown(metadata, [picked[0].chapter], {
          singleChapter: true,
          markdown,
          chapterPosition: picked[0].number,
        });
      } else {
        await exportChaptersAsMarkdownZip(metadata, picked, { markdown });
      }
    } catch (error) {
      console.error('Export failed:', error);
    } finally {
      setIsExporting(null);
    }
  };

  const handleExportHtml = () => {
    try {
      setIsExporting('html');
      exportToHtml(metadata, chapters, { html: exportSettings.html });
    } catch (error) {
      console.error("Export failed:", error);
    } finally {
      setIsExporting(null);
    }
  };

  /**
   * EPUB3 export. Book-wide only — the format includes a cover and ToC, and
   * a single-chapter epub would just be a heavyweight HTML file. Use the
   * per-chapter HTML or markdown for slices.
   */
  const handleExportEpub = async () => {
    try {
      setIsExporting('epub');
      await exportToEpub(metadata, chapters, {
        copyrightNotice: exportSettings.epub.rightsText || undefined,
        coverSource: exportSettings.epub.coverSource,
      });
    } catch (error) {
      console.error('EPUB export failed:', error);
    } finally {
      setIsExporting(null);
    }
  };

  /**
   * Export a single chapter as its own file. The format mirrors the bulk
   * exporters but with `singleChapter: true`, which skips the title page
   * and uses the chapter title for the filename.
   */
  const handleExportChapter = async (id: string, format: 'docx' | 'md' | 'html') => {
    const idx = chapters.findIndex((c) => c.id === id);
    if (idx === -1) return;
    const chapter = chapters[idx];
    try {
      if (format === 'docx') {
        await exportToManuscriptDocx(metadata, [chapter], { singleChapter: true });
      } else if (format === 'md') {
        // chapterPosition drives the Hugo `weight` so per-chapter pages keep
        // their reading order on a static site (1-based).
        exportToMarkdown(metadata, [chapter], {
          singleChapter: true,
          markdown: exportSettings.markdown,
          chapterPosition: idx + 1,
        });
      } else {
        exportToHtml(metadata, [chapter], { singleChapter: true, html: exportSettings.html });
      }
    } catch (error) {
      console.error('Per-chapter export failed:', error);
    }
  };

  const prefillFromProfile = () => {
    onUpdateMetadata({
      contactName: userProfile.name,
      contactAddress: userProfile.address,
      contactPhone: userProfile.phone,
      contactEmail: userProfile.email,
      agentInfo: userProfile.agentInfo || metadata.agentInfo
    });
  };

  const handleSvgUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        onUpdateMetadata({ 
          sceneBreakStyle: 'custom', 
          customSceneBreakSvg: event.target?.result as string 
        });
      };
      reader.readAsDataURL(file);
    }
  };

  const extractHeadings = (title: string, html: string) => {
    const list = [{ id: 'heading-title', text: title, level: 1 }];
    if (!html) return list;
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    
    // We walk all top-level children to find headings AND scene breaks
    const items: Array<{ id: string; text: string; level: number }> = [...list];
    const children = Array.from(doc.body.children);

    children.forEach((child, i) => {
      const tag = child.tagName.toLowerCase();
      
      // 1. Handle standard headings
      if (['h1', 'h2', 'h3'].includes(tag)) {
        items.push({
          id: `heading-content-${i}`,
          text: child.textContent || '',
          level: parseInt(tag.substring(1)),
        });
      }
      
      // 2. Handle scene breaks
      // Detect common break patterns (***, ---, ___) or <hr> tags
      const text = child.textContent?.trim() || '';
      // Support patterns with optional spaces: * * *, - - -, _ _ _
      const isBreakText = /^((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})$/.test(text);
      const isHr = tag === 'hr';

      if (isHr || (tag === 'p' && isBreakText)) {
        // Look at the NEXT child for the label
        const nextChild = children[i + 1];
        const nextText = nextChild?.textContent?.trim() || '';
        // Get the first sentence or first 40 chars
        const firstSentence = nextText.split(/[.!?]/)[0].substring(0, 40);
        
        items.push({
          id: `scene-content-${i}`,
          text: `Scene: ${firstSentence}${firstSentence ? '...' : '(End of block)'}`,
          level: 4, // Custom level for scene breaks (indented further)
        });
      }
    });

    return items;
  };

  const currentChapter = chapters.find(c => c.id === currentChapterId);
  const headings = currentChapter ? extractHeadings(currentChapter.title, currentChapterContent || '') : [];
  const fonts = [
    { name: 'Inter', family: 'Inter' },
    { name: 'Verdana', family: 'Verdana' },
    { name: 'Roboto', family: 'Roboto' },
    { name: 'Montserrat', family: 'Montserrat' },
    { name: 'Literata', family: 'Literata' }
  ];

  const handleHeadingClick = (text: string, level: number) => {
    if (level === 1 && text === currentChapter?.title) {
      const titleEl = document.querySelector('[data-outline="title"]');
      titleEl?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } else {
      const editorEl = document.querySelector('[data-outline="content"]');
      if (editorEl) {
        // For Level 4 (Scenes), we look for <hr> or matching paragraph patterns
        if (level === 4) {
          const blocks = Array.from(editorEl.querySelectorAll('p, hr'));
          const target = blocks.find(el => {
            if (el.tagName.toLowerCase() === 'hr') return true;
            const pText = el.textContent?.trim() || '';
            return /^((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})$/.test(pText);
          });
          target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
          return;
        }

        const hTags = Array.from(editorEl.querySelectorAll('h1, h2, h3'));
        const target = hTags.find(h => h.textContent?.trim() === text.trim());
        target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  };

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;

    if (over && active.id !== over.id) {
      const oldIndex = chapters.findIndex((c) => c.id === active.id);
      const newIndex = chapters.findIndex((c) => c.id === over.id);
      
      onReorderChapters(arrayMove(chapters, oldIndex, newIndex));
    }
  };

  return (
    <>
      <div className="fixed top-8 left-8 z-[60] ui-element-container h-24 w-24 -mt-8 -ml-8 safe-pad-toggle flex items-center justify-center group pointer-events-none hover:pointer-events-auto">
        <div className="absolute top-8 left-8 w-1 h-8 bg-black/5 dark:bg-white/5 rounded-r-full group-hover:opacity-0 transition-opacity hidden sm:block" />
        <button 
          onClick={onToggle}
          className={cn(
            "p-3 rounded-full shadow-lg transition-all hover:scale-110 active:scale-95 ui-element pointer-events-auto",
            isDarkMode ? "bg-white text-black" : "bg-black text-white"
          )}
        >
          {isOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
        </button>
      </div>

      <AnimatePresence mode="wait">
        {isOpen && (
          <motion.aside
            initial={{ x: -250, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: -250, opacity: 0 }}
            transition={{ type: 'spring', damping: 25, stiffness: 200 }}
            className={cn(
              "app-sidebar fixed inset-y-0 left-0 z-50 flex flex-col pt-20 sm:pt-24 pb-8 px-4 sm:px-6 border-r overflow-hidden w-[88vw] max-w-80",
              isDarkMode 
                ? "bg-manuscript-dark border-white/5 text-white/40" 
                : "bg-manuscript-light border-black/5 text-black/40",
              className
            )}
          >
            <div className="mb-12 flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2 mb-2 px-2">
                  {view === 'outline' ? (
                    <List className={cn("w-3.5 h-3.5", isDarkMode ? "text-white/20" : "text-black/20")} />
                  ) : (
                    <Book className={cn("w-3.5 h-3.5", isDarkMode ? "text-white/20" : "text-black/20")} />
                  )}
                  <span className={cn("text-[10px] uppercase tracking-[0.2em] font-bold", isDarkMode ? "text-white/60" : "text-black/60")}>
                    {view === 'outline' ? 'Structure' : 'Manuscript'}
                  </span>
                </div>
                <h1 className={cn("text-xl sm:text-2xl font-serif italic px-2 truncate", isDarkMode ? "text-white" : "text-black")}>
                  {view === 'outline' ? (chapters.find(c => c.id === currentChapterId)?.title || 'Untitled Chapter') : (metadata.title || 'Untitled Manuscript')}
                </h1>
              </div>
              <div className="flex items-center gap-0.5 shrink-0">
                {onReturnToLibrary && (
                  <button 
                    onClick={onReturnToLibrary}
                    className="p-2 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 transition-colors opacity-60 hover:opacity-100"
                    title="Return to Library"
                  >
                    <Library className="w-5 h-5" />
                  </button>
                )}
                <button 
                  onClick={() => setView('profile')}
                  className={cn(
                    "p-2 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 transition-colors",
                    view === 'profile' ? "opacity-100 bg-black/5 dark:bg-white/5" : "opacity-60"
                  )}
                  title="Author Profile"
                >
                  <User className="w-5 h-5" />
                </button>
                <button 
                  onClick={() => setView('settings')}
                  className={cn(
                    "p-2 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 transition-colors",
                    view === 'settings' ? "opacity-100 bg-black/5 dark:bg-white/5" : "opacity-60"
                  )}
                  title="Settings"
                >
                  <Settings className="w-5 h-5" />
                </button>
              </div>
            </div>

            <div className="flex bg-black/5 dark:bg-white/5 p-1 rounded-xl mb-8">
              <button 
                onClick={() => setView('chapters')}
                className={cn(
                  "flex-1 flex items-center justify-center gap-2 py-2 rounded-lg text-[10px] font-bold uppercase tracking-widest transition-all",
                  view === 'chapters' ? (isDarkMode ? "bg-white/10 text-white" : "bg-white text-black shadow-sm") : "opacity-40"
                )}
              >
                <Book className="w-3 h-3" />
                Draft
              </button>
              <button 
                onClick={() => setView('outline')}
                className={cn(
                  "flex-1 flex items-center justify-center gap-2 py-2 rounded-lg text-[10px] font-bold uppercase tracking-widest transition-all",
                  view === 'outline' ? (isDarkMode ? "bg-white/10 text-white" : "bg-white text-black shadow-sm") : "opacity-40",
                  currentChapterId === 'title-page' && "pointer-events-none opacity-10"
                )}
              >
                <List className="w-3 h-3" />
                Outline
              </button>
              {isIssuesPanelEnabled && (
                <button
                  onClick={() => setView('issues')}
                  className={cn(
                    "flex-1 flex items-center justify-center gap-2 py-2 rounded-lg text-[10px] font-bold uppercase tracking-widest transition-all",
                    view === 'issues' ? (isDarkMode ? "bg-white/10 text-white" : "bg-white text-black shadow-sm") : "opacity-40"
                  )}
                >
                  <SpellCheck className="w-3 h-3" />
                  Issues
                </button>
              )}
              <button
                onClick={() => setView('export')}
                className={cn(
                  "flex-1 flex items-center justify-center gap-2 py-2 rounded-lg text-[10px] font-bold uppercase tracking-widest transition-all",
                  view === 'export' ? (isDarkMode ? "bg-white/10 text-white" : "bg-white text-black shadow-sm") : "opacity-40"
                )}
              >
                <Download className="w-3 h-3" />
                Export
              </button>
            </div>

            <AnimatePresence mode="wait">
              {view === 'chapters' ? (
                <motion.div 
                  key="chapters"
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -20 }}
                  className="flex flex-col flex-1 min-h-0 overflow-hidden"
                >
                  <div className="flex-1 overflow-y-auto space-y-8 pr-1 mt-2">
                    <div className="space-y-2">
                      {/* Manuscript totals — one line, scanable at a glance. */}
                      <div className="px-4 py-2 flex items-center justify-between text-[9px] uppercase tracking-[0.15em] font-bold opacity-30">
                        <span>{manuscriptTotals.chapterCount} chapter{manuscriptTotals.chapterCount === 1 ? '' : 's'}</span>
                        <span className="flex items-center gap-2">
                          <span>{formatWordCount(manuscriptTotals.words)} words</span>
                          <span className="opacity-50">·</span>
                          <span>{manuscriptTotals.minutes} min</span>
                        </span>
                      </div>
                      <div
                        onClick={() => onSelectChapter('title-page')}
                        className={cn(
                          "w-full text-left group px-4 py-3 rounded-xl transition-all duration-300 flex items-center gap-3 cursor-pointer relative",
                          currentChapterId === 'title-page' 
                            ? (isDarkMode ? "bg-white/5 text-white" : "bg-black/5 text-black") 
                            : "hover:bg-black/5 dark:hover:bg-white/5 hover:text-black dark:hover:text-white"
                        )}
                      >
                        <FileText className="w-4 h-4 opacity-40 shrink-0" />
                        <span className="text-sm font-medium leading-none truncate">Title Page</span>
                      </div>

                      <div className="h-px bg-black/5 dark:bg-white/5 mx-4 my-2 opacity-50" />

                      <DndContext
                        sensors={sensors}
                        collisionDetection={closestCenter}
                        onDragEnd={handleDragEnd}
                      >
                        <SortableContext
                          items={chapters.map(c => c.id)}
                          strategy={verticalListSortingStrategy}
                        >
                          {chapters.map((chapter) => (
                            <SortableChapter
                              key={chapter.id}
                              chapter={chapter}
                              isDarkMode={isDarkMode}
                              currentChapterId={currentChapterId}
                              onSelectChapter={onSelectChapter}
                              onDeleteChapter={onDeleteChapter}
                              onDuplicateChapter={onDuplicateChapter}
                              onExportChapter={handleExportChapter}
                              confirmDeleteId={confirmDeleteId}
                              setConfirmDeleteId={setConfirmDeleteId}
                            />
                          ))}
                        </SortableContext>
                      </DndContext>
                    </div>
                  </div>

                  <div className="py-8 mt-auto">
                    <button 
                      onClick={onAddChapter}
                      className={cn(
                      "w-full flex items-center justify-center gap-2 py-4 rounded-full text-xs font-bold uppercase tracking-widest transition-all hover:scale-[1.02] active:scale-95 shadow-xl",
                      isDarkMode ? "bg-white text-black" : "bg-black text-white"
                    )}>
                      <Plus className="w-4 h-4" />
                      Add Chapter
                    </button>
                  </div>
                </motion.div>
              ) : view === 'outline' ? (
                <motion.div 
                  key="outline"
                  initial={{ opacity: 0, scale: 0.98 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.98 }}
                  className="flex flex-col flex-1 min-h-0 overflow-hidden"
                >
                  <OutlinePane
                    isDarkMode={isDarkMode}
                    editor={editor || null}
                    synopsis={metadata.synopsis}
                    onUpdateSynopsis={(text) => onUpdateSynopsis?.(text)}
                    headings={headings}
                    onHeadingClick={handleHeadingClick}
                    aiOutlineMarkdown={aiOutlineMarkdown}
                    isAiOutlineLoading={isAiOutlineLoading}
                    onClearAiOutline={onClearAiOutline}
                    characters={characters || []}
                    plotNodes={plotNodes || []}
                    plotEdges={plotEdges || []}
                    onAddCharacter={() => onAddCharacter?.()}
                    onUpdateCharacter={(id, patch) => onUpdateCharacter?.(id, patch)}
                    onDeleteCharacter={(id) => onDeleteCharacter?.(id)}
                    onAddPlotNode={(kind) => onAddPlotNode?.(kind)}
                    onUpdatePlotNode={(id, patch) => onUpdatePlotNode?.(id, patch)}
                    onDeletePlotNode={(id) => onDeletePlotNode?.(id)}
                    onAddPlotEdge={(from, to) => onAddPlotEdge?.(from, to)}
                    onDeletePlotEdge={(id) => onDeletePlotEdge?.(id)}
                    chapters={chapters}
                    currentChapterId={currentChapterId}
                    onSelectChapter={onSelectChapter}
                  />
                </motion.div>
              ) : view === 'issues' ? (
                <motion.div
                  key="issues"
                  initial={{ opacity: 0, scale: 0.98 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.98 }}
                  className="flex flex-col flex-1 min-h-0 overflow-hidden"
                >
                  <IssuesPane
                    isDarkMode={isDarkMode}
                    editor={editor || null}
                    tenseHits={tenseHits}
                    grammarMarks={grammarMarks}
                    tenseEnabled={isTenseCheckEnabled}
                    grammarEnabled={isGrammarCheckEnabled}
                  />
                </motion.div>
              ) : view === 'export' ? (
                <motion.div 
                  key="export"
                  initial={{ opacity: 0, scale: 0.98 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.98 }}
                  className="flex flex-col flex-1 min-h-0 overflow-hidden"
                >
                  <div className="flex-1 overflow-y-auto space-y-8 pr-1 mt-2 pb-8">
                    <section className="space-y-4">
                      <div className="flex items-center gap-2 px-2 text-[10px] uppercase tracking-[0.2em] font-bold opacity-40">
                        <User className="w-3 h-3" />
                        <span>Title Page Details</span>
                      </div>
                      
                      <div className="px-2">
                        <button 
                          onClick={prefillFromProfile}
                          className={cn(
                            "w-full flex items-center justify-center gap-2 py-2 mb-4 rounded-xl text-[9px] font-bold uppercase tracking-widest transition-all hover:bg-black/5 dark:hover:bg-white/5 border border-dashed",
                            isDarkMode ? "border-white/10" : "border-black/10"
                          )}
                        >
                          <User className="w-3 h-3" />
                          Sync from Author Profile
                        </button>
                      </div>
                      
                      <div className="space-y-4 px-2">
                        <CoverArtUpload
                          manuscriptId={metadata.id}
                          coverArt={metadata.coverArt}
                          onChange={(filename) => onUpdateMetadata({ coverArt: filename })}
                          isDarkMode={isDarkMode}
                        />

                        <div>
                          <label className="block text-[10px] uppercase tracking-widest font-bold opacity-30 mb-2">Manuscript Title</label>
                          <input 
                            type="text"
                            value={metadata.title}
                            onChange={(e) => onUpdateMetadata({ title: e.target.value })}
                            placeholder="Title"
                            className={cn(
                              "w-full px-4 py-3 rounded-xl text-xs bg-black/5 dark:bg-white/5 border border-transparent focus:border-black/10 dark:focus:border-white/10 outline-none transition-all",
                              isDarkMode ? "text-white" : "text-black"
                            )}
                          />
                        </div>

                        <div>
                          <label className="block text-[10px] uppercase tracking-widest font-bold opacity-30 mb-2">Author / Pen Name</label>
                          <input 
                            type="text"
                            value={metadata.author}
                            onChange={(e) => onUpdateMetadata({ author: e.target.value })}
                            placeholder="Author Name"
                            className={cn(
                              "w-full px-4 py-3 rounded-xl text-xs bg-black/5 dark:bg-white/5 border border-transparent focus:border-black/10 dark:focus:border-white/10 outline-none transition-all",
                              isDarkMode ? "text-white" : "text-black"
                            )}
                          />
                        </div>

                        <div>
                          <label className="block text-[10px] uppercase tracking-widest font-bold opacity-30 mb-2">Real Name (Optional)</label>
                          <input 
                            type="text"
                            value={metadata.contactName || ''}
                            onChange={(e) => onUpdateMetadata({ contactName: e.target.value })}
                            placeholder="Defaults to Author"
                            className={cn(
                              "w-full px-4 py-3 rounded-xl text-xs bg-black/5 dark:bg-white/5 border border-transparent focus:border-black/10 dark:focus:border-white/10 outline-none transition-all",
                              isDarkMode ? "text-white" : "text-black"
                            )}
                          />
                        </div>

                        <div>
                          <label className="block text-[10px] uppercase tracking-widest font-bold opacity-30 mb-2">Address (Optional)</label>
                          <textarea 
                            value={metadata.contactAddress || ''}
                            onChange={(e) => onUpdateMetadata({ contactAddress: e.target.value })}
                            placeholder="Mailing address"
                            className={cn(
                              "w-full h-24 px-4 py-3 rounded-xl text-xs bg-black/5 dark:bg-white/5 border border-transparent focus:border-black/10 dark:focus:border-white/10 outline-none transition-all resize-none",
                              isDarkMode ? "text-white" : "text-black"
                            )}
                          />
                        </div>

                        <div className="grid grid-cols-2 gap-4">
                          <div>
                            <label className="block text-[10px] uppercase tracking-widest font-bold opacity-30 mb-2">Phone (Optional)</label>
                            <input 
                              type="text"
                              value={metadata.contactPhone || ''}
                              onChange={(e) => onUpdateMetadata({ contactPhone: e.target.value })}
                              placeholder="Phone"
                              className={cn(
                                "w-full px-4 py-3 rounded-xl text-xs bg-black/5 dark:bg-white/5 border border-transparent focus:border-black/10 dark:focus:border-white/10 outline-none transition-all",
                                isDarkMode ? "text-white" : "text-black"
                              )}
                            />
                          </div>
                          <div>
                            <label className="block text-[10px] uppercase tracking-widest font-bold opacity-30 mb-2">Email (Optional)</label>
                            <input 
                              type="email"
                              value={metadata.contactEmail || ''}
                              onChange={(e) => onUpdateMetadata({ contactEmail: e.target.value })}
                              placeholder="Email"
                              className={cn(
                                "w-full px-4 py-3 rounded-xl text-xs bg-black/5 dark:bg-white/5 border border-transparent focus:border-black/10 dark:focus:border-white/10 outline-none transition-all",
                                isDarkMode ? "text-white" : "text-black"
                              )}
                            />
                          </div>
                        </div>

                        <div>
                          <label className="block text-[10px] uppercase tracking-widest font-bold opacity-30 mb-2">Agent / Rep (Optional)</label>
                          <textarea 
                            value={metadata.agentInfo || ''}
                            onChange={(e) => onUpdateMetadata({ agentInfo: e.target.value })}
                            placeholder="Agency Name"
                            className={cn(
                              "w-full h-24 px-4 py-3 rounded-xl text-xs bg-black/5 dark:bg-white/5 border border-transparent focus:border-black/10 dark:focus:border-white/10 outline-none transition-all resize-none",
                              isDarkMode ? "text-white" : "text-black"
                            )}
                          />
                        </div>

                        <div>
                          <label className="block text-[10px] uppercase tracking-widest font-bold opacity-30 mb-2">Genre (Optional)</label>
                          <input 
                            type="text"
                            value={metadata.genre || ''}
                            onChange={(e) => onUpdateMetadata({ genre: e.target.value })}
                            placeholder="e.g. Science Fiction"
                            className={cn(
                              "w-full px-4 py-3 rounded-xl text-xs bg-black/5 dark:bg-white/5 border border-transparent focus:border-black/10 dark:focus:border-white/10 outline-none transition-all",
                              isDarkMode ? "text-white" : "text-black"
                            )}
                          />
                        </div>
                      </div>
                    </section>

                    <section className="space-y-4">
                      <div className="flex items-center gap-2 px-2 text-[10px] uppercase tracking-[0.2em] font-bold opacity-40">
                        <Info className="w-3 h-3" />
                        <span>SMF Standard Checklist</span>
                      </div>
                      <div className="px-4 space-y-2">
                        {[
                          "12pt Times New Roman",
                          "Double Spaced",
                          "1-inch margins",
                          "First-line indents",
                          "Automated headers"
                        ].map((item, i) => (
                          <div key={i} className="flex items-center gap-2 text-[10px] opacity-40">
                            <div className="w-1 h-1 rounded-full bg-current" />
                            <span>{item}</span>
                          </div>
                        ))}
                      </div>
                    </section>
                  </div>

                  <div className="py-6 mt-auto space-y-3">
                    <button 
                      onClick={handleExportDocx}
                      disabled={isExporting !== null}
                      className={cn(
                      "w-full flex items-center justify-between px-6 py-4 rounded-2xl text-[10px] font-bold uppercase tracking-widest transition-all hover:scale-[1.02] active:scale-95 shadow-lg border border-black/5 dark:border-white/5",
                      isDarkMode ? "bg-white text-black" : "bg-black text-white"
                    )}>
                      <div className="flex items-center gap-3">
                        <FileText className="w-4 h-4" />
                        <span>Microsoft Word (.docx)</span>
                      </div>
                      {isExporting === 'docx' ? (
                        <div className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
                      ) : (
                        <span className="opacity-40 font-mono">SMF</span>
                      )}
                    </button>

                    <button
                      onClick={() => setShowMarkdownDialog(true)}
                      disabled={isExporting !== null}
                      className={cn(
                      "w-full flex items-center justify-between px-6 py-4 rounded-2xl text-[10px] font-bold uppercase tracking-widest transition-all hover:scale-[1.02] active:scale-95 border border-black/10 dark:border-white/10",
                      isDarkMode ? "bg-white/5 text-white hover:bg-white/10" : "bg-black/5 text-black hover:bg-black/10"
                    )}>
                      <div className="flex items-center gap-3">
                        <Layout className="w-4 h-4" />
                        <span>Markdown (.md)</span>
                      </div>
                      {isExporting === 'md' ? (
                        <div className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
                      ) : (
                        <span className="opacity-40 font-mono">TEXT</span>
                      )}
                    </button>

                    <button 
                      onClick={handleExportHtml}
                      disabled={isExporting !== null}
                      className={cn(
                      "w-full flex items-center justify-between px-6 py-4 rounded-2xl text-[10px] font-bold uppercase tracking-widest transition-all hover:scale-[1.02] active:scale-95 border border-black/10 dark:border-white/10",
                      isDarkMode ? "bg-white/5 text-white hover:bg-white/10" : "bg-black/5 text-black hover:bg-black/10"
                    )}>
                      <div className="flex items-center gap-3">
                        <FileText className="w-4 h-4" />
                        <span>HTML (.html)</span>
                      </div>
                      {isExporting === 'html' ? (
                        <div className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
                      ) : (
                        <span className="opacity-40 font-mono">WEB</span>
                      )}
                    </button>

                    <button 
                      onClick={handleExportEpub}
                      disabled={isExporting !== null}
                      className={cn(
                      "w-full flex items-center justify-between px-6 py-4 rounded-2xl text-[10px] font-bold uppercase tracking-widest transition-all hover:scale-[1.02] active:scale-95 border border-black/10 dark:border-white/10",
                      isDarkMode ? "bg-white/5 text-white hover:bg-white/10" : "bg-black/5 text-black hover:bg-black/10"
                    )}>
                      <div className="flex items-center gap-3">
                        <Book className="w-4 h-4" />
                        <div className="flex flex-col items-start">
                          <span>EPUB3 (.epub)</span>
                          <span className="text-[8px] opacity-50 normal-case tracking-normal">Whole book with cover &amp; TOC</span>
                        </div>
                      </div>
                      {isExporting === 'epub' ? (
                        <div className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
                      ) : (
                        <span className="opacity-40 font-mono">READER</span>
                      )}
                    </button>
                  </div>
                </motion.div>
              ) : view === 'profile' ? (
                <motion.div 
                  key="profile"
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 20 }}
                  className="flex flex-col flex-1 min-h-0 overflow-hidden"
                >
                  <div className="mb-8 flex items-center gap-4">
                    <button 
                      onClick={() => setView('chapters')}
                      className="p-2 -ml-2 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                    >
                      <ChevronLeft className="w-5 h-5 opacity-60" />
                    </button>
                    <h2 className={cn("text-xl font-bold uppercase tracking-widest", isDarkMode ? "text-white" : "text-black")}>
                      Profile
                    </h2>
                  </div>

                  <div className="flex-1 overflow-y-auto space-y-6 pr-1 pb-8">
                    <p className="px-2 text-[10px] opacity-40 italic leading-relaxed">
                      This information is stored globally and can be synced to any manuscript's title page for export.
                    </p>

                    <div className="space-y-4 px-2">
                      <div>
                        <label className="block text-[10px] uppercase tracking-widest font-bold opacity-30 mb-2">Author Name</label>
                        <input 
                          type="text"
                          value={userProfile.name}
                          onChange={(e) => onUpdateUserProfile({ name: e.target.value })}
                          placeholder="Your real name"
                          className={cn(
                            "w-full px-4 py-3 rounded-xl text-xs bg-black/[0.03] dark:bg-white/[0.08] border border-black/5 dark:border-white/5 focus:border-black/10 dark:focus:border-white/20 outline-none transition-all",
                            isDarkMode ? "text-white" : "text-black"
                          )}
                        />
                      </div>

                      <div>
                        <label className="block text-[10px] uppercase tracking-widest font-bold opacity-30 mb-2">Mailing Address</label>
                        <textarea 
                          value={userProfile.address}
                          onChange={(e) => onUpdateUserProfile({ address: e.target.value })}
                          placeholder="Your permanent mailing address"
                          className={cn(
                            "w-full h-24 px-4 py-3 rounded-xl text-xs bg-black/[0.03] dark:bg-white/[0.08] border border-black/5 dark:border-white/5 focus:border-black/10 dark:focus:border-white/20 outline-none transition-all resize-none",
                            isDarkMode ? "text-white" : "text-black"
                          )}
                        />
                      </div>

                      <div>
                        <label className="block text-[10px] uppercase tracking-widest font-bold opacity-30 mb-2">Phone</label>
                        <input 
                          type="text"
                          value={userProfile.phone}
                          onChange={(e) => onUpdateUserProfile({ phone: e.target.value })}
                          placeholder="Phone number"
                          className={cn(
                            "w-full px-4 py-3 rounded-xl text-xs bg-black/[0.03] dark:bg-white/[0.08] border border-black/5 dark:border-white/5 focus:border-black/10 dark:focus:border-white/20 outline-none transition-all",
                            isDarkMode ? "text-white" : "text-black"
                          )}
                        />
                      </div>

                      <div>
                        <label className="block text-[10px] uppercase tracking-widest font-bold opacity-30 mb-2">Email</label>
                        <input 
                          type="email"
                          value={userProfile.email}
                          onChange={(e) => onUpdateUserProfile({ email: e.target.value })}
                          placeholder="Email address"
                          className={cn(
                            "w-full px-4 py-3 rounded-xl text-xs bg-black/[0.03] dark:bg-white/[0.08] border border-black/5 dark:border-white/5 focus:border-black/10 dark:focus:border-white/20 outline-none transition-all",
                            isDarkMode ? "text-white" : "text-black"
                          )}
                        />
                      </div>

                      <div>
                        <label className="block text-[10px] uppercase tracking-widest font-bold opacity-30 mb-2">Default Agent Info</label>
                        <textarea 
                          value={userProfile.agentInfo || ''}
                          onChange={(e) => onUpdateUserProfile({ agentInfo: e.target.value })}
                          placeholder="Literary Agent details"
                          className={cn(
                            "w-full h-24 px-4 py-3 rounded-xl text-xs bg-black/[0.03] dark:bg-white/[0.08] border border-black/5 dark:border-white/5 focus:border-black/10 dark:focus:border-white/20 outline-none transition-all resize-none",
                            isDarkMode ? "text-white" : "text-black"
                          )}
                        />
                      </div>
                    </div>
                  </div>

                  <div className="py-8 mt-auto border-t border-black/5 dark:border-white/5">
                    <p className="text-[10px] opacity-20 text-center uppercase tracking-widest font-bold">
                      Author Profile Locked to Device
                    </p>
                  </div>
                </motion.div>
              ) : (
                <motion.div 
                  key="settings"
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 20 }}
                  className="flex flex-col flex-1 min-h-0 overflow-hidden"
                >
                  <div className="mb-8 flex items-center gap-4">
                    <button 
                      onClick={() => setView('chapters')}
                      className="p-2 -ml-2 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                    >
                      <ChevronLeft className="w-5 h-5 opacity-60" />
                    </button>
                    <h2 className={cn("text-xl font-bold uppercase tracking-widest", isDarkMode ? "text-white" : "text-black")}>
                      Settings
                    </h2>
                  </div>

                  <div className="flex-1 overflow-y-auto space-y-8 pr-1">
                    {/* Appearance */}
                    <section>
                      <h3 className="text-[10px] uppercase tracking-[0.2em] font-bold mb-4 opacity-40">Appearance</h3>
                      <button 
                        onClick={onToggleTheme}
                        className="w-full flex items-center justify-between px-4 py-3 rounded-xl hover:bg-black/5 dark:hover:bg-white/5 transition-all text-sm group"
                      >
                        <div className="flex items-center gap-3">
                          {isDarkMode ? <Moon className="w-4 h-4" /> : <Sun className="w-4 h-4" />}
                          <span className={cn("font-medium", isDarkMode ? "text-white/80" : "text-black/80")}>
                            {isDarkMode ? 'Night Mode' : 'Day Mode'}
                          </span>
                        </div>
                        <div className={cn(
                          "w-8 h-4 rounded-full relative transition-colors duration-300",
                          isDarkMode ? "bg-white/20" : "bg-black/10"
                        )}>
                          <div className={cn(
                            "absolute top-1 w-2 h-2 rounded-full transition-all duration-300",
                            isDarkMode ? "bg-white left-5" : "bg-black left-1"
                          )} />
                        </div>
                      </button>
                    </section>

                    {/* Writing */}
                    <section className="space-y-4">
                      <h3 className="text-[10px] uppercase tracking-[0.2em] font-bold mb-4 opacity-40">Writing</h3>
                      <div className="space-y-4">
                        <button 
                          onClick={onToggleAutocomplete}
                          className="w-full flex items-center justify-between px-4 py-3 rounded-xl hover:bg-black/5 dark:hover:bg-white/5 transition-all text-sm group"
                        >
                          <div className="flex items-center gap-3">
                            <Book className="w-4 h-4" />
                            <span className={cn("font-medium", isDarkMode ? "text-white/80" : "text-black/80")}>
                              Autocomplete
                            </span>
                          </div>
                          <div className={cn(
                            "w-8 h-4 rounded-full relative transition-colors duration-300",
                            isAutocompleteEnabled ? "bg-white/20" : "bg-black/10"
                          )}>
                            <div className={cn(
                              "absolute top-1 w-2 h-2 rounded-full transition-all duration-300",
                              isAutocompleteEnabled ? "bg-white left-5" : "bg-black left-1"
                            )} />
                          </div>
                        </button>

                        <button
                          onClick={onToggleTenseCheck}
                          className="w-full flex items-center justify-between px-4 py-3 rounded-xl hover:bg-black/5 dark:hover:bg-white/5 transition-all text-sm group"
                        >
                          <div className="flex items-center gap-3">
                            <Clock className="w-4 h-4" />
                            <span className={cn("font-medium", isDarkMode ? "text-white/80" : "text-black/80")}>
                              Tense Check
                            </span>
                          </div>
                          <div className={cn(
                            "w-8 h-4 rounded-full relative transition-colors duration-300",
                            isTenseCheckEnabled ? "bg-white/20" : "bg-black/10"
                          )}>
                            <div className={cn(
                              "absolute top-1 w-2 h-2 rounded-full transition-all duration-300",
                              isTenseCheckEnabled ? "bg-white left-5" : "bg-black left-1"
                            )} />
                          </div>
                        </button>

                        <button
                          onClick={onToggleGrammarCheck}
                          className="w-full flex items-center justify-between px-4 py-3 rounded-xl hover:bg-black/5 dark:hover:bg-white/5 transition-all text-sm group"
                        >
                          <div className="flex items-center gap-3">
                            <SpellCheck className="w-4 h-4" />
                            <span className={cn("font-medium", isDarkMode ? "text-white/80" : "text-black/80")}>
                              Grammar Check
                            </span>
                          </div>
                          <div className={cn(
                            "w-8 h-4 rounded-full relative transition-colors duration-300",
                            isGrammarCheckEnabled ? "bg-white/20" : "bg-black/10"
                          )}>
                            <div className={cn(
                              "absolute top-1 w-2 h-2 rounded-full transition-all duration-300",
                              isGrammarCheckEnabled ? "bg-white left-5" : "bg-black left-1"
                            )} />
                          </div>
                        </button>

                        <button
                          onClick={onToggleAutoCorrect}
                          className="w-full flex items-center justify-between px-4 py-3 rounded-xl hover:bg-black/5 dark:hover:bg-white/5 transition-all text-sm group"
                        >
                          <div className="flex items-center gap-3">
                            <CaseSensitive className="w-4 h-4" />
                            <span className={cn("font-medium", isDarkMode ? "text-white/80" : "text-black/80")}>
                              Autocorrect
                            </span>
                          </div>
                          <div className={cn(
                            "w-8 h-4 rounded-full relative transition-colors duration-300",
                            isAutoCorrectEnabled ? "bg-white/20" : "bg-black/10"
                          )}>
                            <div className={cn(
                              "absolute top-1 w-2 h-2 rounded-full transition-all duration-300",
                              isAutoCorrectEnabled ? "bg-white left-5" : "bg-black left-1"
                            )} />
                          </div>
                        </button>

                        <button
                          onClick={onToggleIssuesPanel}
                          className="w-full flex items-center justify-between px-4 py-3 rounded-xl hover:bg-black/5 dark:hover:bg-white/5 transition-all text-sm group"
                        >
                          <div className="flex items-center gap-3">
                            <List className="w-4 h-4" />
                            <span className={cn("font-medium", isDarkMode ? "text-white/80" : "text-black/80")}>
                              Issues Panel
                            </span>
                          </div>
                          <div className={cn(
                            "w-8 h-4 rounded-full relative transition-colors duration-300",
                            isIssuesPanelEnabled ? "bg-white/20" : "bg-black/10"
                          )}>
                            <div className={cn(
                              "absolute top-1 w-2 h-2 rounded-full transition-all duration-300",
                              isIssuesPanelEnabled ? "bg-white left-5" : "bg-black left-1"
                            )} />
                          </div>
                        </button>

                        <button
                          onClick={onToggleThesaurus}
                          className="w-full flex items-center justify-between px-4 py-3 rounded-xl hover:bg-black/5 dark:hover:bg-white/5 transition-all text-sm group"
                        >
                          <div className="flex items-center gap-3">
                            <Search className="w-4 h-4" />
                            <span className={cn("font-medium", isDarkMode ? "text-white/80" : "text-black/80")}>
                              Thesaurus Popup
                            </span>
                          </div>
                          <div className={cn(
                            "w-8 h-4 rounded-full relative transition-colors duration-300",
                            isThesaurusEnabled ? "bg-white/20" : "bg-black/10"
                          )}>
                            <div className={cn(
                              "absolute top-1 w-2 h-2 rounded-full transition-all duration-300",
                              isThesaurusEnabled ? "bg-white left-5" : "bg-black left-1"
                            )} />
                          </div>
                        </button>

                        <button 
                          onClick={onToggleZenMode}
                          className="w-full flex items-center justify-between px-4 py-3 rounded-xl hover:bg-black/5 dark:hover:bg-white/5 transition-all text-sm group"
                        >
                          <div className="flex items-center gap-3">
                            <Layout className="w-4 h-4" />
                            <span className={cn("font-medium", isDarkMode ? "text-white/80" : "text-black/80")}>
                              Automatic Zen View
                            </span>
                          </div>
                          <div className={cn(
                            "w-8 h-4 rounded-full relative transition-colors duration-300",
                            isZenModeEnabled ? "bg-white/20" : "bg-black/10"
                          )}>
                            <div className={cn(
                              "absolute top-1 w-2 h-2 rounded-full transition-all duration-300",
                              isZenModeEnabled ? "bg-white left-5" : "bg-black left-1"
                            )} />
                          </div>
                        </button>

                        <button 
                          onClick={onToggleFirstLineIndent}
                          className="w-full flex items-center justify-between px-4 py-3 rounded-xl hover:bg-black/5 dark:hover:bg-white/5 transition-all text-sm group"
                          title="SMF convention is on. Turn off for blog/web-style block paragraphs."
                        >
                          <div className="flex items-center gap-3">
                            <AlignLeft className="w-4 h-4" />
                            <span className={cn("font-medium", isDarkMode ? "text-white/80" : "text-black/80")}>
                              First-Line Indent
                            </span>
                          </div>
                          <div className={cn(
                            "w-8 h-4 rounded-full relative transition-colors duration-300",
                            isFirstLineIndentEnabled ? "bg-white/20" : "bg-black/10"
                          )}>
                            <div className={cn(
                              "absolute top-1 w-2 h-2 rounded-full transition-all duration-300",
                              isFirstLineIndentEnabled ? "bg-white left-5" : "bg-black left-1"
                            )} />
                          </div>
                        </button>

                        {/* Touch controls: Auto follows the device's pointer
                            type; On/Off are manual overrides for when detection
                            is wrong. Drives the docked selection bar + larger
                            tap targets. */}
                        <div className="px-4 py-3 rounded-xl">
                          <div className="flex items-center justify-between mb-2">
                            <div className="flex items-center gap-3">
                              <Smartphone className="w-4 h-4" />
                              <span className={cn("font-medium text-sm", isDarkMode ? "text-white/80" : "text-black/80")}>
                                Touch Controls
                              </span>
                            </div>
                          </div>
                          <div className={cn(
                            "flex items-center gap-1 p-1 rounded-xl",
                            isDarkMode ? "bg-white/5" : "bg-black/5"
                          )}>
                            {(['auto', 'on', 'off'] as const).map((mode) => (
                              <button
                                key={mode}
                                onClick={() => onChangeTouchControls(mode)}
                                className={cn(
                                  "flex-1 px-2 py-1.5 rounded-lg text-[11px] font-bold uppercase tracking-wider transition-all",
                                  touchControlsMode === mode
                                    ? (isDarkMode ? "bg-white text-black shadow" : "bg-black text-white shadow")
                                    : "opacity-50 hover:opacity-100"
                                )}
                              >
                                {mode === 'auto' ? 'Auto' : mode === 'on' ? 'On' : 'Off'}
                              </button>
                            ))}
                          </div>
                          <p className="text-[10px] opacity-40 mt-2 leading-relaxed">
                            Bigger tap targets and a bottom selection bar for phones and tablets. Auto detects your device.
                          </p>
                        </div>

                        <AiSettingsPanel
                          isDarkMode={isDarkMode}
                          isAiEnabled={isAiEnabled}
                          onToggleAiEnabled={onToggleAiEnabled}
                          aiConfig={aiConfig || null}
                          onUpdateAiConfig={(next) => onUpdateAiConfig?.(next)}
                          isAiBubbleMenuEnabled={!!isAiBubbleMenuEnabled}
                          onToggleAiBubbleMenu={() => onToggleAiBubbleMenu?.()}
                          serverProviders={serverAiProviders}
                          onRevalidate={onRevalidateAi}
                        />

                        <div className="px-4">
                          <p className="text-[10px] uppercase tracking-widest font-bold opacity-30 mb-3">Manuscript Font</p>
                          <div className="grid grid-cols-2 gap-2">
                            {fonts.map((font) => (
                              <button
                                key={font.name}
                                onClick={() => onChangeFont(font.family)}
                                className={cn(
                                  "px-3 py-2 rounded-lg text-xs font-medium transition-all border",
                                  manuscriptFont === font.family
                                    ? (isDarkMode ? "bg-white/10 border-white/20 text-white" : "bg-black/5 border-black/10 text-black")
                                    : "border-transparent opacity-40 hover:opacity-100"
                                )}
                                style={{ fontFamily: font.family }}
                              >
                                {font.name}
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>
                    </section>

                    {/* AI Agent Commands */}
                    {isAiEnabled && !!aiConfig && (
                      <section className="space-y-4">
                        <h3 className="text-[10px] uppercase tracking-[0.2em] font-bold mb-4 opacity-40">AI Agent Commands</h3>
                        <div className="px-4 space-y-4">
                          <p className="text-[9px] opacity-40 italic leading-relaxed">
                            Type <span className="font-mono font-bold opacity-100">#!</span> in the editor to trigger these commands:
                          </p>
                          <div className="space-y-3">
                            {[
                              { cmd: 'ai_review', desc: 'Pure observation — describes prose, never suggests changes' },
                              { cmd: 'ai_outline', desc: 'Outlines what is already written (appears in the Outline pane)' },
                              { cmd: 'ai_outline/whereami', desc: 'Locates the manuscript in a narrative arc' },
                              { cmd: 'ai_review/make_comments', desc: 'Reader reactions — how passages sound and feel' },
                              { cmd: 'ai_listen', desc: 'Reads the selection (or current paragraph) aloud and attaches a play button' },
                            ].map(item => (
                              <div key={item.cmd} className="group cursor-help">
                                <div className="font-mono text-[10px] font-bold opacity-60 group-hover:opacity-100 transition-opacity">#!/{item.cmd}</div>
                                <div className="text-[9px] opacity-30 leading-snug">{item.desc}</div>
                              </div>
                            ))}
                          </div>
                        </div>
                      </section>
                    )}

                    {/* Scene Breaks */}
                    <section className="space-y-4">
                      <h3 className="text-[10px] uppercase tracking-[0.2em] font-bold mb-4 opacity-40">Scene Breaks</h3>
                      <div className="px-4 space-y-4">
                        <div className="grid grid-cols-2 gap-2">
                          {[
                            { id: 'classic', name: 'Classic', label: '———' },
                            { id: 'dots', name: 'Dots', label: '· · ·' },
                            { id: 'ornamental', name: 'Dinkus', label: '* * *' },
                            { id: 'custom', name: 'Custom', label: 'SVG' },
                          ].map((style) => (
                            <button
                              key={style.id}
                              onClick={() => onUpdateMetadata({ sceneBreakStyle: style.id as any })}
                              className={cn(
                                "flex flex-col items-center justify-center p-3 rounded-xl transition-all border group relative overflow-hidden",
                                (metadata.sceneBreakStyle || 'classic') === style.id
                                  ? (isDarkMode ? "bg-white/10 border-white/20 text-white" : "bg-black/5 border-black/10 text-black")
                                  : "border-transparent opacity-40 hover:opacity-100"
                              )}
                            >
                              <span className="text-[10px] font-bold uppercase tracking-wider mb-1 opacity-60 group-hover:opacity-100">{style.name}</span>
                              <span className="text-sm italic font-serif">{style.label}</span>
                              {(metadata.sceneBreakStyle || 'classic') === style.id && (
                                <motion.div layoutId="style-check" className="absolute top-1 right-1">
                                  <Check className="w-2.5 h-2.5 opacity-60" />
                                </motion.div>
                              )}
                            </button>
                          ))}
                        </div>

                        {metadata.sceneBreakStyle === 'custom' && (
                          <div className="space-y-3">
                            <input 
                              type="file" 
                              ref={fileInputRef} 
                              onChange={handleSvgUpload} 
                              accept=".svg,image/*" 
                              className="hidden" 
                            />
                            <button 
                              onClick={() => fileInputRef.current?.click()}
                              className={cn(
                                "w-full flex items-center justify-center gap-2 py-3 rounded-xl border border-dashed transition-all text-xs font-bold uppercase tracking-widest",
                                isDarkMode ? "border-white/10 hover:bg-white/5" : "border-black/10 hover:bg-black/5"
                              )}
                            >
                              <Upload className="w-3.5 h-3.5 opacity-60" />
                              {metadata.customSceneBreakSvg ? 'Change SVG' : 'Upload SVG'}
                            </button>
                            {metadata.customSceneBreakSvg && (
                              <div className="flex items-center justify-center p-4 rounded-xl bg-black/5 dark:bg-white/5 border border-black/5 dark:border-white/5">
                                <img 
                                  src={metadata.customSceneBreakSvg} 
                                  alt="Custom Dinkus" 
                                  className="h-12 w-12 object-contain opacity-40" 
                                />
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </section>

                    {onDeleteManuscript && (
                      <section className="space-y-4 pt-4 border-t border-red-500/10">
                        <div className="flex items-center gap-2 px-2 text-[10px] uppercase tracking-[0.2em] font-bold text-red-500/60">
                          <Trash2 className="w-3 h-3" />
                          <span>Danger Zone</span>
                        </div>
                        <div className="px-4">
                          {confirmDeleteManuscript ? (
                            <div className="space-y-3">
                              <p className="text-[11px] opacity-60 leading-relaxed">
                                Permanently delete <span className="font-bold">{metadata.title || 'Untitled Manuscript'}</span> and all its chapters? This cannot be undone.
                              </p>
                              <div className="flex items-center gap-2">
                                <button
                                  onClick={() => {
                                    setConfirmDeleteManuscript(false);
                                    onDeleteManuscript?.();
                                  }}
                                  className="flex-1 px-3 py-2 bg-red-500 text-white text-[10px] font-bold uppercase tracking-widest rounded-lg hover:bg-red-600 transition-colors"
                                >
                                  Delete Forever
                                </button>
                                <button
                                  onClick={() => setConfirmDeleteManuscript(false)}
                                  className={cn(
                                    "px-3 py-2 text-[10px] font-bold uppercase tracking-widest rounded-lg transition-colors",
                                    isDarkMode ? "bg-white/5 hover:bg-white/10" : "bg-black/5 hover:bg-black/10"
                                  )}
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          ) : (
                            <button
                              onClick={() => setConfirmDeleteManuscript(true)}
                              className={cn(
                                "w-full flex items-center justify-center gap-2 py-3 rounded-xl border border-red-500/20 text-xs font-bold uppercase tracking-widest text-red-500/80 hover:bg-red-500/5 hover:text-red-500 transition-colors"
                              )}
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                              Delete Manuscript
                            </button>
                          )}
                        </div>
                      </section>
                    )}
                  </div>

                  <div className="py-8 mt-auto border-t border-black/5 dark:border-white/5">
                    <p className="text-[10px] opacity-20 text-center uppercase tracking-widest font-bold">
                      Chronicle v0.1.0
                    </p>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.aside>
        )}
      </AnimatePresence>

      <MarkdownExportDialog
        isOpen={showMarkdownDialog}
        onClose={() => setShowMarkdownDialog(false)}
        isDarkMode={isDarkMode}
        chapters={chapters}
        markdownSettings={exportSettings.markdown}
        onExport={handleExportMarkdownSelection}
      />
    </>
  );
};


