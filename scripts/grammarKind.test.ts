/**
 * The grammar proxy's classification contract (server/routes/grammar.ts).
 *
 * LanguageTool labels word-confusion hits (quiet/quite, their/there) with
 * `issueType: "misspelling"` even though the flagged word is spelled correctly.
 * Passed through, that told authors their word didn't exist and invited "add to
 * dictionary" — which would whitelist a common English word and silence the
 * rule everywhere (the dictionary filter keys on kind === 'misspelling').
 *
 * This mounts the real route against a stubbed LanguageTool and pins: confusion
 * pairs become `confusion`, genuine typos stay `misspelling`, everything else
 * keeps LT's issue type, and replacements survive in every case.
 *
 * Run: npx tsx scripts/grammarKind.test.ts
 */
import express from 'express';
import type { AddressInfo } from 'node:net';

// The route reads config at import time; give it a LanguageTool URL to call.
process.env.LANGUAGETOOL_URL = 'http://languagetool.test:8010';

interface Hit { start: number; end: number; kind: string; message: string; replacements?: string[] }

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// A LanguageTool response covering each shape we care about. The quiet/quite
// match is copied from what the real sidecar returns for
// "They were quiet a trifle longer." — issueType misspelling, category
// CONFUSED_WORDS.
const LT_RESPONSE = {
  matches: [
    {
      offset: 10,
      length: 5,
      message: 'Did you mean “quite”?',
      rule: { issueType: 'misspelling', category: { id: 'CONFUSED_WORDS' } },
      replacements: [{ value: 'quite' }],
    },
    {
      offset: 30,
      length: 5,
      message: 'Possible spelling mistake found.',
      rule: { issueType: 'misspelling', category: { id: 'TYPOS' } },
      replacements: [{ value: 'store' }, { value: 'steer' }],
    },
    {
      offset: 50,
      length: 4,
      message: 'This phrasing is wordy.',
      rule: { issueType: 'style', category: { id: 'REDUNDANCY' } },
      replacements: [],
    },
  ],
};

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init: any) => {
  if (String(input).includes('languagetool.test')) {
    return new Response(JSON.stringify(LT_RESPONSE), { status: 200 });
  }
  return realFetch(input, init);
}) as typeof fetch;

async function main() {
  const { default: grammarRouter } = await import('../server/routes/grammar');

  const app = express();
  app.use(express.json());
  app.use('/api/grammar', grammarRouter);
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const { port } = server.address() as AddressInfo;

  const res = await realFetch(`http://127.0.0.1:${port}/api/grammar/check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'They were quiet a trifle longer, then went to the stoer very fast.' }),
  });
  const { hits } = (await res.json()) as { hits: Hit[] };

  const confusion = hits[0];
  const typo = hits[1];
  const style = hits[2];

  check('confused word is NOT reported as a misspelling', confusion?.kind !== 'misspelling', confusion?.kind);
  check("confused word gets its own kind ('confusion')", confusion?.kind === 'confusion', JSON.stringify(confusion));
  check('confused word keeps its one-click fix', confusion?.replacements?.[0] === 'quite');
  check('a real typo is still a misspelling', typo?.kind === 'misspelling', JSON.stringify(typo));
  check('a real typo keeps its corrections', typo?.replacements?.length === 2);
  check("other issue types pass through (style)", style?.kind === 'style', JSON.stringify(style));
  check('offsets are preserved', confusion?.start === 10 && confusion?.end === 15);

  server.close();
  if (failures > 0) {
    console.error(`\n${failures} grammar-kind check(s) failed`);
    process.exit(1);
  }
  console.log('\nAll grammar-kind checks passed.');
}

void main();
