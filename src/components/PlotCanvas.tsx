import React, { useCallback, useRef, useState } from 'react';
import { Plus, Trash2, MessageSquare, Link2, X, Users, GripVertical } from 'lucide-react';
import { cn } from '../lib/utils';
import { Character, PlotNode, PlotEdge } from '../types';
import { DEFAULT_CHARACTER_PALETTE } from './CharacterSheet';

interface PlotCanvasProps {
  isDarkMode: boolean;
  characters: Character[];
  nodes: PlotNode[];
  edges: PlotEdge[];
  onUpdateNode: (id: string, patch: Partial<PlotNode>) => void;
  onAddNode: (kind: 'event' | 'comment') => void;
  onDeleteNode: (id: string) => void;
  onAddEdge: (from: string, to: string) => void;
  onDeleteEdge: (id: string) => void;
}

/**
 * A pared-down, draw.io-style canvas for plotting events and characters.
 *
 * Deliberately simple:
 *   - Two node kinds: event (story beat) and comment (loose sticky).
 *   - Nodes are absolutely positioned, dragged with pointer events.
 *   - Edges drawn via an SVG overlay; create by clicking the "link" icon on
 *     a source node, then clicking a target node.
 *   - No zoom, pan, snapping, or auto-layout. Keep it readable on a phone.
 *
 * Storage: parent owns the nodes/edges arrays. This component is purely
 * a controlled view + interaction surface.
 */
