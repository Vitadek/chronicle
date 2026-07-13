/**
 * Ghost-completion behavior, driven through a REAL TipTap editor (the same
 * extension list the app mounts, via buildCoreExtensions) under jsdom — so it
 * exercises the ProseMirror plugin state, the storage contract that
 * useChronicleEditor pokes, and the Tab/Escape command paths, not just the
 * scoring engine (scripts/verify-autocomplete.ts covers that).
 *
 * Run: npx tsx scripts/autocompleteGhost.test.ts
 */
import { JSDOM } from 'jsdom';
import { register } from 'node:module';

// Same bootstrap as schemaRoundTrip.test.ts: ignore CSS imports, then stand up
// DOM globals before TipTap loads (it touches `document` at module scope).
register('./ignoreCss.loader.mjs', import.meta.url);

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
(globalThis as any).DOMParser = dom.window.DOMParser;
(globalThis as any).Node = dom.window.Node;
(globalThis as any).HTMLElement = dom.window.HTMLElement;
(globalThis as any).MutationObserver = dom.window.MutationObserver;
(globalThis as any).requestAnimationFrame = dom.window.requestAnimationFrame;
(globalThis as any).cancelAnimationFrame = dom.window.cancelAnimationFrame;
(globalThis as any).getComputedStyle = dom.window.getComputedStyle;

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function main() {
  const { Editor } = await import('@tiptap/core');
  const { buildCoreExtensions } = await import('../src/lib/editorExtensions');
  const { Autocomplete, autocompleteKey } = await import('../src/lib/Autocomplete');
  const { WORDLIST } = await import('../src/lib/autocomplete/wordlist');

  const editor = new Editor({
    element: dom.window.document.createElement('div'),
    extensions: [...buildCoreExtensions(), Autocomplete],
    content: '<p>Katherine walked in. Katherine sat down.</p>',
  });
  const storage = (editor.storage as any).autocomplete;
  // The view lazy-imports this too; loading it directly makes the test
  // deterministic instead of racing a dynamic chunk.
  storage.engine.loadDictionary(WORDLIST);

  const active = () => autocompleteKey.getState(editor.state)?.active ?? null;
  const type = (text: string) => editor.commands.insertContent(text);

  // ── Typing a known name prefix ghosts the rest ────────────────────────────
  editor.commands.setTextSelection(editor.state.doc.content.size);
  type(' Kath');
  check("typing 'Kath' offers ghost 'erine'", active()?.suffix === 'erine', JSON.stringify(active()));
  check('storage.suggestion mirrors the ghost (useChronicleEditor contract)', storage.suggestion === 'erine', storage.suggestion);

  // ── Tab accepts, document gains the word, engine is credited ──────────────
  editor.commands.completeWord();
  check('completeWord writes the full word into the document', editor.getText().endsWith('Katherine sat down. Katherine'), editor.getText());

  // ── Escape mutes exactly this prefix at this spot ─────────────────────────
  type(' Kath');
  check('ghost is back for the next occurrence', active()?.suffix === 'erine');
  editor.commands.dismissSuggestion();
  check('Escape clears the ghost', active() === null);
  type('e');
  check("typing on ('Kathe') revives it — ghost 'rine'", active()?.suffix === 'rine', JSON.stringify(active()));
  editor.commands.completeWord();

  // ── Dictionary path: frequency-ranked English, not the doc ────────────────
  type(' beca');
  check("'beca' ghosts 'use' from the ranked wordlist", active()?.suffix === 'use', JSON.stringify(active()));
  editor.commands.completeWord();

  // ── No ghost mid-word: caret inside "Katherine" ───────────────────────────
  const midWord = editor.getText().indexOf('Katherine') + 5;
  editor.commands.setTextSelection(midWord);
  check('no ghost when the caret sits inside a word', active() === null, JSON.stringify(active()));

  // ── The enabled flag (poked by useChronicleEditor) gates everything ───────
  editor.commands.setTextSelection(editor.state.doc.content.size);
  type(' Kath');
  check('ghost present before disabling', active()?.suffix === 'erine');
  storage.enabled = false;
  editor.view.dispatch(editor.state.tr); // how the hook refreshes decorations
  check('disabled: storage.suggestion empties', storage.suggestion === '');
  check('disabled: Tab (completeWord) refuses', editor.commands.completeWord() === false);
  storage.enabled = true;

  editor.destroy();

  if (failures > 0) {
    console.error(`\n${failures} ghost-behavior check(s) failed`);
    process.exit(1);
  }
  console.log('\nAll ghost-behavior checks passed.');
}

void main();
