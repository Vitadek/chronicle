import { JSDOM } from 'jsdom';
import { generateJSON, generateHTML, getSchema } from '@tiptap/core';
import { prosemirrorJSONToYDoc, yDocToProsemirrorJSON } from '@tiptap/y-tiptap';
import * as Y from 'yjs';
import { collabExtensions } from './collabSchema';

/**
 * HTML <-> Y.Doc conversion for the migration + snapshot paths.
 *
 * - htmlToYDoc: seed a chapter's Y.Doc from its stored HTML (read-only on the
 *   chapter; runs once in Hocuspocus onLoadDocument when the doc is new).
 * - yDocToHtml: render the live Y.Doc back to HTML so /api/manuscripts + export
 *   stay current (runs in onStoreDocument).
 *
 * Both directions use the shared server schema (collabSchema.ts) and the
 * TipTap Collaboration default fragment name "default".
 */

// @tiptap/core's HTML parse/serialize needs a DOM (document.implementation +
// DOMParser). Polyfill once with jsdom; @tiptap reads these at call time.
let domReady = false;
function ensureDom(): void {
  if (domReady) return;
  const g = globalThis as Record<string, unknown>;
  if (!g.document) {
    const dom = new JSDOM('');
    g.window = dom.window;
    g.document = dom.window.document;
    g.DOMParser = dom.window.DOMParser;
  }
  domReady = true;
}

const FRAGMENT = 'default';
const schema = getSchema(collabExtensions);

export function htmlToYDoc(html: string): Y.Doc {
  ensureDom();
  const json = generateJSON(html && html.trim() ? html : '<p></p>', collabExtensions);
  return prosemirrorJSONToYDoc(schema, json, FRAGMENT);
}

export function yDocToHtml(ydoc: Y.Doc): string {
  ensureDom();
  const json = yDocToProsemirrorJSON(ydoc, FRAGMENT);
  return generateHTML(json, collabExtensions);
}
