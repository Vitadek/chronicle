import React from 'react';
import { Clock, SpellCheck, CheckCircle2 } from 'lucide-react';
import { cn } from '../lib/utils';
import type { TenseShiftHit } from '../lib/TenseShift';
import type { GrammarMark } from '../lib/Grammar';

interface IssuesPaneProps {
  isDarkMode: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  editor: any | null;
  tenseHits: TenseShiftHit[];
  grammarMarks: GrammarMark[];
  tenseEnabled: boolean;
  grammarEnabled: boolean;
}

interface Row {
  from: number;
  to: number;
  source: 'tense' | 'grammar';
  kind: string;
  label: string;
  text: string;
}

/**
 * Navigable list of the live tense-shift + grammar findings. Clicking a row
 * selects the offending span in the editor and scrolls it into view. Read-only:
 * the checkers themselves own the underlines; this is just a table of contents.
 */
export const IssuesPane: React.FC<IssuesPaneProps> = ({
  isDarkMode,
  editor,
  tenseHits,
  grammarMarks,
  tenseEnabled,
  grammarEnabled,
}) => {
  const jump = (from: number, to: number) => {
    if (!editor || editor.isDestroyed) return;
    editor.chain().focus().setTextSelection({ from, to }).scrollIntoView().run();
  };

  const rows: Row[] = [
    ...tenseHits.map((h): Row => ({
      from: h.from,
      to: h.to,
      source: 'tense',
      kind: h.tense,
      label: `Tense drift — ${h.tense} in a ${h.expected}-tense paragraph`,
      text: h.text,
    })),
    ...grammarMarks.map((m): Row => ({
      from: m.from,
      to: m.to,
      source: 'grammar',
      kind: m.kind,
      label: m.message,
      text: m.text,
    })),
  ].sort((a, b) => a.from - b.from);

  const nothingEnabled = !tenseEnabled && !grammarEnabled;

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
      <div className="px-4 py-2 flex items-center justify-between text-[9px] uppercase tracking-[0.15em] font-bold opacity-30">
        <span>Issues</span>
        <span>{rows.length}</span>
      </div>

      <div className="flex-1 overflow-y-auto pr-1 mt-2 space-y-1">
        {nothingEnabled ? (
          <p className="px-4 py-6 text-xs opacity-40 leading-relaxed">
            Turn on <span className="font-semibold">Tense Check</span> or{' '}
            <span className="font-semibold">Grammar Check</span> in Settings to see findings here.
          </p>
        ) : rows.length === 0 ? (
          <div className="px-4 py-10 flex flex-col items-center gap-3 opacity-40 text-center">
            <CheckCircle2 className="w-6 h-6" />
            <p className="text-xs">No issues in this chapter.</p>
          </div>
        ) : (
          rows.map((r, i) => (
            <button
              key={`${r.source}-${r.from}-${i}`}
              onClick={() => jump(r.from, r.to)}
              className="w-full text-left px-4 py-3 rounded-xl hover:bg-black/5 dark:hover:bg-white/5 transition-all group"
            >
              <div className="flex items-start gap-3">
                {r.source === 'tense' ? (
                  <Clock className="w-3.5 h-3.5 mt-0.5 shrink-0 text-amber-500" />
                ) : (
                  <SpellCheck
                    className={cn(
                      'w-3.5 h-3.5 mt-0.5 shrink-0',
                      r.kind === 'Spelling' || r.kind === 'Typo' ? 'text-red-500' : 'text-blue-500',
                    )}
                  />
                )}
                <div className="min-w-0">
                  <p
                    className={cn(
                      'text-[13px] leading-snug truncate font-medium',
                      isDarkMode ? 'text-white/85' : 'text-black/85',
                    )}
                  >
                    “{r.text}”
                  </p>
                  <p className="text-[11px] leading-snug opacity-50 mt-0.5">{r.label}</p>
                </div>
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  );
};
