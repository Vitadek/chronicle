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