export const PlotCanvas: React.FC<PlotCanvasProps> = ({
  isDarkMode,
  characters,
  nodes,
  edges,
  onUpdateNode,
  onAddNode,
  onDeleteNode,
  onAddEdge,
  onDeleteEdge,
}) => {
  const canvasRef = useRef<HTMLDivElement>(null);
  const [linkingFrom, setLinkingFrom] = useState<string | null>(null);
  const [editingNode, setEditingNode] = useState<string | null>(null);

  // Drag state lives in a ref because it changes on every pointermove and
  // would otherwise cause re-renders that interfere with native dragging.
  const dragRef = useRef<{ id: string; offsetX: number; offsetY: number } | null>(null);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent, node: PlotNode) => {
      if ((e.target as HTMLElement).closest('button, input, textarea, [data-no-drag]')) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      dragRef.current = {
        id: node.id,
        offsetX: e.clientX - rect.left - node.x,
        offsetY: e.clientY - rect.top - node.y,
      };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    },
    [],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const nextX = Math.max(0, e.clientX - rect.left - drag.offsetX);
      const nextY = Math.max(0, e.clientY - rect.top - drag.offsetY);
      onUpdateNode(drag.id, { x: nextX, y: nextY });
    },
    [onUpdateNode],
  );

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    if (dragRef.current) {
      try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* */ }
      dragRef.current = null;
    }
  }, []);

  // Linking flow: click 🔗 on source, then click any other node to connect.
  const handleNodeClick = (node: PlotNode) => {
    if (!linkingFrom) return;
    if (linkingFrom === node.id) {
      setLinkingFrom(null);
      return;
    }
    onAddEdge(linkingFrom, node.id);
    setLinkingFrom(null);
  };

  const handleCanvasClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      setEditingNode(null);
      setLinkingFrom(null);
    }
  };

  // Character lookup for showing tags inside event nodes.
  const charMap = new Map(characters.map((c) => [c.id, c]));

  return (
    <div className="flex flex-col h-full" onClick={handleCanvasClick}>
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-2 pb-3 border-b border-current/5">
        <button
          onClick={() => onAddNode('event')}
          className={cn(
            'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] uppercase tracking-widest font-bold transition-all',
            isDarkMode ? 'bg-white/5 hover:bg-white/10' : 'bg-black/5 hover:bg-black/10',
          )}
          title="Add a plot event"
        >
          <Plus className="w-3 h-3" />
          Event
        </button>
        <button
          onClick={() => onAddNode('comment')}
          className={cn(
            'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] uppercase tracking-widest font-bold transition-all',
            isDarkMode ? 'bg-white/5 hover:bg-white/10' : 'bg-black/5 hover:bg-black/10',
          )}
          title="Add a free-form comment sticky"
        >
          <MessageSquare className="w-3 h-3" />
          Note
        </button>
        {linkingFrom && (
          <div className="ml-2 flex items-center gap-2 text-[10px] opacity-60">
            <span className="italic">Click another node to connect…</span>
            <button
              onClick={() => setLinkingFrom(null)}
              className="p-1 rounded hover:bg-current/10"
              title="Cancel link"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        )}
      </div>

      {/* Canvas */}
      <div
        ref={canvasRef}
        className={cn(
          'relative flex-1 overflow-auto rounded-xl mt-3 mx-2',
          isDarkMode ? 'bg-white/[0.015]' : 'bg-black/[0.015]',
        )}
        style={{
          backgroundImage: `radial-gradient(circle at 1px 1px, ${isDarkMode ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.06)'} 1px, transparent 0)`,
          backgroundSize: '20px 20px',
        }}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        {/* Edges (SVG, behind nodes) */}
        <svg
          className="absolute inset-0 pointer-events-none"
          style={{ width: '100%', height: '100%' }}
          xmlns="http://www.w3.org/2000/svg"
        >
          <defs>
            <marker id="plotArrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill={isDarkMode ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.3)'} />
            </marker>
          </defs>
          {edges.map((edge) => {
            const a = nodes.find((n) => n.id === edge.from);
            const b = nodes.find((n) => n.id === edge.to);
            if (!a || !b) return null;
            // Nodes are roughly 200×100; anchor lines from center to center.
            const ax = a.x + 100;
            const ay = a.y + 50;
            const bx = b.x + 100;
            const by = b.y + 50;
            return (
              <g key={edge.id} className="pointer-events-auto">
                <line
                  x1={ax} y1={ay} x2={bx} y2={by}
                  stroke={isDarkMode ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.3)'}
                  strokeWidth={1.5}
                  markerEnd="url(#plotArrow)"
                />
                {/* Hit target for deleting the edge */}
                <line
                  x1={ax} y1={ay} x2={bx} y2={by}
                  stroke="transparent" strokeWidth={12}
                  style={{ cursor: 'pointer' }}
                  onClick={() => {
                    if (window.confirm('Delete this connection?')) onDeleteEdge(edge.id);
                  }}
                />
              </g>
            );
          })}
        </svg>

        {/* Nodes */}
        {nodes.map((node) => (
          <div
            key={node.id}
            onPointerDown={(e) => handlePointerDown(e, node)}
            onClick={(e) => {
              e.stopPropagation();
              handleNodeClick(node);
            }}
            className={cn(
              'absolute select-none rounded-xl shadow-md transition-shadow group/node',
              node.type === 'event'
                ? (isDarkMode ? 'bg-[#2A2927] border border-white/10' : 'bg-white border border-black/10')
                : 'bg-yellow-100/95 border border-yellow-300/60 text-yellow-950 -rotate-1',
              linkingFrom === node.id || editingNode === node.id ? 'ring-2 ring-blue-400' : 'hover:shadow-lg',
              dragRef.current?.id === node.id ? 'cursor-grabbing' : 'cursor-grab',
            )}
            style={{ left: node.x, top: node.y, width: 200, touchAction: 'none' }}
          >
            {/* Drag Handle Overlay */}
            <div className="absolute top-0 left-0 right-0 h-1.5 opacity-0 group-hover/node:opacity-20 bg-current rounded-t-xl transition-opacity pointer-events-none" />
            
            <div className="p-3 space-y-2 relative">
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  <GripVertical className="w-3.5 h-3.5 shrink-0 opacity-10 group-hover/node:opacity-40" />
                  <input
                    data-no-drag
                    type="text"
                    value={node.title}
                    onChange={(e) => onUpdateNode(node.id, { title: e.target.value })}
                    placeholder={node.type === 'event' ? 'Event title' : 'Note'}
                    className={cn(
                      'flex-1 bg-transparent text-xs font-bold outline-none border-b border-transparent focus:border-current/20 transition-colors min-w-0',
                    )}
                  />
                </div>
                <div className="flex items-center gap-1 shrink-0" data-no-drag>
                  {node.type === 'event' && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setLinkingFrom(linkingFrom === node.id ? null : node.id);
                      }}
                      className={cn(
                        'p-1 rounded hover:bg-black/10 dark:hover:bg-white/10 transition-colors',
                        linkingFrom === node.id ? 'text-blue-500' : 'opacity-60 hover:opacity-100',
                      )}
                      title="Connect to another event"
                    >
                      <Link2 className="w-3 h-3" />
                    </button>
                  )}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      if (window.confirm('Delete this node?')) onDeleteNode(node.id);
                    }}
                    className="p-1 rounded hover:bg-red-500/10 hover:text-red-500 transition-colors opacity-60 hover:opacity-100"
                    title="Delete node"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              </div>

              {(editingNode === node.id || node.description) && (
                <textarea
                  data-no-drag
                  value={node.description || ''}
                  onChange={(e) => onUpdateNode(node.id, { description: e.target.value })}
                  placeholder="Description / notes"
                  rows={2}
                  className="w-full bg-transparent text-[10px] outline-none border border-current/10 rounded p-1.5 resize-none block"
                />
              )}

              {node.type === 'event' && (
                <CharacterPicker
                  characters={characters}
                  selected={node.characterIds || []}
                  onChange={(ids) => onUpdateNode(node.id, { characterIds: ids })}
                />
              )}

              {node.type === 'event' && (node.characterIds?.length ?? 0) > 0 && (
                <div className="flex flex-wrap gap-1">
                  {(node.characterIds || []).map((cid) => {
                    const c = charMap.get(cid);
                    if (!c) return null;
                    return (
                      <span
                        key={cid}
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] font-bold"
                        style={{
                          backgroundColor: (c.color || DEFAULT_CHARACTER_PALETTE[0]) + '33',
                          color: c.color || DEFAULT_CHARACTER_PALETTE[0],
                        }}
                      >
                        <span
                          className="w-1.5 h-1.5 rounded-full"
                          style={{ backgroundColor: c.color || DEFAULT_CHARACTER_PALETTE[0] }}
                        />
                        {c.name}
                      </span>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        ))}

        {nodes.length === 0 && (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-center px-8 pointer-events-none">
            <p className="text-[10px] uppercase tracking-widest font-bold opacity-30 mb-2">Empty canvas</p>
            <p className="text-[10px] opacity-30 max-w-xs leading-relaxed">
              Add an Event to start mapping your plot. Drag nodes around to lay out beats; use the link icon to connect them.
            </p>
          </div>
        )}
      </div>
    </div>
  );
};

