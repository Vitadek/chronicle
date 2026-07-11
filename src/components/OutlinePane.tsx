import React, { useState, useEffect, useRef } from 'react';
import { List, Sparkles, Network, Users, MessageSquare, ExternalLink, PanelRightClose, FileText, AlignLeft } from 'lucide-react';
import type { Editor } from '@tiptap/react';
import { cn } from '../lib/utils';
import { Chapter, Character, PlotNode, PlotEdge } from '../types';
import { MarkdownRenderer } from './MarkdownRenderer';
import { CharacterSheet, DEFAULT_CHARACTER_PALETTE } from './CharacterSheet';
import { PlotCanvas } from './PlotCanvas';
import { CommentsPanel } from './CommentsPanel';
import { PopoutWindow } from './PopoutWindow';

export type OutlineTab = 'synopsis' | 'navigation' | 'plot' | 'characters' | 'comments';

interface OutlinePaneProps {
  isDarkMode: boolean;
  editor: Editor | null;
  // High-level synopsis
  synopsis?: string;
  onUpdateSynopsis: (text: string) => void;
  // Structural headings
  headings: Array<{ id: string; text: string; level: number }>;
  onHeadingClick: (text: string, level: number) => void;
  // AI outline
  aiOutlineMarkdown?: string;
  isAiOutlineLoading?: boolean;
  onClearAiOutline?: () => void;
  // Plot + characters
  characters: Character[];
  plotNodes: PlotNode[];
  plotEdges: PlotEdge[];
  onAddCharacter: () => void;
  onUpdateCharacter: (id: string, patch: Partial<Character>) => void;
  onDeleteCharacter: (id: string) => void;
  onAddPlotNode: (kind: 'event' | 'comment') => void;
  onUpdatePlotNode: (id: string, patch: Partial<PlotNode>) => void;
  onDeletePlotNode: (id: string) => void;
  onAddPlotEdge: (from: string, to: string) => void;
  onDeletePlotEdge: (id: string) => void;
  // Comments
  chapters: Chapter[];
  currentChapterId: string;
  onSelectChapter: (id: string) => void;
}

/**
 * Outline pane container. Houses five subtabs:
 *  - Outline (Synopsis): Manual high-level outline + optional AI version
 *  - Navigation (Structure): chapter / heading list (jumps editor selection)
 *  - Plot: drag-and-drop event graph
 *  - Cast (Characters): list of character cards; click to open the full sheet
 *  - Notes (Comments): list of editable annotations
 */
