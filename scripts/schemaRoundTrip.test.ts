/**
 * Schema round-trip guard.
 *
 * Chapter content is stored as HTML. TipTap parses it against a schema derived
 * from the registered extensions and SILENTLY DROPS anything it has no parse
 * rule for — then a view that autosaves `editor.getHTML()` writes the
 * impoverished version back over the original. No error, no warning.
 *
 * That is a data-loss bug with a very small blast radius in testing (plain prose
 * round-trips fine) and a very large one in practice (it eats exactly the
 * chapters the author has invested the most annotation in).
 *
 * This test proves two things:
 *   1. Chronicle's real schema (buildCoreExtensions) round-trips every at-risk
 *      construct losslessly.
 *   2. A bare-StarterKit schema DESTROYS them — the negative control, which is
 *      what makes (1) meaningful rather than vacuous.
 *
 * Run: npx tsx scripts/schemaRoundTrip.test.ts
 */
import { JSDOM } from 'jsdom';
import { register } from 'node:module';

// The real editor schema includes CommentMark, whose browser presentation
// imports Tippy styles. Node has no CSS module format; ignore stylesheet side
// effects while loading the real extensions under this schema-only test.
// `module.register` is available across Node 22, unlike the newer synchronous
// hook API, so the guard does not depend on a late Node 22 point release.
register('./ignoreCss.loader.mjs', import.meta.url);

// TipTap's schema/parse machinery needs a DOM before the extensions load.
const dom = new JSDOM('<!doctype html><html><body></body></html>');
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
// Node 22 exposes a built-in, getter-only `navigator`. Direct assignment now
// throws in ESM strict mode, so install jsdom's implementation by redefining
// the configurable global instead.
Object.defineProperty(globalThis, 'navigator', {
  value: dom.window.navigator,
  configurable: true,
});
(globalThis as any).DOMParser = dom.window.DOMParser;
(globalThis as any).Node = dom.window.Node;
(globalThis as any).HTMLElement = dom.window.HTMLElement;

/** A chapter carrying every construct a naive schema would eat. */
const ANNOTATED = `<p>She <span data-comment="is this too fast?">walked</span> away.</p>` +
  `<p><u>Later</u>, the <span data-audio-token="a7f3">door opened</span>.</p>` +
  `<blockquote data-type="epigraph">All that is gold does not glitter.</blockquote>`;

interface Check { name: string; present: (html: string) => boolean }
const CHECKS: Check[] = [
  { name: 'comment mark  (span[data-comment])',      present: (h) => /data-comment="is this too fast\?"/.test(h) },
  { name: 'audio mark    (span[data-audio-token])',  present: (h) => /data-audio-token="a7f3"/.test(h) },
  { name: 'underline     (<u>)',                     present: (h) => /<u>Later<\/u>/.test(h) },
  { name: 'epigraph      (blockquote[data-type])',   present: (h) => /data-type="epigraph"/.test(h) },
];

async function main() {
  // Imported AFTER the DOM globals exist above — TipTap touches document at
  // module scope.
  const { getSchema } = await import('@tiptap/core');
  const { DOMParser: PMDOMParser, DOMSerializer } = await import('@tiptap/pm/model');
  const { buildCoreExtensions } = await import('../src/lib/editorExtensions');
  const { default: StarterKit } = await import('@tiptap/starter-kit');

  /** Parse HTML into a doc under `schema`, then serialize it back — exactly what
   *  an editor does between load and autosave. */
  const roundTrip = (schema: any, html: string): string => {
    const el = dom.window.document.createElement('div');
    el.innerHTML = html;
    const doc = PMDOMParser.fromSchema(schema).parse(el);
    const out = DOMSerializer.fromSchema(schema).serializeFragment(doc.content);
    const wrap = dom.window.document.createElement('div');
    wrap.appendChild(out as any);
    return wrap.innerHTML;
  };

  let failed = false;

  // ---- 1. Chronicle's real schema must lose NOTHING -----------------------
  const coreHtml = roundTrip(getSchema(buildCoreExtensions() as any), ANNOTATED);
  console.log('Chronicle core schema (buildCoreExtensions) — must be lossless:');
  for (const c of CHECKS) {
    const ok = c.present(coreHtml);
    if (!ok) failed = true;
    console.log(`  ${ok ? 'PASS  preserved' : 'FAIL  DESTROYED'}  ${c.name}`);
  }

  // ---- 2. Negative control: bare StarterKit must destroy them -------------
  // If these ever "survive", the test above has gone vacuous and this guard is
  // worthless — so the damage is asserted explicitly.
  //
  // NOTE: underline is deliberately NOT in this list. StarterKit ships it, so
  // <u> survives a naive schema. Measured, not assumed — the first draft of this
  // test wrongly listed it and the control caught the error.
  const AT_RISK = ['comment mark', 'audio mark', 'epigraph'];
  const bareHtml = roundTrip(getSchema([StarterKit] as any), ANNOTATED);
  const shouldBeLost = CHECKS.filter((c) => AT_RISK.some((p) => c.name.startsWith(p)));
  console.log('\nNegative control — bare StarterKit (what a naive plugin would build):');
  for (const c of shouldBeLost) {
    const lost = !c.present(bareHtml);
    if (!lost) failed = true;
    console.log(`  ${lost ? 'PASS  destroyed, as expected' : 'FAIL  survived — control is broken'}  ${c.name}`);
  }
  console.log(`\n  StarterKit output: ${bareHtml}`);

  console.log(
    failed
      ? '\nRESULT: FAIL'
      : '\nRESULT: PASS — core schema is lossless, and the control proves the test bites.',
  );
  process.exit(failed ? 1 : 0);
}

void main();