interface CharacterPickerProps {
  characters: Character[];
  selected: string[];
  onChange: (ids: string[]) => void;
}

const CharacterPicker: React.FC<CharacterPickerProps> = ({ characters, selected, onChange }) => {
  const [open, setOpen] = useState(false);
  if (characters.length === 0) return null;

  const toggle = (id: string) => {
    if (selected.includes(id)) onChange(selected.filter((s) => s !== id));
    else onChange([...selected, id]);
  };

  return (
    <div className="relative" data-no-drag>
      <button
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="flex items-center gap-1 text-[9px] uppercase tracking-widest font-bold opacity-50 hover:opacity-100 transition-opacity"
      >
        <Users className="w-3 h-3" />
        {selected.length > 0 ? `${selected.length} cast` : 'Add cast'}
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1 z-10 bg-current/95 backdrop-blur-md rounded-lg border border-current/10 shadow-xl py-1 min-w-[160px]">
          {characters.map((c) => (
            <button
              key={c.id}
              onClick={(e) => { e.stopPropagation(); toggle(c.id); }}
              className="flex items-center gap-2 px-3 py-1.5 hover:bg-black/5 dark:hover:bg-white/5 w-full text-left"
              style={{ color: 'white', mixBlendMode: 'difference' }}
            >
              <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: c.color || DEFAULT_CHARACTER_PALETTE[0] }} />
              <span className="text-[10px] flex-1 truncate">{c.name}</span>
              {selected.includes(c.id) && <span className="text-[10px]">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
