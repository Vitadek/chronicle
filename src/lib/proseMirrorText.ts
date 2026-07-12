// Shared helper for the decoration-based checkers (TenseShift, Grammar):
// build a textblock's plain text alongside a char-index -> document-position
// map. Inline leaf nodes (hard breaks, atoms) advance the document position
// without contributing characters, so a naive `paraStart + offset` would drift;
// this keeps span placement exact.
import type { Node as PMNode } from '@tiptap/pm/model';

export function buildPosMap(node: PMNode, paraStart: number): { text: string; posAt: number[] } {
  let text = '';
  const posAt: number[] = [];
  let pos = paraStart;
  node.forEach((child) => {
    if (child.isText) {
      const t = child.text || '';
      for (let k = 0; k < t.length; k++) {
        posAt.push(pos);
        pos++;
        text += t[k];
      }
    } else {
      pos += child.nodeSize;
    }
  });
  posAt.push(pos); // sentinel for an end offset
  return { text, posAt };
}

/**
 * Find the first occurrence of `quote` in the editor document and return its
 * span. Used to map AI-returned exact quotes back to positions (IssuesPane's
 * AI pass, ProofreadView's clarity rows).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function locateQuote(editor: any, quote: string): { from: number; to: number } | null {
  if (!quote) return null;
  let hit: { from: number; to: number } | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  editor.state.doc.descendants((node: any, pos: number) => {
    if (hit || !node.isTextblock) return hit ? false : undefined;
    const { text, posAt } = buildPosMap(node, pos + 1);
    const idx = text.indexOf(quote);
    if (idx >= 0) {
      const endIdx = Math.min(idx + quote.length, posAt.length - 1);
      hit = { from: posAt[idx], to: posAt[endIdx] };
      return false;
    }
    return undefined;
  });
  return hit;
}
