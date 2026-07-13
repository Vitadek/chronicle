/**
 * Pins the TipTap v3 behavior that makes `isDestroyed` guards load-bearing:
 * `Editor.destroy()` nulls the schema and resets extension storage, so
 * `getHTML()` / `getText()` / `storage.characterCount` on a destroyed editor
 * THROW or vanish — they did not in v2, which is why call sites written then
 * carried no guards. EditorView's sync effects and word counter now guard on
 * `isDestroyed`; if a TipTap upgrade makes this test fail (destroyed editors
 * become safe again), those guards are prunable — until then they are what
 * stands between a chapter switch and a white screen.
 *
 * Run: npx tsx scripts/destroyedEditorGuard.test.ts
 */
import { JSDOM } from 'jsdom';
import { register } from 'node:module';

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

  const editor = new Editor({
    element: dom.window.document.createElement('div'),
    extensions: buildCoreExtensions(),
    content: '<p>She walked away.</p>',
  });

  check('alive: getHTML works', editor.getHTML().includes('She walked away.'));
  check('alive: characterCount storage present', typeof (editor.storage as any).characterCount?.words === 'function');

  editor.destroy();

  check('destroyed: isDestroyed reports true', editor.isDestroyed);

  let getHtmlThrew = false;
  try {
    editor.getHTML();
  } catch {
    getHtmlThrew = true;
  }
  check('destroyed: getHTML throws (schema is nulled) — guards required', getHtmlThrew);

  let getTextThrew = false;
  try {
    editor.getText();
  } catch {
    getTextThrew = true;
  }
  check('destroyed: getText throws — guards required', getTextThrew);

  check(
    'destroyed: characterCount storage gone — render must optional-chain',
    (editor.storage as any).characterCount === undefined,
  );

  if (failures > 0) {
    console.error(`\n${failures} destroyed-editor check(s) failed`);
    process.exit(1);
  }
  console.log('\nAll destroyed-editor invariants hold.');
}

void main();