export const OutlinePane: React.FC<OutlinePaneProps> = (props) => {
  const [tab, setTab] = useState<OutlineTab>('synopsis');
  const [openCharacterId, setOpenCharacterId] = useState<string | null>(null);
  // The planning pane can detach into its own browser window (second-monitor
  // use). The window handle lives in a ref; `isWindowed` drives what renders.
  const [isWindowed, setIsWindowed] = useState(false);
  const popoutWindowRef = useRef<Window | null>(null);
  const { isDarkMode } = props;

  // Close the popout if the pane unmounts (manuscript closed, tab switched away).
  useEffect(() => () => { popoutWindowRef.current?.close(); }, []);

  const togglePopout = () => {
    if (isWindowed) {
      popoutWindowRef.current?.close();
      popoutWindowRef.current = null;
      setIsWindowed(false);
      return;
    }
    // Open in the click handler (a user gesture) so popup blockers allow it.
    const w = window.open(
      '',
      'chronicle-planning',
      'width=980,height=820,menubar=no,toolbar=no,location=no',
    );
    if (!w) return; // blocked — leave the pane inline
    popoutWindowRef.current = w;
    setIsWindowed(true);
  };

  const tabs: Array<{ id: OutlineTab; label: string; icon: typeof List }> = [
    { id: 'synopsis', label: 'Outline', icon: FileText },
    { id: 'navigation', label: 'Navigation', icon: AlignLeft },
    { id: 'plot', label: 'Plot', icon: Network },
    { id: 'characters', label: 'Cast', icon: Users },
    { id: 'comments', label: 'Notes', icon: MessageSquare },
  ];

  const renderContent = () => {
    if (tab === 'synopsis') {
      return (
        <div className="flex-1 flex flex-col min-h-0 space-y-4 pt-2">
          <div className="flex-1 flex flex-col min-h-0">
            <div className="flex items-center gap-2 mb-2 px-1 text-[9px] uppercase tracking-widest font-bold opacity-30">
              <FileText className="w-3 h-3" />
              <span>Project Synopsis</span>
            </div>
            <textarea
              value={props.synopsis || ''}
              onChange={(e) => props.onUpdateSynopsis(e.target.value)}
              placeholder="Start drafting your high-level project outline here..."
              className={cn(
                "flex-1 w-full bg-black/[0.03] dark:bg-white/[0.08] rounded-xl p-4 text-xs leading-relaxed outline-none border border-black/5 dark:border-white/5 focus:border-current/20 transition-all resize-none",
                isDarkMode ? "text-white" : "text-black"
              )}
            />
          </div>

          {(props.aiOutlineMarkdown || props.isAiOutlineLoading) && (
            <div className="pt-4 border-t border-current/5">
              <AiView {...props} />
            </div>
          )}
        </div>
      );
    }
    if (tab === 'navigation') return <StructureView {...props} />;
    if (tab === 'plot') {
      return (
        <PlotCanvas
          isDarkMode={isDarkMode}
          characters={props.characters}
          nodes={props.plotNodes}
          edges={props.plotEdges}
          onAddNode={props.onAddPlotNode}
          onUpdateNode={props.onUpdatePlotNode}
          onDeleteNode={props.onDeletePlotNode}
          onAddEdge={props.onAddPlotEdge}
          onDeleteEdge={props.onDeletePlotEdge}
        />
      );
    }
    if (tab === 'characters') {
      return openCharacterId ? (
        (() => {
          const c = props.characters.find((x) => x.id === openCharacterId);
          if (!c) {
            setOpenCharacterId(null);
            return null;
          }
          return (
            <CharacterSheet
              character={c}
              isDarkMode={isDarkMode}
              onUpdate={(patch) => props.onUpdateCharacter(c.id, patch)}
              onDelete={() => {
                props.onDeleteCharacter(c.id);
                setOpenCharacterId(null);
              }}
              onBack={() => setOpenCharacterId(null)}
            />
          );
        })()
      ) : (
        <CharactersList
          characters={props.characters}
          isDarkMode={isDarkMode}
          onAdd={props.onAddCharacter}
          onOpen={setOpenCharacterId}
        />
      );
    }
    if (tab === 'comments') {
      return (
        <div className="flex-1 overflow-y-auto pr-1">
          <CommentsPanel
            isDarkMode={isDarkMode}
            editor={props.editor}
            chapters={props.chapters}
            currentChapterId={props.currentChapterId}
            onSelectChapter={props.onSelectChapter}
          />
        </div>
      );
    }
    return null;
  };

  const paneBody = (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
      <div className="flex items-center justify-between mb-3 gap-2">
        <div
          className={cn(
            'flex items-center gap-0.5 p-0.5 rounded-xl border overflow-x-auto flex-1',
            isDarkMode ? 'bg-black/10 border-white/5' : 'bg-black/[0.03] border-black/5',
          )}
        >
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[10px] uppercase tracking-wider font-bold transition-all whitespace-nowrap',
                tab === t.id
                  ? (isDarkMode ? 'bg-white/10 text-white' : 'bg-white text-black shadow-sm')
                  : 'opacity-50 hover:opacity-100',
              )}
            >
              <t.icon className="w-3 h-3" />
              {t.label}
            </button>
          ))}
        </div>

        <button
          onClick={togglePopout}
          className={cn(
            'p-2 rounded-xl border transition-all hover:scale-105 active:scale-95 shrink-0',
            isDarkMode ? 'bg-white/5 border-white/10 text-white/60 hover:text-white' : 'bg-black/5 border-black/10 text-black/60 hover:text-black',
          )}
          title={isWindowed ? 'Return to sidebar' : 'Open in a separate window'}
        >
          {isWindowed ? <PanelRightClose className="w-4 h-4" /> : <ExternalLink className="w-4 h-4" />}
        </button>
      </div>

      <div className="flex-1 flex flex-col min-h-0">
        {renderContent()}
      </div>
    </div>
  );

  // Detached into its own window: show a placeholder in the sidebar, and portal
  // the live pane into the popout (same React subtree → state stays in sync).
  if (isWindowed && popoutWindowRef.current) {
    return (
      <>
        <div className="flex flex-col flex-1 min-h-0 items-center justify-center text-center px-8 gap-4">
          <div className={cn('p-3 rounded-2xl', isDarkMode ? 'bg-white/5' : 'bg-black/5')}>
            <ExternalLink className="w-6 h-6 opacity-40" />
          </div>
          <div>
            <p className="text-xs font-bold">Planning board opened in a separate window</p>
            <p className="text-[10px] opacity-40 mt-1 leading-relaxed">
              Switch tabs and edit there — changes sync live with your manuscript.
            </p>
          </div>
          <button
            onClick={togglePopout}
            className={cn(
              'px-4 py-2 rounded-xl text-[10px] uppercase font-black tracking-widest transition-all',
              isDarkMode ? 'bg-white/10 hover:bg-white/20 text-white' : 'bg-black/5 hover:bg-black/10 text-black',
            )}
          >
            Bring back
          </button>
        </div>

        <PopoutWindow
          targetWindow={popoutWindowRef.current}
          title="Planning — Chronicle"
          isDarkMode={isDarkMode}
          onClose={() => {
            popoutWindowRef.current = null;
            setIsWindowed(false);
          }}
        >
          {paneBody}
        </PopoutWindow>
      </>
    );
  }

  return paneBody;
};

// ---------------------------------------------------------------------------
// Sub-views
// ---------------------------------------------------------------------------

