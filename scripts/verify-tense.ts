// Dev-only harness for the tense-shift engine: `npx tsx scripts/verify-tense.ts`.
// Prints each paragraph's dominant tense, per-sentence classification, and the
// flagged drifts so the heuristic can be eyeballed without a browser.
import { analyzeParagraph, loadTenseEngine } from '../src/lib/tense/detect';

await loadTenseEngine();

const cases: { name: string; text: string; expectShift: boolean }[] = [
  {
    name: 'Lone present drift in a past paragraph',
    text: 'She walked to the window and looked out. The garden was quiet. She runs her hand along the cold glass. Snow had begun to fall.',
    expectShift: true,
  },
  {
    name: 'Consistent past (no shift)',
    text: 'He opened the door slowly. The hinges creaked in the dark. He stepped inside and listened. Nothing moved.',
    expectShift: false,
  },
  {
    name: 'Dialogue in present must not trip a past paragraph',
    text: 'She turned to him and frowned. "I am leaving now, and I do not care what you think," she said. He watched her go.',
    expectShift: false,
  },
  {
    name: '-ed adjective / participle is not a finite past verb',
    text: 'The forgotten door stands ajar. A tired man waits on the worn step. He knocks twice.',
    expectShift: false,
  },
  {
    name: 'Perfect tenses (had eaten / has eaten)',
    text: 'He had eaten before they arrived. The plates were cold. He had not slept in days.',
    expectShift: false,
  },
  {
    name: 'Consistent present (no shift)',
    text: 'She walks home through the rain. The streetlights flicker overhead. She hums an old tune.',
    expectShift: false,
  },
];

let failures = 0;
for (const c of cases) {
  const a = analyzeParagraph(c.text);
  const got = a.shifts.length > 0;
  const ok = got === c.expectShift;
  if (!ok) failures++;
  console.log(`\n${ok ? '✓' : '✗'} ${c.name}`);
  console.log(`   dominant=${a.dominant}  shifts=${a.shifts.length} (expected ${c.expectShift ? '>=1' : '0'})`);
  for (const s of a.sentences) {
    const flag = a.shifts.some((x) => x.start === s.start) ? '  <-- DRIFT' : '';
    console.log(`   [${s.tense.padEnd(7)}] ${s.text.trim()}${flag}`);
  }
}
console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
