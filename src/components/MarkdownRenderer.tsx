import React from 'react';

/**
 * Renders the subset of markdown the AI features produce.
 *
 * Handles: ATX headings (## / ### / ####), bold, italic, inline code,
 * blockquotes, unordered lists, horizontal rules, and paragraph breaks.
 * No external dep, no dangerouslySetInnerHTML — just React elements.
 *
 * Two visual variants:
 *  - `theme: 'dark'` (default) for the editor's AI overlay
 *  - `theme: 'light'` for the sidebar Outline pane on light backgrounds
 *
 * `compact` shrinks vertical rhythm for the tight sidebar column.
 */

interface MarkdownProps {
  text: string;
  className?: string;
  theme?: 'dark' | 'light';
  compact?: boolean;
}

// ------------------------------------------------------------------
// Inline parsing: bold, italic, inline-code
// ------------------------------------------------------------------
function parseInline(raw: string, key: string, codeBg: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const pattern = /(\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = pattern.exec(raw)) !== null) {
    if (m.index > last) {
      nodes.push(raw.slice(last, m.index));
    }
    if (m[2] !== undefined) {
      nodes.push(<strong key={`${key}-b${i}`}>{m[2]}</strong>);
    } else if (m[3] !== undefined) {
      nodes.push(<em key={`${key}-i${i}`}>{m[3]}</em>);
    } else if (m[4] !== undefined) {
      nodes.push(
        <code key={`${key}-c${i}`} className={`px-1 py-0.5 rounded ${codeBg} font-mono text-[0.85em]`}>
          {m[4]}
        </code>,
      );
    }
    last = m.index + m[0].length;
    i++;
  }
  if (last < raw.length) nodes.push(raw.slice(last));
  return nodes;
}

// ------------------------------------------------------------------
// Block-level structure
// ------------------------------------------------------------------
type Block =
  | { kind: 'h2'; text: string }
  | { kind: 'h3'; text: string }
  | { kind: 'h4'; text: string }
  | { kind: 'blockquote'; lines: string[] }
  | { kind: 'ul'; items: string[] }
  | { kind: 'hr' }
  | { kind: 'p'; text: string };

function parse(markdown: string): Block[] {
  const lines = markdown.split('\n');
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      i++;
      continue;
    }

    if (/^##\s/.test(trimmed)) {
      blocks.push({ kind: 'h2', text: trimmed.replace(/^##\s+/, '') });
      i++;
      continue;
    }
    if (/^###\s/.test(trimmed)) {
      blocks.push({ kind: 'h3', text: trimmed.replace(/^###\s+/, '') });
      i++;
      continue;
    }
    if (/^####\s/.test(trimmed)) {
      blocks.push({ kind: 'h4', text: trimmed.replace(/^####\s+/, '') });
      i++;
      continue;
    }

    if (/^(---+|\*\*\*+)$/.test(trimmed)) {
      blocks.push({ kind: 'hr' });
      i++;
      continue;
    }

    if (/^>\s/.test(trimmed)) {
      const bqLines: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i].trim())) {
        bqLines.push(lines[i].trim().replace(/^>\s?/, ''));
        i++;
      }
      blocks.push({ kind: 'blockquote', lines: bqLines });
      continue;
    }

    if (/^[-*]\s/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^[-*]\s+/, ''));
        i++;
      }
      blocks.push({ kind: 'ul', items });
      continue;
    }

    const pLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^(#+\s|>\s|[-*]\s|---+|\*\*\*+)/.test(lines[i].trim())
    ) {
      pLines.push(lines[i].trim());
      i++;
    }
    if (pLines.length) {
      blocks.push({ kind: 'p', text: pLines.join(' ') });
    }
  }

  return blocks;
}

// ------------------------------------------------------------------
// Render
// ------------------------------------------------------------------
export function MarkdownRenderer({ text, className, theme = 'dark', compact = false }: MarkdownProps) {
  const blocks = parse(text || '');

  // Theme tokens. Kept here rather than in CSS so the component is fully
  // self-contained and the AI overlay can pass `theme="dark"` while the
  // sidebar Outline pane can use `theme="light"` (or whatever the user has
  // toggled) without specifying class chains.
  const isDark = theme === 'dark';
  const text90 = isDark ? 'text-[#F1EDE4]' : 'text-black';
  const text80 = isDark ? 'text-[#F1EDE4]/80' : 'text-black/80';
  const text70 = isDark ? 'text-[#F1EDE4]/70' : 'text-black/70';
  const text60 = isDark ? 'text-[#F1EDE4]/60' : 'text-black/60';
  const text50 = isDark ? 'text-[#F1EDE4]/50' : 'text-black/50';
  const text30 = isDark ? 'text-[#F1EDE4]/30' : 'text-black/30';
  const borderQuote = isDark ? 'border-white/20' : 'border-black/20';
  const borderRule = isDark ? 'border-white/10' : 'border-black/10';
  const codeBg = isDark ? 'bg-white/10' : 'bg-black/10';

  // Compact rhythm halves the vertical margins for tight columns.
  const my = compact ? 'my-2' : 'my-3';
  const mt = compact ? { h2: 'mt-3', h3: 'mt-3', h4: 'mt-2' } : { h2: 'mt-6', h3: 'mt-5', h4: 'mt-4' };
  const mb = compact ? { h2: 'mb-1', h3: 'mb-1', h4: 'mb-1' } : { h2: 'mb-2', h3: 'mb-2', h4: 'mb-1.5' };
  const ulSpace = compact ? 'space-y-1' : 'space-y-1.5';

  return (
    <div className={className}>
      {blocks.map((block, idx) => {
        const key = String(idx);
        switch (block.kind) {
          case 'h2':
            return (
              <h2 key={key} className={`text-base font-bold tracking-tight ${text90} ${mt.h2} ${mb.h2} not-italic`}>
                {parseInline(block.text, key, codeBg)}
              </h2>
            );
          case 'h3':
            return (
              <h3 key={key} className={`text-sm font-bold uppercase tracking-widest ${text70} ${mt.h3} ${mb.h3} not-italic`}>
                {parseInline(block.text, key, codeBg)}
              </h3>
            );
          case 'h4':
            return (
              <h4 key={key} className={`text-xs font-bold uppercase tracking-wider ${text50} ${mt.h4} ${mb.h4} not-italic`}>
                {parseInline(block.text, key, codeBg)}
              </h4>
            );
          case 'hr':
            return <hr key={key} className={`my-4 ${borderRule}`} />;
          case 'blockquote':
            return (
              <blockquote
                key={key}
                className={`${my} pl-4 border-l-2 ${borderQuote} ${text60} italic space-y-1`}
              >
                {block.lines.map((l, j) => (
                  <p key={j}>{parseInline(l, `${key}-${j}`, codeBg)}</p>
                ))}
              </blockquote>
            );
          case 'ul':
            return (
              <ul key={key} className={`${my} ml-1 ${ulSpace} list-none`}>
                {block.items.map((item, j) => (
                  <li key={j} className={`flex gap-2 ${text80}`}>
                    <span className={`mt-1.5 w-1 h-1 rounded-full ${isDark ? 'bg-[#F1EDE4]/30' : 'bg-black/30'} shrink-0`} />
                    <span>{parseInline(item, `${key}-${j}`, codeBg)}</span>
                  </li>
                ))}
              </ul>
            );
          case 'p':
            return (
              <p key={key} className={`${my} leading-relaxed ${text80}`}>
                {parseInline(block.text, key, codeBg)}
              </p>
            );
        }
      })}
    </div>
  );
}
