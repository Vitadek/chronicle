import React from 'react';
import { cn } from '../lib/utils';
import { ExportSettings } from '../types';

type MarkdownSettings = ExportSettings['markdown'];

interface MarkdownFrontMatterFieldsProps {
  value: MarkdownSettings;
  onChange: (patch: Partial<MarkdownSettings>) => void;
  isDarkMode: boolean;
}

/**
 * The Hugo front-matter controls (master toggle + date/draft/author/weight and
 * the series/tags/categories inputs). Shared between the Global Settings export
 * defaults and the per-export Markdown dialog so both stay in sync.
 */
export function MarkdownFrontMatterFields({ value, onChange, isDarkMode }: MarkdownFrontMatterFieldsProps) {
  const inputClass = cn(
    'w-full px-4 py-3 rounded-xl text-xs bg-black/[0.03] dark:bg-white/[0.08] border border-black/12 dark:border-white/15 focus:border-black/10 dark:focus:border-white/20 outline-none transition-all',
    isDarkMode ? 'text-white' : 'text-black',
  );

  return (
    <>
      <FmToggle
        isDarkMode={isDarkMode}
        label="Hugo front matter"
        hint="Emit a YAML front-matter block for a Hugo static site."
        checked={value.frontMatter}
        onToggle={() => onChange({ frontMatter: !value.frontMatter })}
      />

      {value.frontMatter && (
        <div className="space-y-5 pl-1 border-l-2 border-black/12 dark:border-white/15 ml-1">
          <div className="pl-4 space-y-4">
            <FmToggle
              isDarkMode={isDarkMode}
              label="date"
              hint="Export date (ISO), e.g. 2026-07-10."
              checked={value.date}
              onToggle={() => onChange({ date: !value.date })}
            />
            <FmToggle
              isDarkMode={isDarkMode}
              label="draft"
              hint="Sets draft: true so Hugo skips the page in a normal build."
              checked={value.draft}
              onToggle={() => onChange({ draft: !value.draft })}
            />
            <FmToggle
              isDarkMode={isDarkMode}
              label="author"
              checked={value.author}
              onToggle={() => onChange({ author: !value.author })}
            />
            <FmToggle
              isDarkMode={isDarkMode}
              label="weight"
              hint="Chapter position, so per-chapter pages keep reading order."
              checked={value.weight}
              onToggle={() => onChange({ weight: !value.weight })}
            />

            <div>
              <label className="block text-[10px] uppercase tracking-widest font-bold opacity-30 mb-2">Series</label>
              <input
                type="text"
                value={value.series}
                onChange={(e) => onChange({ series: e.target.value })}
                placeholder="Optional, single value"
                className={inputClass}
              />
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-widest font-bold opacity-30 mb-2">
                Tags <span className="opacity-60 lowercase tracking-normal font-normal">(comma-separated)</span>
              </label>
              <input
                type="text"
                value={value.tags}
                onChange={(e) => onChange({ tags: e.target.value })}
                placeholder="fantasy, epic, first-draft"
                className={inputClass}
              />
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-widest font-bold opacity-30 mb-2">
                Categories <span className="opacity-60 lowercase tracking-normal font-normal">(comma-separated)</span>
              </label>
              <input
                type="text"
                value={value.categories}
                onChange={(e) => onChange({ categories: e.target.value })}
                placeholder="fiction"
                className={inputClass}
              />
            </div>
          </div>
        </div>
      )}
    </>
  );
}

interface FmToggleProps {
  isDarkMode: boolean;
  label: string;
  hint?: string;
  checked: boolean;
  onToggle: () => void;
}

/** A labelled on/off switch row (matches GlobalSettings' ToggleRow style). */
function FmToggle({ isDarkMode, label, hint, checked, onToggle }: FmToggleProps) {
  return (
    <button onClick={onToggle} className="w-full flex items-center justify-between gap-4 text-left group">
      <div className="min-w-0">
        <div className={cn('text-xs font-medium', isDarkMode ? 'text-white/80' : 'text-black/80')}>{label}</div>
        {hint && <div className="text-[10px] leading-relaxed opacity-40 mt-0.5">{hint}</div>}
      </div>
      <div
        className={cn(
          'w-8 h-4 rounded-full relative shrink-0 transition-colors duration-300',
          checked ? 'bg-blue-500' : isDarkMode ? 'bg-white/20' : 'bg-black/10',
        )}
      >
        <div
          className={cn(
            'absolute top-1 w-2 h-2 rounded-full bg-white transition-all duration-300',
            checked ? 'left-5' : 'left-1',
          )}
        />
      </div>
    </button>
  );
}