const StructureView: React.FC<OutlinePaneProps> = ({ headings, onHeadingClick, isDarkMode }) => {
  if (headings.length === 0) {
    return (
      <div className="flex-1 overflow-y-auto pr-1 mt-2">
        <div className="h-40 flex flex-col items-center justify-center text-center px-8">
          <p className="text-[10px] uppercase tracking-widest font-bold opacity-20">No structure detected</p>
          <p className="text-[10px] opacity-20 mt-2">Add headers to your manuscript to see them here.</p>
        </div>
      </div>
    );
  }
  return (
    <div className="flex-1 overflow-y-auto pr-1 mt-2 space-y-1">
      {headings.map((h) => (
        <div
          key={h.id}
          onClick={() => onHeadingClick(h.text, h.level)}
          className={cn(
            'px-4 py-2 rounded-lg text-sm transition-all hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer group',
            h.level === 1 ? 'font-serif italic text-base' :
            h.level === 2 ? 'ml-4 opacity-70' :
            'ml-8 opacity-50 text-xs',
          )}
        >
          <span className={cn(isDarkMode ? 'text-white' : 'text-black group-hover:text-black')}>{h.text}</span>
        </div>
      ))}
    </div>
  );
};

const AiView: React.FC<OutlinePaneProps> = ({
  isDarkMode, aiOutlineMarkdown, isAiOutlineLoading, onClearAiOutline,
}) => (
  <div className="flex-1 overflow-y-auto pr-1 mt-2 space-y-3">
    {isAiOutlineLoading && (
      <div className="px-2 space-y-3 animate-pulse">
        <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.2em] font-bold opacity-40">
          <Sparkles className="w-3 h-3" />
          <span>Generating outline...</span>
        </div>
        <div className="space-y-2">
          <div className="h-3 bg-current/5 rounded w-3/4" />
          <div className="h-3 bg-current/5 rounded w-1/2" />
          <div className="h-3 bg-current/5 rounded w-2/3" />
        </div>
      </div>
    )}
    {!isAiOutlineLoading && aiOutlineMarkdown && (
      <>
        <div className="flex items-center justify-between px-2">
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.2em] font-bold opacity-40">
            <Sparkles className="w-3 h-3" />
            <span>AI Outline</span>
          </div>
          {onClearAiOutline && (
            <button
              onClick={onClearAiOutline}
              className="text-[9px] uppercase tracking-widest opacity-30 hover:opacity-100 transition-opacity"
              title="Clear AI outline"
            >
              Clear
            </button>
          )}
        </div>
        <div className={cn(
          'px-3 py-3 rounded-xl border text-xs leading-relaxed',
          isDarkMode ? 'bg-white/[0.02] border-white/5' : 'bg-black/[0.02] border-black/5',
        )}>
          <MarkdownRenderer
            text={aiOutlineMarkdown}
            className="font-roboto"
            theme={isDarkMode ? 'dark' : 'light'}
            compact
          />
        </div>
      </>
    )}
    {!isAiOutlineLoading && !aiOutlineMarkdown && (
      <div className="h-40 flex flex-col items-center justify-center text-center px-8">
        <p className="text-[10px] uppercase tracking-widest font-bold opacity-20">No AI outline yet</p>
        <p className="text-[10px] opacity-20 mt-2">
          Run <span className="font-mono">#!/ai_outline</span> in the editor to generate one.
        </p>
      </div>
    )}
  </div>
);

interface CharactersListProps {
  characters: Character[];
  isDarkMode: boolean;
  onAdd: () => void;
  onOpen: (id: string) => void;
}

const CharactersList: React.FC<CharactersListProps> = ({ characters, isDarkMode, onAdd, onOpen }) => (
  <div className="flex-1 overflow-y-auto pr-1 mt-2 space-y-2">
    {characters.map((c) => (
      <button
        key={c.id}
        onClick={() => onOpen(c.id)}
        className={cn(
          'w-full flex items-center gap-3 p-3 rounded-xl border text-left transition-all hover:shadow-md',
          isDarkMode ? 'border-white/5 hover:bg-white/5' : 'border-black/5 hover:bg-black/[0.02]',
        )}
      >
        <div
          className="w-10 h-10 rounded-xl shrink-0 flex items-center justify-center text-white font-serif"
          style={{ backgroundColor: c.color || DEFAULT_CHARACTER_PALETTE[0] }}
        >
          {(c.name || '?').slice(0, 1).toUpperCase()}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium truncate">{c.name || 'Unnamed character'}</p>
          {c.coreUrge && <p className="text-[10px] opacity-50 truncate italic">{c.coreUrge}</p>}
        </div>
      </button>
    ))}

    <button
      onClick={onAdd}
      className={cn(
        'w-full flex items-center justify-center gap-2 py-3 rounded-xl border-2 border-dashed transition-all hover:bg-black/5 dark:hover:bg-white/5',
        isDarkMode ? 'border-white/10 text-white/40' : 'border-black/10 text-black/40',
      )}
    >
      <span className="text-[10px] uppercase tracking-widest font-bold">+ Add Character</span>
    </button>
  </div>
);
