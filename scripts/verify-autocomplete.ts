/**
 * Behavioral checks for the autocomplete engine (src/lib/autocomplete).
 * Run: npx tsx scripts/verify-autocomplete.ts
 *
 * Covers the ranking contract end to end: dictionary frequency order,
 * document vocabulary and casing, bigram context, the singleton band,
 * the minimum-prefix/suffix bars, acceptance credit, determinism, and speed.
 */
import { CompletionEngine } from '../src/lib/autocomplete/engine';
import { WORDLIST } from '../src/lib/autocomplete/wordlist';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const fresh = (opts: { dict?: boolean; doc?: string } = {}) => {
  const e = new CompletionEngine();
  if (opts.dict) e.loadDictionary(WORDLIST);
  if (opts.doc) e.scanDocument(opts.doc);
  return e;
};

// ── Dictionary frequency order ───────────────────────────────────────────────
{
  const e = fresh({ dict: true });
  const s = e.suggest('th', null);
  check("'th' completes to the most frequent word, 'that'", s?.word === 'that' && s.suffix === 'at', JSON.stringify(s));
  check("'beca' → 'because'", e.suggest('beca', null)?.word === 'because');
}

// ── Minimum prefix and minimum ghost ─────────────────────────────────────────
{
  const e = fresh({ dict: true, doc: 'note notes note notes' });
  check('1-char prefix suggests nothing', e.suggest('t', null) === null);
  const s = fresh({ doc: 'note notes note notes' }).suggest('note', null);
  check('a 1-char ghost is suppressed (notes after note|)', s === null, JSON.stringify(s));
}

// ── Document vocabulary: names, casing ───────────────────────────────────────
{
  const e = fresh({ doc: 'Katherine walked in. Katherine sat by the fire.' });
  const s = e.suggest('Kath', null);
  check("repeated name: 'Kath' → 'Katherine' / ghost 'erine'", s?.word === 'Katherine' && s.suffix === 'erine', JSON.stringify(s));
}
{
  const e = fresh({ doc: 'Wind blew hard. wind howled. wind sang all night.' });
  check('sentence-start caps do not win the display form', e.suggest('wi', null)?.word === 'wind');
}

// ── Bigram context beats raw counts ──────────────────────────────────────────
{
  const doc =
    'Lady Katen spoke first. Lady Katen left early. ' +
    'Katherine arrived. Katherine slept. Katherine woke at dawn.';
  const e = fresh({ doc });
  check("no context: 'Kat' → 'Katherine' (3 uses beat 2)", e.suggest('Kat', null)?.word === 'Katherine');
  check("after 'Lady': 'Kat' → 'Katen' (bigram wins)", e.suggest('Kat', 'Lady')?.word === 'Katen');
}

// ── The singleton band: one doc use sits below the function-word core ────────
{
  const e = fresh({ dict: true, doc: 'Vexhollow rose from the mist.' });
  check("'ve' still completes to a top common word", e.suggest('ve', null)?.word === 'very');
  check("'vexh' reaches the coined name", e.suggest('vexh', null)?.word === 'Vexhollow');
  e.scanDocument('Vexhollow rose. Vexhollow fell.');
  check("used twice, 've' → 'Vexhollow' (manuscript canon)", e.suggest('ve', null)?.word === 'Vexhollow');
}

// ── Possessives credit the base word; ties break to the shorter word ─────────
{
  const e = fresh({ doc: "Katherine's sword gleamed. Katherine's shield cracked." });
  const s = e.suggest('kath', null);
  check("possessives: 'kath' → 'Katherine' (base form, shorter on tie)", s?.word === 'Katherine', JSON.stringify(s));
}

// ── Accepting a completion teaches the engine immediately ────────────────────
{
  const e = fresh();
  e.noteAccepted('said', 'Katherine');
  check('noteAccepted makes the word suggestible at once', e.suggest('kat', 'said')?.word === 'Katherine');
}

// ── Determinism ──────────────────────────────────────────────────────────────
{
  const doc = 'Every evening Katherine read. Every morning Katherine wrote.';
  const a = fresh({ dict: true, doc });
  const b = fresh({ dict: true, doc });
  const probes: Array<[string, string | null]> = [['ev', null], ['kat', 'morning'], ['re', 'katherine'], ['wr', null]];
  const runs = [a, b].map((e) => JSON.stringify(probes.map(([p, prev]) => e.suggest(p, prev))));
  check('identical inputs give identical suggestions', runs[0] === runs[1]);
}

// ── Speed: scanning is cheap, suggesting is per-keystroke cheap ──────────────
{
  const paragraph =
    'The harbor lay silver under the early light, and Katherine watched the ' +
    'boats settle against their moorings while the town woke slowly behind her. ';
  const doc = paragraph.repeat(400); // ≈ 30k words
  const e = fresh({ dict: true });

  const t0 = performance.now();
  e.scanDocument(doc);
  const scanMs = performance.now() - t0;

  const prefixes = ['th', 'kat', 'har', 'sil', 'wa', 'moor', 'be', 'slo', 'to', 'ag'];
  const t1 = performance.now();
  for (let i = 0; i < 5000; i++) e.suggest(prefixes[i % prefixes.length], 'the');
  const suggestMs = performance.now() - t1;

  console.log(`  ·   scan 30k words: ${scanMs.toFixed(1)}ms — 5000 suggests: ${suggestMs.toFixed(1)}ms`);
  check('30k-word scan under 100ms', scanMs < 100, `${scanMs.toFixed(1)}ms`);
  check('a suggestion averages under 0.1ms', suggestMs / 5000 < 0.1, `${(suggestMs / 5000).toFixed(3)}ms`);
}

if (failures > 0) {
  console.error(`\n${failures} autocomplete check(s) failed`);
  process.exit(1);
}
console.log('\nAll autocomplete checks passed.');
