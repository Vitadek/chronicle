/**
 * A cleared chapter (or manuscript) title must stay cleared.
 *
 * The bug this pins: App coerced an empty title to the literal "Untitled
 * Chapter" ON THE WRITE PATH. That coerced string flowed back as the `title`
 * prop, and EditorView's title sync effect — which calls setContent whenever
 * the stored title differs from what's in the field — saw ''  ≠  "Untitled
 * Chapter" and re-typed the placeholder into the editor. Backspacing the last
 * character instantly refilled "Untitled Chapter", which the writer then had to
 * delete, which refilled it again: an inescapable loop.
 *
 * The fix is to store exactly what was typed (empty included) and let each
 * DISPLAY site fall back on its own. This test guards both halves:
 *
 *   A. behavioural — with a real TipTap title editor and the actual sync-effect
 *      rule, an intentionally-empty stored title does NOT refill the field
 *      (and the OLD coercing rule provably WOULD have, so the test has teeth).
 *   B. source — App's update handler must not reintroduce the coercion.
 *
 * Run: npx tsx scripts/chapterTitleClearable.test.ts
 */
import { JSDOM } from 'jsdom';
import { register } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

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

/** EditorView's title sync effect, verbatim in intent: refill only when the
 *  stored title differs from what the field currently shows. */
function runTitleSync(editor: { getText(): string; commands: { setContent(html: string): void } }, storedTitle: string) {
  const currentText = editor.getText().trim();
  const targetText = storedTitle.trim();
  if (currentText !== targetText) editor.commands.setContent(`<h1>${storedTitle}</h1>`);
}

async function main() {
  const { Editor } = await import('@tiptap/core');
  const { buildCoreExtensions } = await import('../src/lib/editorExtensions');

  const makeTitleEditor = (title: string) =>
    new Editor({
      element: dom.window.document.createElement('div'),
      extensions: buildCoreExtensions(),
      content: `<h1>${title}</h1>`,
    });

  // ── A. The fixed write path: store raw. Clearing must stick. ────────────────
  {
    const editor = makeTitleEditor('Chapter One');
    check('starts with the real title', editor.getText().trim() === 'Chapter One');

    // Writer backspaces the whole title.
    editor.commands.setContent('<h1></h1>');
    const cleared = editor.getText().trim();
    check('field is empty after clearing', cleared === '');

    // The FIXED store rule keeps it raw; parent re-renders → sync effect runs.
    const storedFixed = cleared; // no coercion
    runTitleSync(editor, storedFixed);
    check('an intentionally-empty title stays empty (no refill)', editor.getText().trim() === '');

    editor.destroy();
  }

  // ── A′. Prove the test has teeth: the OLD rule would have looped. ───────────
  {
    const editor = makeTitleEditor('Chapter One');
    editor.commands.setContent('<h1></h1>');
    const storedOld = editor.getText().trim() || 'Untitled Chapter'; // the removed coercion
    runTitleSync(editor, storedOld);
    check('the old coercion provably refilled the field', editor.getText().trim() === 'Untitled Chapter');
    editor.destroy();
  }

  // ── B. Source guard: the coercion must not come back. ───────────────────────
  const appSrc = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'App.tsx'), 'utf8');
  const handler = appSrc.match(/handleUpdateChapterContent[\s\S]*?\n  \}, \[currentChapterId\]\);/)?.[0] ?? '';
  check('the update handler exists and was located', handler.length > 0);
  check(
    'no placeholder is coerced into a stored title/author',
    !/\|\|\s*'Untitled Chapter'|\|\|\s*'Untitled Manuscript'|\|\|\s*'Uncredited Author'/.test(handler),
    'handleUpdateChapterContent is coercing an empty value again — that reopens the rename loop',
  );

  console.log(failures === 0 ? '\nall checks passed' : `\n${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
